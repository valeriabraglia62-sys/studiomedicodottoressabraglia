import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { config, NOTIFY_EMAIL } from './config.js';
import { registraGestore, impostaAvvisoDifficolta } from './outbox.js';
import { formattaDataEstesa } from './orari.js';
import { linkGoogleCalendar } from './evento.js';

let transporter = null;
if (config.email.enabled) {
  const comune = {
    auth: { user: config.email.user, pass: config.email.pass },
    pool: true,
    maxConnections: 3,
    maxMessages: 50
  };
  transporter = nodemailer.createTransport(config.email.host
    ? { host: config.email.host, port: config.email.port, secure: config.email.secure, ...comune }
    : { service: 'gmail', ...comune });
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
      ${esc(config.nomeStudio)} &middot; Ambulatori di Arceto e Casalgrande<br>
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

/** Pulsante ben visibile; nel testo semplice diventa l'indirizzo per esteso. */
function bottone({ testo, url }) {
  return `<p style="margin:18px 0 4px">
    <a href="${esc(url)}" style="display:inline-block;background:#0d6e6e;color:#fff;
      text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600;font-size:15px">
      ${esc(testo)}</a></p>`;
}

/** Registra l'email nella coda; l'invio effettivo avviene nel worker. */
export function componiEmail({ to, subject, titolo, intro, righe, azione, chiusura }) {
  const corpo = `${intro ? `<p style="margin:0 0 12px">${intro}</p>` : ''}
    ${righe ? tabella(righe) : ''}
    ${azione?.url ? bottone(azione) : ''}
    ${chiusura ? `<p style="margin:14px 0 0">${chiusura}</p>` : ''}`;

  const testo = [
    intro?.replace(/<[^>]+>/g, ''),
    ...(righe || []).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`),
    // Senza formattazione il pulsante sparirebbe: qui l'indirizzo resta leggibile.
    azione?.url ? `\n${azione.testo}:\n${azione.url}` : '',
    chiusura?.replace(/<[^>]+>/g, '')
  ].filter(Boolean).join('\n');

  return { to, subject, html: guscioHtml(titolo || subject, corpo), text: testo };
}

/**
 * Come si recuperano gli allegati di una richiesta.
 *
 * Lo passa medicine.js, che e' il modulo padrone di quella tabella, invece di
 * essere importato da qui: medicine.js importa gia' questo file per comporre i
 * messaggi, e importarlo all'indietro chiuderebbe il giro.
 */
let leggiAllegati = null;
export function impostaLettoreAllegati(fn) {
  leggiAllegati = fn;
}

/**
 * I file da attaccare a questa email, letti adesso.
 *
 * Adesso e non quando l'email e' stata messa in coda: la foto della prescrizione
 * arriva sempre qualche secondo dopo la richiesta, perche' prima deve esistere
 * la richiesta a cui attaccarla. Portandosi dietro solo il numero della
 * richiesta, l'email raccoglie quello che c'e' nel momento in cui parte — e la
 * coda resta leggera, invece di tenere dieci megabyte di foto dentro una riga
 * di database.
 */
export function allegatiPerEmail(payload) {
  if (!payload?.allegatiDi || !leggiAllegati) return [];
  return leggiAllegati(payload.allegatiDi).map((a) => ({
    filename: a.nome,
    content: a.contenuto,
    contentType: a.tipo_mime || 'application/octet-stream'
  }));
}

registraGestore('email', async (payload) => {
  const allegati = allegatiPerEmail(payload);

  if (!transporter) {
    console.log(`[email] trasporto non configurato; evento ${crypto.randomUUID()}`);
    return;
  }
  await transporter.sendMail({
    from: `"${config.nomeStudio}" <${config.email.from}>`,
    // Le email dicono "non rispondere", ma se un paziente risponde lo stesso
    // la risposta deve arrivare dove qualcuno la legge, non nel vuoto.
    replyTo: NOTIFY_EMAIL || config.email.from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    attachments: allegati
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
  azione: { testo: 'Aggiungi al mio Google Calendar', url: linkGoogleCalendar(p) },
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

/**
 * Le visite chieste dal sito o dal chatbot nascono come richieste: lo studio
 * deve ancora confermarle. Queste tre email accompagnano quel giro — la
 * ricevuta al paziente, l'avviso allo studio, l'eventuale no.
 *
 * La conferma vera, quando arriva, e' la stessa emailConfermaPaziente di
 * sempre: a quel punto la visita e' in agenda come tutte le altre.
 */
export const emailRichiestaVisitaRicevutaPaziente = (p) => componiEmail({
  to: p.paziente_email,
  subject: `Richiesta di visita ricevuta — ${formattaDataEstesa(p.data)} alle ${p.ora_inizio}`,
  titolo: 'Richiesta ricevuta',
  intro: `Gentile ${esc(p.paziente_nome)}, abbiamo ricevuto la sua richiesta di visita. ` +
    'Non è ancora confermata: le arriverà una seconda email appena lo studio la conferma.',
  righe: [
    ['Giorno richiesto', formattaDataEstesa(p.data)],
    ['Orario richiesto', `${p.ora_inizio} — ${p.ora_fine}`],
    ['Ambulatorio', p.ambulatorio_nome],
    ['Indirizzo', p.ambulatorio_indirizzo],
    ['Motivo', p.problema],
    ['Codice richiesta', p.codice]
  ],
  chiusura: `Conservi il codice <strong>${esc(p.codice)}</strong>: le serve per controllare o ritirare la richiesta. ` +
    'Fino alla conferma quell\'orario resta suo, ma la visita non è ancora in agenda.'
});

export const emailRichiestaVisitaDaConfermareAdmin = (p) => componiEmail({
  to: NOTIFY_EMAIL,
  subject: `Da confermare: ${p.paziente_nome} ${p.paziente_cognome} — ${p.data} ${p.ora_inizio}`,
  titolo: 'Nuova richiesta di visita da confermare',
  intro: 'È arrivata una richiesta di visita dal sito. Va confermata o rifiutata dal pannello, ' +
    'in "Prenotazioni".',
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

export const emailRichiestaVisitaConfermataConModifiche = (p) => componiEmail({
  to: p.paziente_email,
  subject: `Visita confermata — ${formattaDataEstesa(p.data)} alle ${p.ora_inizio}`,
  titolo: 'Visita confermata con una modifica',
  intro: `Gentile ${esc(p.paziente_nome)}, la sua richiesta è stata confermata dallo studio, ` +
    'con una modifica rispetto a quanto aveva chiesto. Qui sotto il giorno e l\'ora definitivi.',
  righe: [
    ['Aveva chiesto', `${formattaDataEstesa(p.data_precedente)} alle ${p.ora_precedente}` +
      (p.ambulatorio_precedente && p.ambulatorio_precedente !== p.ambulatorio_nome
        ? ` — ${p.ambulatorio_precedente}` : '')],
    ['Confermata per', `${formattaDataEstesa(p.data)} alle ${p.ora_inizio}`],
    ['Ambulatorio', p.ambulatorio_nome],
    ['Indirizzo', p.ambulatorio_indirizzo],
    ['Motivo', p.problema],
    ['Codice prenotazione', p.codice]
  ],
  azione: { testo: 'Aggiungi al mio Google Calendar', url: linkGoogleCalendar(p) },
  chiusura: `Conservi il codice <strong>${esc(p.codice)}</strong>: le serve per consultare o annullare la visita. ` +
    'Se il nuovo orario non le va bene ci telefoni: troviamo un\'alternativa.'
});

export const emailRichiestaVisitaRifiutataPaziente = (p) => componiEmail({
  to: p.paziente_email,
  subject: `Richiesta di visita non accolta — ${formattaDataEstesa(p.data)}`,
  titolo: 'Richiesta non accolta',
  intro: `Gentile ${esc(p.paziente_nome)}, purtroppo la sua richiesta di visita per ` +
    `${formattaDataEstesa(p.data)} alle ${p.ora_inizio} non può essere accolta.`,
  righe: [
    ['Giorno richiesto', formattaDataEstesa(p.data)],
    ['Orario richiesto', p.ora_inizio],
    ['Ambulatorio', p.ambulatorio_nome],
    ['Motivo', p.motivo_rifiuto]
  ],
  chiusura: 'Può richiedere un altro giorno o orario dal nostro sito, oppure ci telefoni ' +
    `allo ${esc(p.ambulatorio_telefono)} per trovare un'alternativa.`
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

/**
 * Qualcuno ha prenotato con l'email di una scheda gia' in archivio, ma con
 * nome, cognome o telefono diversi da quelli scritti li'.
 *
 * Il programma non tocca la scheda e manda qui la discordanza, perche' le due
 * spiegazioni possibili vogliono risposte opposte e sceglierne una da soli
 * sarebbe un azzardo. Se il paziente ha cambiato numero, la scheda va
 * aggiornata. Se invece ha sbagliato a scrivere l'indirizzo e ha preso quello
 * di un altro, aggiornarla vorrebbe dire cancellare l'identita' di una persona
 * e metterci quella di un'altra, dentro un archivio sanitario.
 */
export const emailAnagraficaDiscordante = ({ scheda, arrivato, contesto }) => componiEmail({
  to: NOTIFY_EMAIL,
  subject: `Da controllare: dati diversi da quelli in archivio — ${arrivato.nome} ${arrivato.cognome}`,
  titolo: 'I dati non coincidono con la scheda',
  righe: [
    ['Arrivato da', contesto],
    ['Email usata', scheda.email],
    ['In archivio', `${scheda.nome} ${scheda.cognome} — ${scheda.telefono || 'nessun telefono'}`],
    ['Arrivato adesso', `${arrivato.nome} ${arrivato.cognome} — ${arrivato.telefono || 'nessun telefono'}`]
  ],
  chiusura: 'La scheda del paziente <strong>non e\' stata modificata</strong>. ' +
    'Se e\' la stessa persona che ha cambiato recapito, aggiornatela voi. ' +
    'Se invece sono due persone diverse e l\'indirizzo e\' stato scritto male, ' +
    'la prenotazione e\' finita sulla scheda sbagliata e va spostata.'
});

/**
 * Un istante scritto come lo direbbe una persona: "ieri alle 23:40" non si puo'
 * fare in una email che si legge chissa' quando, ma "10/08/2026 alle 23:40" si'.
 * Ora italiana, perche' chi legge sta a Reggio Emilia e non a Greenwich.
 */
function momentoLeggibile(istante) {
  const d = new Date(istante);
  if (Number.isNaN(d.getTime())) return String(istante);
  return d.toLocaleString('it-IT', {
    timeZone: 'Europe/Rome',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

/** "6 ore e 20 minuti" si legge, "380 minuti" bisogna calcolarlo. */
function durataLeggibile(minuti) {
  if (minuti < 60) return `${minuti} minuti`;
  const ore = Math.floor(minuti / 60);
  const resto = minuti % 60;
  const parteOre = ore === 1 ? 'un\'ora' : `${ore} ore`;
  return resto ? `${parteOre} e ${resto} minuti` : parteOre;
}

/**
 * Il sito e' stato irraggiungibile e adesso e' tornato.
 *
 * Si manda al ritorno e non durante, per il motivo piu' banale: mentre e' giu'
 * il programma non gira e non puo' mandare niente. Serve a non far passare
 * inosservata un'interruzione notturna: se i pazienti hanno trovato la pagina
 * chiusa per ore, qualcuno deve saperlo.
 */
export const emailSitoTornato = ({ spentoDa, tornatoIl, minuti }) => componiEmail({
  to: NOTIFY_EMAIL,
  subject: `Il sito e' rimasto spento per ${durataLeggibile(minuti)}`,
  titolo: 'Il sito era irraggiungibile',
  intro: 'Il programma si e\' riacceso adesso e si e\' accorto di essere stato fermo. ' +
    'In quelle ore chi provava a prenotare dal sito non ci riusciva.',
  righe: [
    ['Ultimo segno di vita', momentoLeggibile(spentoDa)],
    ['Tornato attivo', momentoLeggibile(tornatoIl)],
    ['Quanto e\' durata', durataLeggibile(minuti)]
  ],
  chiusura: 'Le notifiche rimaste in sospeso durante l\'interruzione sono ripartite da sole.'
});

/**
 * Una notifica a un paziente continua a non partire.
 *
 * Senza questo avviso il guasto e' invisibile: la riga resta in coda e riprova
 * in silenzio, il paziente non sa che la sua ricetta e' pronta, e lo studio non
 * sa che il paziente non lo sa. Se ne accorgerebbe solo quando lui telefona
 * arrabbiato, o peggio quando non telefona affatto.
 */
export const emailConsegnaInDifficolta = ({ tipo, tentativi, errore, destinatario }) => componiEmail({
  to: NOTIFY_EMAIL,
  subject: 'Una notifica non riesce a partire',
  titolo: 'Una notifica non riesce a partire',
  intro: 'Il programma ci sta riprovando da solo e continuera' + '\' a farlo, ' +
    'ma intanto il destinatario non ha ricevuto niente.',
  righe: [
    ['Tipo di notifica', tipo],
    ['A chi doveva andare', destinatario || 'non indicato'],
    ['Tentativi finora', String(tentativi)],
    ['Errore', errore]
  ],
  chiusura: 'Se e\' una conferma o un annullamento, conviene avvisare la persona ' +
    'per telefono senza aspettare. Lo stato della coda sta in "Stato del sistema".'
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
    // Questa email la legge solo lo studio, quindi qui puo' starci il nome di
    // chi ha annullato. Nell'email al paziente resta il lato e basta: a lui
    // interessa sapere se e' stato lo studio, non quale collaboratore.
    ['Annullata da', p.annullata_utente
      || (p.annullata_da === 'admin' ? 'Studio medico' : 'Paziente')]
  ]
});

/**
 * L'appuntamento e' stato spostato dallo studio.
 *
 * Il vecchio e il nuovo appuntamento stanno uno sotto l'altro: e' l'unico modo
 * perche' il paziente capisca al volo che non deve presentarsi quando aveva
 * segnato. Il codice non cambia, e va detto: altrimenti cerca una prenotazione
 * nuova che non esiste.
 */
export const emailPrenotazioneRiprogrammata = (p) => componiEmail({
  to: p.paziente_email,
  subject: `Appuntamento spostato al ${formattaDataEstesa(p.data)} — ${p.ora_inizio}`,
  titolo: 'Appuntamento spostato',
  intro: `Gentile ${esc(p.paziente_nome)}, il suo appuntamento è stato spostato. ` +
    'Trova qui sotto il vecchio e il nuovo orario.',
  righe: [
    ['Prima era', `${formattaDataEstesa(p.data_precedente)} alle ${p.ora_precedente}` +
      (p.ambulatorio_precedente && p.ambulatorio_precedente !== p.ambulatorio_nome
        ? ` — ${p.ambulatorio_precedente}` : '')],
    ['Adesso è', `${formattaDataEstesa(p.data)} alle ${p.ora_inizio}`],
    ['Ambulatorio', p.ambulatorio_nome],
    ['Indirizzo', p.ambulatorio_indirizzo],
    ['Motivo', p.problema],
    ['Codice prenotazione', p.codice]
  ],
  azione: { testo: 'Aggiungi al mio Google Calendar', url: linkGoogleCalendar(p) },
  chiusura: `Il codice <strong>${esc(p.codice)}</strong> resta lo stesso. ` +
    'Se il nuovo orario non le va bene ci telefoni: troviamo un\'alternativa.'
});

export const emailPrenotazioneRiprogrammataAdmin = (p) => componiEmail({
  to: NOTIFY_EMAIL,
  subject: `Spostata: ${p.paziente_nome} ${p.paziente_cognome} — ${p.data} ${p.ora_inizio}`,
  titolo: 'Prenotazione spostata',
  righe: [
    ['Paziente', `${p.paziente_nome} ${p.paziente_cognome}`],
    ['Telefono', p.paziente_telefono],
    ['Prima era', `${formattaDataEstesa(p.data_precedente)} alle ${p.ora_precedente}`],
    ['Adesso è', `${formattaDataEstesa(p.data)} alle ${p.ora_inizio}`],
    ['Ambulatorio', p.ambulatorio_nome],
    ['Codice', p.codice],
    ['Spostata da', p.riprogrammata_da]
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
  azione: { testo: 'Aggiungi al mio Google Calendar', url: linkGoogleCalendar(p) },
  chiusura: 'Se non può presentarsi, la preghiamo di annullare per liberare il posto.'
});

export const emailVerificaPaziente = ({ to, nome, url }) => componiEmail({
  to,
  subject: 'Conferma il tuo indirizzo email',
  titolo: 'Conferma il tuo indirizzo email',
  intro: `Gentile ${esc(nome || '')}, per completare la registrazione e poter prenotare ` +
    'o consultare le tue richieste, conferma che questo indirizzo è tuo.',
  righe: [['Validità del link', '24 ore']],
  azione: { testo: 'Conferma il mio indirizzo', url },
  chiusura: 'Se non hai richiesto tu la registrazione, ignora questo messaggio: ' +
    'senza la conferma l\'account resta inattivo e non è collegato ad alcun dato.'
});

export const emailRegistrazioneEsistente = ({ to, nome }) => componiEmail({
  to,
  subject: 'Tentativo di registrazione con la tua email',
  titolo: 'Hai già un account',
  intro: `Gentile ${esc(nome || '')}, qualcuno ha provato a registrarsi sul sito ` +
    'con questo indirizzo, che però ha già un account.',
  chiusura: 'Se sei stato tu, accedi con la tua password: non serve registrarsi di nuovo. ' +
    'Se hai dimenticato la password usa "Password dimenticata?" dalla pagina di accesso. ' +
    'Se non sei stato tu, puoi ignorare questo messaggio.'
});

/**
 * "Non ricordo l'email": la risposta al telefono che l'ha chiesta. Arriva
 * solo qui, nella casella vera — mai mostrata sullo schermo di chi l'ha
 * chiesta, altrimenti basterebbe sapere il numero di qualcuno per scoprire il
 * suo indirizzo.
 */
export const emailPromemoriaIndirizzo = ({ to, nome }) => componiEmail({
  to,
  subject: 'Il tuo indirizzo per accedere al sito',
  titolo: 'Il tuo indirizzo di accesso',
  intro: `Gentile ${esc(nome || '')}, hai chiesto un promemoria dell'indirizzo con cui accedi ` +
    `al sito. È questo: ${esc(to)}.`,
  chiusura: 'Se non sei stato tu a chiederlo, ignora questo messaggio: il tuo account resta invariato.'
});

export const emailIndirizzoCambiato = ({ to, nuovo }) => componiEmail({
  to,
  subject: 'Il tuo indirizzo di accesso è stato cambiato',
  titolo: 'Indirizzo di accesso cambiato',
  intro: `L'email con cui accedi al sito è stata cambiata in ${esc(nuovo)}. ` +
    'Da ora usa quella per entrare.',
  chiusura: 'Se non sei stato tu a farlo, contatta subito lo studio: qualcuno ' +
    'potrebbe aver avuto accesso al tuo account.'
});

/**
 * "Password dimenticata": arriva a chi la chiede, sempre — se l'indirizzo non
 * corrisponde a un account, semplicemente non parte, e chi ha chiesto vede la
 * stessa risposta di chi ce l'ha. Il link vale 2 ore, non 24: chi lo chiede e'
 * fuori dal proprio account adesso, non sta aspettando comodo.
 */
export const emailResetPasswordPaziente = ({ to, nome, url }) => componiEmail({
  to,
  subject: 'Reimposta la tua password',
  titolo: 'Reimposta la tua password',
  intro: `Gentile ${esc(nome || '')}, qualcuno ha chiesto di reimpostare la password di questo account.`,
  righe: [['Validità del link', '2 ore']],
  azione: { testo: 'Scegli una nuova password', url },
  chiusura: 'Se non sei stato tu, ignora questo messaggio: la tua password resta quella di sempre.'
});

/**
 * Lo studio ha generato una password provvisoria per un paziente che non
 * riusciva ad accedere — la stessa procedura di chi lavora nello studio, solo
 * che qui la password parte per email invece che essere consegnata a voce.
 */
export const emailPasswordPazienteRipristinata = ({ to, nome, passwordProvvisoria }) => componiEmail({
  to,
  subject: 'La tua password è stata reimpostata',
  titolo: 'Nuova password provvisoria',
  intro: `Gentile ${esc(nome || '')}, lo studio ha reimpostato la password del tuo account su tua richiesta.`,
  righe: [['Password provvisoria', passwordProvvisoria]],
  chiusura: 'Accedi con questa password, poi cambiala subito da "Modifica account" con una che ricordi solo tu. ' +
    'Se non hai chiesto tu questo cambio, contatta subito lo studio.'
});

/**
 * Lo studio ha corretto nome, cognome o telefono dalla scheda del paziente.
 * L'email che cambia ha gia' la sua: qui basta un avviso, non serve altro da
 * confermare — non e' una credenziale, e' un'anagrafica.
 */
export const emailDatiPazienteAggiornatiDalloStudio = ({ to, nome }) => componiEmail({
  to,
  subject: 'I tuoi dati sono stati aggiornati',
  titolo: 'Dati aggiornati',
  intro: `Gentile ${esc(nome || '')}, lo studio ha aggiornato i tuoi dati anagrafici ` +
    '(nome, cognome o telefono) sulla tua scheda.',
  chiusura: 'Se qualcosa non ti risulta corretto, contatta lo studio.'
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

/**
 * Come si chiama, nell'email, quello che il paziente ha chiesto.
 *
 * Serve perche' le stesse cinque email valgono per tutti e tre i tipi: una sola
 * versione scritta in "medicinalese" direbbe a chi ha chiesto gli esami del
 * sangue di passare in farmacia a ritirare la ricetta. Il paziente ci andrebbe,
 * e non troverebbe niente.
 *
 * Le parole sono ricopiate da TIPI in medicine.js invece che importate: questo
 * file compone testi e basta, e farlo dipendere del modulo che a sua volta lo
 * importa per comporre chiuderebbe il giro.
 */
const PAROLE_TIPO = {
  medicina: {
    corta: 'medicinali',
    titoloAdmin: 'Nuova richiesta di medicinali',
    riga: 'Medicinali',
    documento: 'ricetta',
    etichettaNumero: 'Numero della ricetta',
    quandoPronta: 'La avviseremo quando la ricetta sarà pronta per il ritiro.',
    dovePronta: 'In farmacia: la ricetta e\' gia\' stata inviata',
    conNumero: 'In farmacia le basta il numero della ricetta qui sopra.'
  },
  specialistica: {
    corta: 'visita specialistica',
    titoloAdmin: 'Nuova richiesta di visita specialistica',
    riga: 'Visita richiesta',
    documento: 'impegnativa',
    etichettaNumero: 'Numero dell\'impegnativa',
    quandoPronta: 'La avviseremo quando l\'impegnativa sarà pronta.',
    dovePronta: 'L\'impegnativa e\' gia\' stata inviata: puo\' prenotare la visita',
    conNumero: 'Per prenotare al CUP le basta il numero qui sopra.'
  },
  esami: {
    corta: 'esami del sangue',
    titoloAdmin: 'Nuova richiesta di esami del sangue',
    riga: 'Esami richiesti',
    documento: 'impegnativa',
    etichettaNumero: 'Numero dell\'impegnativa',
    quandoPronta: 'La avviseremo quando l\'impegnativa sarà pronta.',
    dovePronta: 'L\'impegnativa e\' gia\' stata inviata: puo\' presentarsi al prelievo',
    conNumero: 'Al laboratorio le basta il numero qui sopra.'
  }
};
const paroleDi = (r) => PAROLE_TIPO[r?.tipo] || PAROLE_TIPO.medicina;

export const emailRicevutaMedicinaPaziente = (r) => componiEmail({
  to: r.email,
  subject: `Richiesta ${paroleDi(r).corta} ricevuta — codice ${r.codice}`,
  titolo: 'Richiesta ricevuta',
  intro: `Gentile ${esc(r.nome)}, abbiamo registrato la sua richiesta di ${paroleDi(r).corta}.`,
  righe: [
    [paroleDi(r).riga, r.farmaci],
    ['Note', r.note],
    ['Codice richiesta', r.codice]
  ],
  chiusura: paroleDi(r).quandoPronta
});

export const emailNuovaMedicinaAdmin = (r) => componiEmail({
  to: NOTIFY_EMAIL,
  subject: `Richiesta ${paroleDi(r).corta}: ${r.nome} ${r.cognome}`,
  titolo: paroleDi(r).titoloAdmin,
  righe: [
    ['Paziente', `${r.nome} ${r.cognome}`],
    ['Telefono', r.telefono],
    ['Email', r.email],
    [paroleDi(r).riga, r.farmaci],
    ['Note', r.note],
    ['Codice', r.codice],
    ['Origine', r.origine]
  ],
  chiusura: 'Se il paziente ha allegato la prescrizione, la trovi in fondo a questo messaggio.'
});

/**
 * La foto arrivata dopo che l'avviso era gia' partito.
 *
 * Succede a chi si perde a cercare il documento o a rifare la foto storta: la
 * richiesta era gia' finita in casella senza niente attaccato. Mandare un
 * secondo messaggio e' l'unico modo perche' quella prescrizione si veda in
 * Gmail invece di restare solo dentro il pannello, dove nessuno la va a
 * cercare non sapendo che c'e'.
 */
export const emailAllegatoTardivo = (r) => componiEmail({
  to: NOTIFY_EMAIL,
  subject: `Allegato per la richiesta ${r.codice} — ${r.nome} ${r.cognome}`,
  titolo: 'È arrivata la prescrizione',
  intro: 'Il paziente ha caricato la prescrizione dopo l\'avviso di poco fa. La trovi qui allegata.',
  righe: [
    ['Paziente', `${r.nome} ${r.cognome}`],
    [paroleDi(r).riga, r.farmaci],
    ['Codice', r.codice]
  ]
});

/**
 * Le tre risposte a una richiesta.
 *
 * Sono le uniche email che il paziente riceve dopo aver chiesto una ricetta,
 * quindi devono bastare da sole: chi le legge non ha davanti il sito ne'
 * ricorda a memoria che cosa aveva scritto. Per questo ripetono sempre
 * l'elenco dei medicinali invece di rimandare al codice.
 */

/**
 * Dove va a ritirare il paziente.
 *
 * La risposta normale e' la farmacia, e per quello l'ambulatorio non e' scritto
 * da nessuna parte: la ricetta ci arriva e basta. Il nome di un ambulatorio
 * compare solo quando lo studio lo ha indicato apposta, per un caso
 * particolare. Senza questa funzione, nella riga dell'email resterebbe il vuoto
 * proprio dove il paziente cerca l'unica informazione che gli serve.
 */
const doveRitirare = (r) => (r.ambulatorio_nome
  ? `${r.ambulatorio_nome} — glielo abbiamo messo da parte li'`
  : paroleDi(r).dovePronta);

export const emailMedicinaConfermata = (r) => componiEmail({
  to: r.email,
  subject: `${paroleDi(r).documento[0].toUpperCase()}${paroleDi(r).documento.slice(1)} pronta — codice ${r.codice}`,
  titolo: 'Richiesta confermata',
  intro: `Gentile ${esc(r.nome)}, la sua richiesta è stata approvata dal medico.`,
  righe: [
    [paroleDi(r).riga, r.farmaci],
    ['Come procedere', doveRitirare(r)],
    // Il numero della ricetta elettronica sta prima del codice nostro apposta:
    // il nostro serve a noi, questo serve a lui, ed e' quello che gli chiedono
    // al banco della farmacia o allo sportello.
    [paroleDi(r).etichettaNumero, r.numero_ricetta || null],
    ['Codice richiesta', r.codice]
  ],
  chiusura: r.numero_ricetta
    ? `${paroleDi(r).conNumero} Se qualcosa non le torna, ci contatti prima di muoversi.`
    : 'Se qualcosa non le torna, ci contatti prima di muoversi.'
});

export const emailMedicinaRifiutata = (r) => componiEmail({
  to: r.email,
  subject: `Richiesta ${paroleDi(r).corta} non accolta — codice ${r.codice}`,
  titolo: 'Richiesta non accolta',
  intro: `Gentile ${esc(r.nome)}, purtroppo la sua richiesta di ${paroleDi(r).corta} non può essere accolta.`,
  righe: [
    [paroleDi(r).riga, r.farmaci],
    // Senza il perche' il paziente richiama per forza, e la telefonata la
    // riceve lo studio: scriverlo qui fa risparmiare tempo a tutti e due.
    ['Motivo', r.motivo_rifiuto],
    ['Codice richiesta', r.codice]
  ],
  chiusura: 'Per capire come procedere ci telefoni pure, oppure fissi una visita.'
});

/**
 * La richiesta e' stata accolta ma cambiata dopo una telefonata.
 *
 * Il paziente ha gia' parlato con lo studio, quindi questa email non porta la
 * notizia: la mette per iscritto. Il prima e il dopo stanno uno sotto l'altro
 * apposta, perche' a distanza di giorni nessuno ricorda i dettagli di una
 * telefonata e l'unica cosa che conta e' cosa andra' a ritirare.
 */
export const emailMedicinaModificata = (r) => componiEmail({
  to: r.email,
  subject: `Richiesta ${paroleDi(r).corta} aggiornata — codice ${r.codice}`,
  titolo: 'Richiesta confermata con modifiche',
  intro: `Gentile ${esc(r.nome)}, come d'accordo la sua richiesta è stata approvata con qualche cambiamento.`,
  righe: [
    ['Lei aveva chiesto', r.farmaci_originali],
    ['Le abbiamo preparato', r.farmaci],
    ['Note precedenti', r.note_originali !== r.note ? r.note_originali : null],
    ['Note', r.note],
    ['Come procedere', doveRitirare(r)],
    [paroleDi(r).etichettaNumero, r.numero_ricetta || null],
    ['Codice richiesta', r.codice]
  ],
  chiusura: 'Se qualcosa non corrisponde a quanto ci siamo detti al telefono, ci ricontatti.'
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

// La coda sa ritentare, non sa scrivere. Le si passa qui la funzione che compone
// l'avviso, in fondo al file perche' i modelli devono esistere prima di essere
// consegnati a qualcun altro.
impostaAvvisoDifficolta(emailConsegnaInDifficolta);
