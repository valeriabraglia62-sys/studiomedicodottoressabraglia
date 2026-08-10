import crypto from 'crypto';
import { db } from './db.js';
import {
  listaAmbulatori, trovaAmbulatorio, slotDisponibili, formattaDataEstesa,
  oggiISO, aggiungiGiorni, orariAmbulatorio, NOMI_GIORNI, GIORNI_PRENOTABILI, dataValida
} from './orari.js';
import {
  creaPrenotazione, annullaPrenotazione, perCodice, ErroreDominio,
  telefonoValido, emailValida
} from './prenotazioni.js';
import { creaRichiesta } from './medicine.js';

/**
 * Chatbot deterministico: nessun modello linguistico, quindi non puo' inventare
 * informazioni mediche. Lo stato della conversazione e' salvato nel database,
 * non in memoria: riaprendo la pagina si riprende esattamente dal punto in cui
 * si era rimasti, e un riavvio del server non azzera nulla.
 */

const STATO_INIZIALE = { flusso: 'menu', passo: null, dati: {} };
const SCADENZA_ORE = 72;

export function creaSessione() {
  const id = crypto.randomBytes(16).toString('base64url');
  const ora = new Date().toISOString();
  db.prepare(
    'INSERT INTO chat_sessioni (id, stato_json, creata_il, ultima_attivita) VALUES (?, ?, ?, ?)'
  ).run(id, JSON.stringify(STATO_INIZIALE), ora, ora);
  return id;
}

function leggiSessione(id) {
  if (!id) return null;
  const s = db.prepare('SELECT * FROM chat_sessioni WHERE id = ?').get(id);
  if (!s) return null;
  const scaduta = Date.now() - Date.parse(s.ultima_attivita) > SCADENZA_ORE * 3600000;
  return { ...s, stato: scaduta ? { ...STATO_INIZIALE } : JSON.parse(s.stato_json || '{}') };
}

function salvaStato(id, stato) {
  db.prepare('UPDATE chat_sessioni SET stato_json = ?, ultima_attivita = ? WHERE id = ?')
    .run(JSON.stringify(stato), new Date().toISOString(), id);
}

function registraMessaggio(sessioneId, ruolo, testo) {
  db.prepare('INSERT INTO chat_messaggi (sessione_id, ruolo, testo, creato_il) VALUES (?, ?, ?, ?)')
    .run(sessioneId, ruolo, testo, new Date().toISOString());
}

export function cronologia(sessioneId, limite = 100) {
  return db.prepare(
    'SELECT ruolo, testo, creato_il FROM chat_messaggi WHERE sessione_id = ? ORDER BY id DESC LIMIT ?'
  ).all(sessioneId, limite).reverse();
}

// ---- Interpretazione dell'input ------------------------------------------

const norm = (t) => String(t || '').trim().toLowerCase()
  .normalize('NFD').replace(/\p{Diacritic}/gu, '');

const contiene = (t, ...parole) => parole.some((p) => norm(t).includes(p));

/** Riconosce "oggi", "domani", "10/08", "10-08-2026", "2026-08-10". */
function interpretaData(testo) {
  const t = norm(testo);
  const oggi = oggiISO();

  if (contiene(t, 'oggi')) return oggi;
  if (contiene(t, 'domani')) return aggiungiGiorni(oggi, 1);
  if (contiene(t, 'dopodomani')) return aggiungiGiorni(oggi, 2);

  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[0];

  const ita = t.match(/(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?/);
  if (ita) {
    const g = ita[1].padStart(2, '0');
    const m = ita[2].padStart(2, '0');
    let a = ita[3] ? Number(ita[3]) : Number(oggi.slice(0, 4));
    if (a < 100) a += 2000;
    const candidata = `${a}-${m}-${g}`;
    if (!dataValida(candidata)) return null;
    // Senza anno esplicito, una data gia' passata si riferisce all'anno prossimo.
    return (!ita[3] && candidata < oggi) ? `${a + 1}-${m}-${g}` : candidata;
  }

  // Nome del giorno: prossima occorrenza.
  const indice = NOMI_GIORNI.findIndex((g) => contiene(t, norm(g)));
  if (indice >= 0) {
    for (let i = 1; i <= 7; i++) {
      const d = aggiungiGiorni(oggi, i);
      if (new Date(`${d}T00:00:00Z`).getUTCDay() === indice) return d;
    }
  }
  return null;
}

const interpretaOra = (t) => {
  const m = String(t).match(/(\d{1,2})[:.](\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
};

const interpretaAmbulatorio = (t) => {
  if (contiene(t, 'arceto')) return 1;
  if (contiene(t, 'casalgrande')) return 2;
  const n = String(t).trim();
  if (n === '1') return 1;
  if (n === '2') return 2;
  return null;
};

const affermativo = (t) => contiene(t, 'si', 'sì', 'confermo', 'conferma', 'ok', 'va bene', 'certo', 'procedi');

// ---- Risposte riutilizzabili ---------------------------------------------

const MENU = {
  testo: 'Come posso aiutarti?',
  azioni: [
    { id: 'prenota', etichetta: '📅 Prenota una visita' },
    { id: 'medicine', etichetta: '💊 Richiedi medicinali' },
    { id: 'stato', etichetta: '🔍 Controlla o annulla' },
    { id: 'info', etichetta: 'ℹ️ Orari e contatti' }
  ]
};

const risposta = (testo, azioni = [], extra = {}) => ({ testo, azioni, ...extra });

function testoOrari() {
  const righe = listaAmbulatori().map((a) => {
    const orari = orariAmbulatorio(a.id);
    const giorni = [1, 2, 3, 4, 5]
      .map((g) => `  · ${NOMI_GIORNI[g]}: ${orari[g] ? `${orari[g].inizio}–${orari[g].fine}` : 'chiuso'}`)
      .join('\n');
    return `**${a.nome}**\n📍 ${a.indirizzo}\n📞 ${a.telefono}\n${giorni}`;
  });
  return righe.join('\n\n');
}

function proponiGiorni(ambulatorioId, quanti = 6) {
  const oggi = oggiISO();
  const azioni = [];
  for (let i = 0; i <= GIORNI_PRENOTABILI && azioni.length < quanti; i++) {
    const d = aggiungiGiorni(oggi, i);
    if (slotDisponibili(d, ambulatorioId).some((s) => s.disponibile)) {
      azioni.push({ id: `data:${d}`, etichetta: formattaDataEstesa(d) });
    }
  }
  return azioni;
}

// ---- Motore ---------------------------------------------------------------

function gestisci(stato, testo) {
  const t = String(testo || '').trim();

  // Comandi sempre disponibili, in qualunque punto della conversazione.
  if (contiene(t, 'ricomincia', 'menu', 'annulla tutto', 'torna indietro')) {
    Object.assign(stato, { flusso: 'menu', passo: null, dati: {} });
    return risposta('Ricominciamo da capo. ' + MENU.testo, MENU.azioni);
  }
  if (contiene(t, 'aiuto', 'help')) {
    return risposta(
      'Posso aiutarti a prenotare una visita, richiedere medicinali, o controllare una prenotazione esistente.\n\n' +
      'Scrivi "menu" in qualunque momento per ricominciare.', MENU.azioni);
  }

  switch (stato.flusso) {
    case 'menu': return gestisciMenu(stato, t);
    case 'prenota': return gestisciPrenota(stato, t);
    case 'medicine': return gestisciMedicine(stato, t);
    case 'stato': return gestisciStato(stato, t);
    default:
      Object.assign(stato, { ...STATO_INIZIALE });
      return risposta(MENU.testo, MENU.azioni);
  }
}

function gestisciMenu(stato, t) {
  if (t === 'prenota' || contiene(t, 'prenot', 'visita', 'appuntamento')) {
    stato.flusso = 'prenota';
    stato.passo = 'ambulatorio';
    stato.dati = {};
    return risposta(
      'Bene. In quale ambulatorio? Ricorda: **puoi prenotare solo in quello di residenza**.',
      listaAmbulatori().map((a) => ({ id: `amb:${a.id}`, etichetta: a.nome.replace('Ambulatorio di ', '') }))
    );
  }
  if (t === 'medicine' || contiene(t, 'medicin', 'farmac', 'ricett', 'pastigl')) {
    stato.flusso = 'medicine';
    stato.passo = 'farmaci';
    stato.dati = {};
    return risposta('Quali medicinali ti servono? Elencali pure tutti in un messaggio.');
  }
  if (t === 'stato' || contiene(t, 'stato', 'controll', 'verific', 'disdet', 'annull', 'codice')) {
    stato.flusso = 'stato';
    stato.passo = 'codice';
    return risposta('Indicami il codice che hai ricevuto via email (per esempio PRE-A1B2-C3D4).');
  }
  if (t === 'info' || contiene(t, 'orari', 'contatt', 'telefono', 'indirizz', 'dove')) {
    return risposta(`${testoOrari()}\n\nPosso aiutarti con altro?`, MENU.azioni);
  }
  return risposta(`Non sono sicuro di aver capito. ${MENU.testo}`, MENU.azioni);
}

function gestisciPrenota(stato, t) {
  const d = stato.dati;

  switch (stato.passo) {
    case 'ambulatorio': {
      const id = t.startsWith('amb:') ? Number(t.slice(4)) : interpretaAmbulatorio(t);
      const amb = id ? trovaAmbulatorio(id) : null;
      if (!amb) {
        return risposta('Scegli uno dei due ambulatori:',
          listaAmbulatori().map((a) => ({ id: `amb:${a.id}`, etichetta: a.nome.replace('Ambulatorio di ', '') })));
      }
      d.ambulatorio_id = amb.id;
      stato.passo = 'data';
      const giorni = proponiGiorni(amb.id);
      return risposta(
        giorni.length
          ? `${amb.nome}. Per quale giorno?`
          : `Al momento non ci sono posti liberi presso ${amb.nome} nei prossimi ${GIORNI_PRENOTABILI} giorni. Prova con l'altro ambulatorio o chiama lo ${amb.telefono}.`,
        giorni.length ? giorni : MENU.azioni);
    }

    case 'data': {
      const data = t.startsWith('data:') ? t.slice(5) : interpretaData(t);
      if (!data || !dataValida(data)) {
        return risposta('Non ho capito la data. Puoi scrivere "domani", "15/09" oppure sceglierne una:',
          proponiGiorni(d.ambulatorio_id));
      }
      const liberi = slotDisponibili(data, d.ambulatorio_id).filter((s) => s.disponibile);
      if (!liberi.length) {
        return risposta(`Nessun posto libero ${formattaDataEstesa(data)}. Scegli un altro giorno:`,
          proponiGiorni(d.ambulatorio_id));
      }
      d.data = data;
      stato.passo = 'ora';
      return risposta(`Orari liberi per ${formattaDataEstesa(data)}:`,
        liberi.slice(0, 12).map((s) => ({ id: `ora:${s.ora_inizio}`, etichetta: s.ora_inizio })));
    }

    case 'ora': {
      const ora = t.startsWith('ora:') ? t.slice(4) : interpretaOra(t);
      const liberi = slotDisponibili(d.data, d.ambulatorio_id).filter((s) => s.disponibile);
      if (!ora || !liberi.some((s) => s.ora_inizio === ora)) {
        return risposta('Quell\'orario non è disponibile. Scegline uno tra questi:',
          liberi.slice(0, 12).map((s) => ({ id: `ora:${s.ora_inizio}`, etichetta: s.ora_inizio })));
      }
      d.ora_inizio = ora;
      stato.passo = 'nome';
      return risposta('Perfetto. Come ti chiami? (nome e cognome)');
    }

    case 'nome': {
      const parti = t.split(/\s+/).filter(Boolean);
      if (parti.length < 2) return risposta('Scrivi sia il nome che il cognome, per favore.');
      d.nome = parti[0];
      d.cognome = parti.slice(1).join(' ');
      stato.passo = 'telefono';
      return risposta(`Grazie ${d.nome}. Qual è il tuo numero di telefono?`);
    }

    case 'telefono': {
      if (!telefonoValido(t)) return risposta('Il numero non sembra valido. Riprova (esempio: 3331234567).');
      d.telefono = t.replace(/[\s.\-()]/g, '');
      stato.passo = 'email';
      // Non si puo' piu' saltare: la conferma, l'eventuale spostamento e
      // l'annullamento viaggiano per email. Chiederla qui, e non lasciare che
      // il rifiuto arrivi alla fine, evita di far compilare tutto per niente.
      return risposta('Qual è la tua email? Ti mandiamo lì la conferma con il codice.');
    }

    case 'email': {
      if (!emailValida(t)) {
        return risposta('L\'email non sembra valida: riprova (esempio: nome@esempio.it).');
      }
      d.email = t.trim().toLowerCase();
      stato.passo = 'problema';
      return risposta('Ultima cosa: qual è il motivo della visita?');
    }

    case 'problema': {
      if (t.length < 3) return risposta('Descrivi brevemente il motivo, anche poche parole vanno bene.');
      d.problema = t;
      stato.passo = 'conferma';
      const amb = trovaAmbulatorio(d.ambulatorio_id);
      return risposta(
        `Controlla che sia tutto giusto:\n\n` +
        `👤 ${d.nome} ${d.cognome}\n📞 ${d.telefono}\n✉️ ${d.email}\n` +
        `🏥 ${amb.nome}\n📅 ${formattaDataEstesa(d.data)}\n🕐 ${d.ora_inizio}\n📝 ${d.problema}\n\nConfermo?`,
        [{ id: 'conferma', etichetta: '✅ Confermo' }, { id: 'ricomincia', etichetta: '✏️ Ricomincia' }]);
    }

    case 'conferma': {
      if (!affermativo(t) && t !== 'conferma') {
        return risposta('Dimmi "confermo" per completare, oppure "ricomincia" per rifare da capo.',
          [{ id: 'conferma', etichetta: '✅ Confermo' }, { id: 'ricomincia', etichetta: '✏️ Ricomincia' }]);
      }
      try {
        const p = creaPrenotazione({ ...d, origine: 'chatbot' });
        Object.assign(stato, { flusso: 'menu', passo: null, dati: {} });
        return risposta(
          `✅ Prenotazione confermata!\n\n**Codice: ${p.codice}**\n` +
          `${formattaDataEstesa(p.data)} alle ${p.ora_inizio}\n${p.ambulatorio_nome}\n${p.ambulatorio_indirizzo}\n\n` +
          `Conserva il codice: ti serve per annullare. Ti abbiamo inviato una email di conferma.`,
          MENU.azioni, { prenotazione: p.codice });
      } catch (err) {
        if (err instanceof ErroreDominio) {
          stato.passo = 'data';
          return risposta(`${err.message}\n\nScegliamo un altro giorno:`, proponiGiorni(d.ambulatorio_id));
        }
        throw err;
      }
    }

    default:
      stato.passo = 'ambulatorio';
      return risposta('In quale ambulatorio?',
        listaAmbulatori().map((a) => ({ id: `amb:${a.id}`, etichetta: a.nome.replace('Ambulatorio di ', '') })));
  }
}

function gestisciMedicine(stato, t) {
  const d = stato.dati;

  switch (stato.passo) {
    case 'farmaci':
      if (t.length < 2) return risposta('Scrivi il nome dei medicinali che ti servono.');
      d.farmaci = t;
      stato.passo = 'nome';
      return risposta('Come ti chiami? (nome e cognome)');

    case 'nome': {
      const parti = t.split(/\s+/).filter(Boolean);
      if (parti.length < 2) return risposta('Scrivi sia il nome che il cognome, per favore.');
      d.nome = parti[0];
      d.cognome = parti.slice(1).join(' ');
      stato.passo = 'telefono';
      return risposta('Qual è il tuo numero di telefono?');
    }

    case 'telefono':
      if (!telefonoValido(t)) return risposta('Il numero non sembra valido. Riprova (esempio: 3331234567).');
      d.telefono = t.replace(/[\s.\-()]/g, '');
      stato.passo = 'email';
      // Il medico risponde sempre per iscritto — confermata, rifiutata o
      // cambiata — quindi l'indirizzo serve per forza.
      return risposta('Qual è la tua email? Ti scriviamo lì la risposta del medico.');

    case 'email': {
      if (!emailValida(t)) {
        return risposta('L\'email non sembra valida: riprova (esempio: nome@esempio.it).');
      }
      d.email = t.trim().toLowerCase();
      stato.passo = 'conferma';
      return risposta(
        `Controlla che sia tutto giusto:\n\n👤 ${d.nome} ${d.cognome}\n📞 ${d.telefono}\n` +
        `✉️ ${d.email}\n💊 ${d.farmaci}\n\nConfermo?`,
        [{ id: 'conferma', etichetta: '✅ Confermo' }, { id: 'ricomincia', etichetta: '✏️ Ricomincia' }]);
    }

    case 'conferma': {
      if (!affermativo(t) && t !== 'conferma') {
        return risposta('Dimmi "confermo" per inviare, oppure "ricomincia".',
          [{ id: 'conferma', etichetta: '✅ Confermo' }, { id: 'ricomincia', etichetta: '✏️ Ricomincia' }]);
      }
      const r = creaRichiesta({ ...d, origine: 'chatbot' });
      Object.assign(stato, { flusso: 'menu', passo: null, dati: {} });
      return risposta(
        `✅ Richiesta registrata!\n\n**Codice: ${r.codice}**\n💊 ${r.farmaci}\n\n` +
        `Lo studio la prenderà in carico e ti avviseremo quando la ricetta è pronta.`,
        MENU.azioni, { richiesta: r.codice });
    }

    default:
      stato.passo = 'farmaci';
      return risposta('Quali medicinali ti servono?');
  }
}

function gestisciStato(stato, t) {
  if (stato.passo === 'codice') {
    const codice = t.trim().toUpperCase();
    const p = perCodice(codice);

    if (!p) {
      return risposta('Non trovo nessuna prenotazione con questo codice. Controlla l\'email di conferma.',
        [{ id: 'menu', etichetta: 'Torna al menu' }]);
    }

    stato.dati = { codice: p.codice };
    stato.passo = 'azione';

    const etichettaStato = p.stato === 'annullata' ? '❌ Annullata' : '✅ Confermata';
    return risposta(
      `${etichettaStato}\n\n📅 ${formattaDataEstesa(p.data)}\n🕐 ${p.ora_inizio}\n🏥 ${p.ambulatorio_nome}\n` +
      `👤 ${p.paziente_nome} ${p.paziente_cognome}\n📝 ${p.problema}`,
      p.stato === 'annullata'
        ? [{ id: 'menu', etichetta: 'Torna al menu' }]
        : [{ id: 'disdici', etichetta: '❌ Annulla la prenotazione' }, { id: 'menu', etichetta: 'Va bene così' }]);
  }

  if (stato.passo === 'azione') {
    if (t === 'disdici' || contiene(t, 'annull', 'disdic', 'cancell')) {
      try {
        const p = annullaPrenotazione(stato.dati.codice, { da: 'paziente' });
        Object.assign(stato, { flusso: 'menu', passo: null, dati: {} });
        return risposta(
          `Prenotazione annullata.\n\n${formattaDataEstesa(p.data)} alle ${p.ora_inizio} — ${p.ambulatorio_nome}\n\n` +
          `Il posto è tornato disponibile per altri pazienti.`, MENU.azioni);
      } catch (err) {
        if (err instanceof ErroreDominio) {
          Object.assign(stato, { flusso: 'menu', passo: null, dati: {} });
          return risposta(err.message, MENU.azioni);
        }
        throw err;
      }
    }
    Object.assign(stato, { flusso: 'menu', passo: null, dati: {} });
    return risposta(MENU.testo, MENU.azioni);
  }

  stato.passo = 'codice';
  return risposta('Indicami il codice della prenotazione.');
}

/** Punto d'ingresso: riceve un messaggio, restituisce la risposta e persiste tutto. */
export function messaggio(sessioneId, testo, etichetta = '') {
  let sessione = leggiSessione(sessioneId);
  if (!sessione) {
    sessioneId = creaSessione();
    sessione = leggiSessione(sessioneId);
  }

  const stato = sessione.stato;
  // Nella cronologia va cio' che l'utente ha visto ("📅 Prenota una visita"),
  // non l'identificativo tecnico del pulsante ("prenota") che guida il flusso.
  registraMessaggio(sessioneId, 'utente', String(etichetta || testo || '').slice(0, 1000));

  let esito;
  try {
    esito = gestisci(stato, testo);
  } catch (err) {
    console.error('[chatbot] errore:', err);
    Object.assign(stato, { ...STATO_INIZIALE });
    esito = risposta(
      'Mi dispiace, si è verificato un problema. Riproviamo dall\'inizio.\n\n' +
      'Se il problema persiste puoi chiamare direttamente l\'ambulatorio.', MENU.azioni);
  }

  salvaStato(sessioneId, stato);
  registraMessaggio(sessioneId, 'bot', esito.testo);

  return { sessioneId, ...esito };
}

export function benvenuto(sessioneId) {
  const sessione = leggiSessione(sessioneId);
  if (sessione) {
    const storico = cronologia(sessioneId);
    if (storico.length) {
      return { sessioneId, cronologia: storico, azioni: MENU.azioni, ripresa: true };
    }
  }
  const id = sessione ? sessioneId : creaSessione();
  const testo = 'Ciao! Sono l\'assistente dello studio medico.\n\n' + MENU.testo;
  registraMessaggio(id, 'bot', testo);
  return { sessioneId: id, cronologia: cronologia(id), azioni: MENU.azioni, ripresa: false };
}

export function pulisciChatVecchie(giorni = 30) {
  const limite = new Date(Date.now() - giorni * 86400000).toISOString();
  return db.prepare('DELETE FROM chat_sessioni WHERE ultima_attivita < ?').run(limite).changes;
}
