import nodemailer from 'nodemailer';
import { config, NOTIFY_EMAIL } from './config.js';
import { registraGestore } from './outbox.js';
import { formattaDataEstesa } from './orari.js';

let transporter = null;
if (config.email.enabled) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: config.email.user, pass: config.email.pass },
    pool: true,
    maxConnections: 3,
    maxMessages: 50
  });
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function guscioHtml(titolo, corpo) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#f4f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2d3d">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08)">
    <div style="background:#0d6e6e;color:#fff;padding:20px 28px">
      <h1 style="margin:0;font-size:19px;font-weight:600">${esc(titolo)}</h1>
    </div>
    <div style="padding:24px 28px;font-size:15px;line-height:1.6">${corpo}</div>
    <div style="padding:16px 28px;background:#fafbfc;border-top:1px solid #eceff1;font-size:12px;color:#7a8794">
      Studio Medico &middot; Ambulatori di Arceto e Casalgrande<br>
      Messaggio automatico, si prega di non rispondere.
    </div>
  </div></body></html>`;
}

function tabella(righe) {
  return `<table style="width:100%;border-collapse:collapse;margin:8px 0">${righe
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr>
      <td style="padding:7px 0;color:#7a8794;width:38%;vertical-align:top">${esc(k)}</td>
      <td style="padding:7px 0;font-weight:600">${esc(v)}</td></tr>`)
    .join('')}</table>`;
}

/** Registra l'email nella coda; l'invio effettivo avviene nel worker. */
export function componiEmail({ to, subject, titolo, intro, righe, chiusura }) {
  const corpo = `${intro ? `<p style="margin:0 0 12px">${intro}</p>` : ''}
    ${righe ? tabella(righe) : ''}
    ${chiusura ? `<p style="margin:14px 0 0">${chiusura}</p>` : ''}`;

  const testo = [
    intro?.replace(/<[^>]+>/g, ''),
    ...(righe || []).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`),
    chiusura?.replace(/<[^>]+>/g, '')
  ].filter(Boolean).join('\n');

  return { to, subject, html: guscioHtml(titolo || subject, corpo), text: testo };
}

registraGestore('email', async (payload) => {
  if (!transporter) {
    console.log(`[email] non configurata, simulo invio a ${payload.to}: ${payload.subject}`);
    return;
  }
  await transporter.sendMail({
    from: `"Studio Medico" <${config.email.user}>`,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html
  });
});

// ---- Modelli di messaggio -------------------------------------------------

export const emailConfermaPaziente = (p) => componiEmail({
  to: p.paziente_email,
  subject: `Prenotazione confermata — ${formattaDataEstesa(p.data)} alle ${p.ora_inizio}`,
  titolo: 'Prenotazione confermata',
  intro: `Gentile ${esc(p.paziente_nome)}, la sua visita è stata registrata correttamente.`,
  righe: [
    ['Data', formattaDataEstesa(p.data)],
    ['Orario', `${p.ora_inizio} — ${p.ora_fine}`],
    ['Ambulatorio', p.ambulatorio_nome],
    ['Indirizzo', p.ambulatorio_indirizzo],
    ['Motivo', p.problema],
    ['Codice prenotazione', p.codice]
  ],
  chiusura: `Conservi il codice <strong>${esc(p.codice)}</strong>: le serve per consultare o annullare la prenotazione. ` +
    `L'annullamento è possibile fino a ${config.cancellazioneMinutiMinimi} minuti prima dell'appuntamento.`
});

export const emailNuovaPrenotazioneAdmin = (p) => componiEmail({
  to: NOTIFY_EMAIL,
  subject: `Nuova prenotazione: ${p.paziente_nome} ${p.paziente_cognome} — ${p.data} ${p.ora_inizio}`,
  titolo: 'Nuova prenotazione',
  righe: [
    ['Paziente', `${p.paziente_nome} ${p.paziente_cognome}`],
    ['Telefono', p.paziente_telefono],
    ['Email', p.paziente_email],
    ['Data', formattaDataEstesa(p.data)],
    ['Orario', `${p.ora_inizio} — ${p.ora_fine}`],
    ['Ambulatorio', p.ambulatorio_nome],
    ['Motivo', p.problema],
    ['Codice', p.codice],
    ['Origine', p.origine]
  ]
});

export const emailAnnullamentoPaziente = (p) => componiEmail({
  to: p.paziente_email,
  subject: `Prenotazione annullata — ${formattaDataEstesa(p.data)}`,
  titolo: 'Prenotazione annullata',
  intro: `Gentile ${esc(p.paziente_nome)}, la sua prenotazione è stata annullata.`,
  righe: [
    ['Data', formattaDataEstesa(p.data)],
    ['Orario', p.ora_inizio],
    ['Ambulatorio', p.ambulatorio_nome],
    ['Annullata da', p.annullata_da === 'admin' ? 'Studio medico' : 'Paziente']
  ],
  chiusura: 'Può prenotare una nuova visita quando desidera dal nostro sito.'
});

export const emailAnnullamentoAdmin = (p) => componiEmail({
  to: NOTIFY_EMAIL,
  subject: `Annullamento: ${p.paziente_nome} ${p.paziente_cognome} — ${p.data} ${p.ora_inizio}`,
  titolo: 'Prenotazione annullata',
  righe: [
    ['Paziente', `${p.paziente_nome} ${p.paziente_cognome}`],
    ['Telefono', p.paziente_telefono],
    ['Data', formattaDataEstesa(p.data)],
    ['Orario', p.ora_inizio],
    ['Ambulatorio', p.ambulatorio_nome],
    ['Annullata da', p.annullata_da === 'admin' ? 'Studio medico' : 'Paziente']
  ]
});

export const emailPromemoriaPaziente = (p) => componiEmail({
  to: p.paziente_email,
  subject: `Promemoria: visita domani alle ${p.ora_inizio}`,
  titolo: 'Promemoria appuntamento',
  intro: `Gentile ${esc(p.paziente_nome)}, le ricordiamo la visita in programma.`,
  righe: [
    ['Data', formattaDataEstesa(p.data)],
    ['Orario', p.ora_inizio],
    ['Ambulatorio', p.ambulatorio_nome],
    ['Indirizzo', p.ambulatorio_indirizzo]
  ],
  chiusura: 'Se non può presentarsi, la preghiamo di annullare per liberare il posto.'
});

export const emailAttesaRegistrata = (v) => componiEmail({
  to: v.paziente_email,
  subject: `Sei in lista d'attesa per ${formattaDataEstesa(v.data)}`,
  titolo: "Sei in lista d'attesa",
  intro: `Gentile ${esc(v.paziente_nome)}, per ora quel giorno è al completo. ` +
    'La avviseremo per email appena si libera un posto.',
  righe: [
    ['Giorno richiesto', formattaDataEstesa(v.data)],
    ['Ambulatorio', v.ambulatorio_nome],
    ['Codice', v.codice]
  ],
  chiusura: 'L\'avviso arriva a tutti gli iscritti nello stesso momento: ' +
    'il posto resta di chi prenota per primo.'
});

export const emailPostoLibero = (v, slot) => componiEmail({
  to: v.paziente_email,
  subject: `Si è liberato un posto — ${formattaDataEstesa(v.data)} alle ${slot.ora_inizio}`,
  titolo: 'Si è liberato un posto',
  intro: `Gentile ${esc(v.paziente_nome)}, il giorno che aveva richiesto ha di nuovo un orario libero.`,
  righe: [
    ['Giorno', formattaDataEstesa(v.data)],
    ['Orario libero', slot.ora_inizio],
    ['Ambulatorio', v.ambulatorio_nome]
  ],
  chiusura: 'Prenoti dal sito appena può: il posto resta di chi lo prende per primo.'
});

export const emailRicevutaMedicinaPaziente = (r) => componiEmail({
  to: r.email,
  subject: `Richiesta medicinali ricevuta — codice ${r.codice}`,
  titolo: 'Richiesta ricevuta',
  intro: `Gentile ${esc(r.nome)}, abbiamo registrato la sua richiesta di medicinali.`,
  righe: [
    ['Medicinali', r.farmaci],
    ['Note', r.note],
    ['Codice richiesta', r.codice]
  ],
  chiusura: 'La avviseremo quando la ricetta sarà pronta per il ritiro.'
});

export const emailNuovaMedicinaAdmin = (r) => componiEmail({
  to: NOTIFY_EMAIL,
  subject: `Richiesta medicinali: ${r.nome} ${r.cognome}`,
  titolo: 'Nuova richiesta di medicinali',
  righe: [
    ['Paziente', `${r.nome} ${r.cognome}`],
    ['Telefono', r.telefono],
    ['Email', r.email],
    ['Medicinali', r.farmaci],
    ['Note', r.note],
    ['Codice', r.codice],
    ['Origine', r.origine]
  ]
});

export const emailMedicinaPronta = (r) => componiEmail({
  to: r.email,
  subject: `Ricetta pronta per il ritiro — codice ${r.codice}`,
  titolo: 'Ricetta pronta',
  intro: `Gentile ${esc(r.nome)}, la sua ricetta è pronta per il ritiro.`,
  righe: [['Medicinali', r.farmaci], ['Codice richiesta', r.codice]]
});

export async function verificaConnessioneEmail() {
  if (!transporter) return { ok: false, motivo: 'credenziali email non configurate in .env' };
  try {
    await transporter.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
}
