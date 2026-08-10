import crypto from 'crypto';
import { db } from './db.js';
import { config } from './config.js';
import { accoda } from './outbox.js';
import {
  DURATA_SLOT_MINUTI, dataValida, giornoSettimana, minutiDaOra, oraDaMinuti,
  oggiISO, minutiCorrentiRoma, aggiungiGiorni, trovaAmbulatorio, GIORNI_PRENOTABILI
} from './orari.js';
import {
  emailConfermaPaziente, emailNuovaPrenotazioneAdmin,
  emailAnnullamentoPaziente, emailAnnullamentoAdmin,
  emailPrenotazioneRiprogrammata, emailPrenotazioneRiprogrammataAdmin
} from './mailer.js';

/** Errore con messaggio pensato per essere mostrato al paziente. */
export class ErroreDominio extends Error {
  constructor(messaggio, codiceHttp = 400) {
    super(messaggio);
    this.codiceHttp = codiceHttp;
  }
}

// Alfabeto senza caratteri ambigui (0/O, 1/I/L): il codice viene letto al telefono.
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generaCodice(prefisso) {
  const b = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += ALFABETO[b[i] % ALFABETO.length];
  return `${prefisso}-${s.slice(0, 4)}-${s.slice(4)}`;
}

const testoPulito = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const normalizzaTelefono = (t) => String(t ?? '').replace(/[\s.\-()]/g, '');

export function telefonoValido(t) {
  return /^(\+39)?\d{8,11}$/.test(normalizzaTelefono(t));
}

export function emailValida(e) {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(String(e ?? '').trim());
}

/** Riusa il paziente se lo riconosce, altrimenti lo crea. */
export function trovaOCreaPaziente({ nome, cognome, email, telefono }) {
  const tel = normalizzaTelefono(telefono);
  const mail = email ? String(email).trim().toLowerCase() : null;

  let paziente = db.prepare(
    `SELECT * FROM pazienti
      WHERE telefono = ? AND lower(nome) = lower(?) AND lower(cognome) = lower(?)`
  ).get(tel, nome, cognome);

  if (!paziente && mail) {
    paziente = db.prepare('SELECT * FROM pazienti WHERE lower(email) = ?').get(mail);
  }

  if (paziente) {
    db.prepare('UPDATE pazienti SET nome = ?, cognome = ?, email = COALESCE(?, email), telefono = ? WHERE id = ?')
      .run(nome, cognome, mail, tel, paziente.id);
    return db.prepare('SELECT * FROM pazienti WHERE id = ?').get(paziente.id);
  }

  const info = db.prepare(
    'INSERT INTO pazienti (nome, cognome, email, telefono, creato_il) VALUES (?, ?, ?, ?, ?)'
  ).run(nome, cognome, mail, tel, new Date().toISOString());

  return db.prepare('SELECT * FROM pazienti WHERE id = ?').get(info.lastInsertRowid);
}

/**
 * Controlla giorno, ora e ambulatorio di un appuntamento.
 *
 * `forza` e' il permesso che ha solo lo studio dal pannello: salta i limiti
 * pensati per il paziente — orari di apertura, allineamento agli slot, quanto
 * in anticipo si puo' prenotare, e anche il passato, perche' capita di dover
 * registrare a posteriori una visita gia' fatta.
 *
 * Una cosa resta vietata anche forzando: due appuntamenti nello stesso
 * ambulatorio alla stessa ora. Non e' un limite burocratico, e' l'unica cosa
 * che impedisce di dare a due pazienti lo stesso posto; il divieto e' scritto
 * nel database (idx_slot_unico), non solo qui.
 */
function validaQuando(dati, ambulatorio, forza) {
  if (!dataValida(dati.data)) throw new ErroreDominio('Data non valida.');
  if (!/^\d{2}:\d{2}$/.test(String(dati.ora_inizio || ''))) throw new ErroreDominio('Orario non valido.');

  const oggi = oggiISO();
  const inizio = minutiDaOra(dati.ora_inizio);

  if (!forza) {
    if (dati.data < oggi) throw new ErroreDominio('Non è possibile prenotare in una data passata.');
    if (dati.data > aggiungiGiorni(oggi, GIORNI_PRENOTABILI)) {
      throw new ErroreDominio(`Si può prenotare al massimo ${GIORNI_PRENOTABILI} giorni in anticipo.`);
    }

    // L'orario richiesto deve cadere davvero dentro l'apertura dell'ambulatorio.
    const orario = db.prepare('SELECT ora_inizio, ora_fine FROM orari WHERE ambulatorio_id = ? AND giorno = ?')
      .get(ambulatorio.id, giornoSettimana(dati.data));

    if (!orario?.ora_inizio) {
      throw new ErroreDominio(`${ambulatorio.nome} è chiuso in questa giornata.`);
    }

    const apertura = minutiDaOra(orario.ora_inizio);
    const chiusura = minutiDaOra(orario.ora_fine);

    if (inizio < apertura || inizio + DURATA_SLOT_MINUTI > chiusura) {
      throw new ErroreDominio(`Orario fuori dagli orari di apertura (${orario.ora_inizio}-${orario.ora_fine}).`);
    }
    if ((inizio - apertura) % DURATA_SLOT_MINUTI !== 0) {
      throw new ErroreDominio('Orario non allineato agli slot disponibili.');
    }
    if (dati.data === oggi && inizio <= minutiCorrentiRoma()) {
      throw new ErroreDominio('Questo orario è già passato.');
    }
  }

  return { data: dati.data, ora_inizio: dati.ora_inizio, ora_fine: oraDaMinuti(inizio + DURATA_SLOT_MINUTI) };
}

/** Quello che lo studio deve sapere prima di forzare, senza impedirglielo. */
export function avvertimenti({ data, ora_inizio, ambulatorio_id }) {
  const note = [];
  const ambulatorio = trovaAmbulatorio(ambulatorio_id);
  if (!ambulatorio || !dataValida(data) || !/^\d{2}:\d{2}$/.test(String(ora_inizio || ''))) return note;

  const oggi = oggiISO();
  if (data < oggi) note.push('Questa data è già passata.');
  else if (data === oggi && minutiDaOra(ora_inizio) <= minutiCorrentiRoma()) {
    note.push('Quest\'ora di oggi è già passata.');
  }

  const orario = db.prepare('SELECT ora_inizio, ora_fine FROM orari WHERE ambulatorio_id = ? AND giorno = ?')
    .get(ambulatorio.id, giornoSettimana(data));

  if (!orario?.ora_inizio) note.push(`${ambulatorio.nome} di solito è chiuso in questa giornata.`);
  else {
    const inizio = minutiDaOra(ora_inizio);
    if (inizio < minutiDaOra(orario.ora_inizio) || inizio + DURATA_SLOT_MINUTI > minutiDaOra(orario.ora_fine)) {
      note.push(`Fuori dall'orario di apertura (${orario.ora_inizio}-${orario.ora_fine}).`);
    }
  }

  const chiusura = db.prepare(
    'SELECT motivo FROM chiusure WHERE ? BETWEEN dal AND al AND (ambulatorio_id IS NULL OR ambulatorio_id = ?)'
  ).get(data, ambulatorio.id);
  if (chiusura) note.push(`Giornata di chiusura: ${chiusura.motivo}.`);

  return note;
}

function validaRichiesta(dati, forza = false) {
  const nome = testoPulito(dati.nome, 60);
  const cognome = testoPulito(dati.cognome, 60);
  const problema = testoPulito(dati.problema, 500);
  const telefono = normalizzaTelefono(dati.telefono);
  const email = dati.email ? String(dati.email).trim().toLowerCase() : null;

  if (nome.length < 2) throw new ErroreDominio('Inserisci un nome valido.');
  if (cognome.length < 2) throw new ErroreDominio('Inserisci un cognome valido.');
  if (!telefonoValido(telefono)) throw new ErroreDominio('Inserisci un numero di telefono valido (8-11 cifre).');
  // L'email non e' piu' facoltativa: conferma, annullamento e spostamento
  // vengono comunicati per iscritto, e senza indirizzo il paziente resterebbe
  // l'unico a non sapere che cosa e' successo al suo appuntamento.
  if (!email) throw new ErroreDominio('Serve un indirizzo email: le confermiamo lì l\'appuntamento.');
  if (!emailValida(email)) throw new ErroreDominio('L\'indirizzo email non è valido.');
  if (problema.length < 3) throw new ErroreDominio('Descrivi brevemente il motivo della visita.');

  const ambulatorio = trovaAmbulatorio(dati.ambulatorio_id);
  if (!ambulatorio) throw new ErroreDominio('Ambulatorio non valido.');

  return {
    nome, cognome, email, telefono, problema, ambulatorio,
    ...validaQuando(dati, ambulatorio, forza),
    origine: dati.origine || 'sito'
  };
}

const SLOT_OCCUPATO = 'Questo orario è appena stato prenotato da un altro paziente. Scegline un altro.';

/**
 * Crea la prenotazione. Dato, email e sincronizzazione col foglio vengono
 * scritti in un'unica transazione: o riesce tutto, o non resta traccia di nulla.
 */
export function creaPrenotazione(datiGrezzi, { forza = false } = {}) {
  const d = validaRichiesta(datiGrezzi, forza);

  const transazione = db.transaction(() => {
    const paziente = trovaOCreaPaziente(d);
    const codice = generaCodice('PRE');
    const adesso = new Date().toISOString();

    const info = db.prepare(`
      INSERT INTO prenotazioni
        (codice, ambulatorio_id, data, ora_inizio, ora_fine, paziente_id, problema, origine, creata_il)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(codice, d.ambulatorio.id, d.data, d.ora_inizio, d.ora_fine,
      paziente.id, d.problema, d.origine, adesso);

    const prenotazione = dettaglio(info.lastInsertRowid);

    accoda('sheet_prenotazione', prenotazione);
    accoda('email', emailNuovaPrenotazioneAdmin(prenotazione));
    if (prenotazione.paziente_email) {
      accoda('email', emailConfermaPaziente(prenotazione));
    }

    return prenotazione;
  });

  try {
    return transazione();
  } catch (err) {
    // Violazione dell'indice unico: due pazienti hanno scelto lo stesso slot
    // nello stesso istante. Il database ne fa passare uno solo.
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint/i.test(err.message)) {
      throw new ErroreDominio(SLOT_OCCUPATO, 409);
    }
    throw err;
  }
}

const SELECT_COMPLETO = `
  SELECT p.*,
         a.nome     AS ambulatorio_nome,
         a.indirizzo AS ambulatorio_indirizzo,
         a.telefono  AS ambulatorio_telefono,
         pa.nome     AS paziente_nome,
         pa.cognome  AS paziente_cognome,
         pa.telefono AS paziente_telefono,
         pa.email    AS paziente_email
    FROM prenotazioni p
    JOIN ambulatori a  ON a.id  = p.ambulatorio_id
    JOIN pazienti   pa ON pa.id = p.paziente_id
`;

export const dettaglio = (id) => db.prepare(`${SELECT_COMPLETO} WHERE p.id = ?`).get(id);

export const perCodice = (codice) =>
  db.prepare(`${SELECT_COMPLETO} WHERE p.codice = ?`).get(String(codice || '').trim().toUpperCase());

export const perPaziente = (pazienteId) =>
  db.prepare(`${SELECT_COMPLETO} WHERE p.paziente_id = ? ORDER BY p.data DESC, p.ora_inizio DESC`)
    .all(pazienteId);

/** Minuti mancanti all'appuntamento; negativo se è già passato. */
export function minutiAllAppuntamento(p) {
  const oggi = oggiISO();
  const giorniDiff = Math.round(
    (Date.parse(`${p.data}T00:00:00Z`) - Date.parse(`${oggi}T00:00:00Z`)) / 86400000
  );
  return giorniDiff * 1440 + minutiDaOra(p.ora_inizio) - minutiCorrentiRoma();
}

export function annullaPrenotazione(codice, { da = 'paziente' } = {}) {
  const p = perCodice(codice);
  if (!p) throw new ErroreDominio('Prenotazione non trovata. Controlla il codice.', 404);
  if (p.stato === 'annullata') throw new ErroreDominio('Questa prenotazione è già stata annullata.');

  // Il limite vale per il paziente; lo studio può annullare sempre.
  if (da !== 'admin') {
    const mancanti = minutiAllAppuntamento(p);
    if (mancanti < config.cancellazioneMinutiMinimi) {
      throw new ErroreDominio(
        mancanti < 0
          ? 'Questo appuntamento è già passato.'
          : `L'annullamento online è possibile fino a ${config.cancellazioneMinutiMinimi} minuti prima. ` +
            `Chiama l'ambulatorio allo ${p.ambulatorio_telefono}.`
      );
    }
  }

  const transazione = db.transaction(() => {
    db.prepare(
      `UPDATE prenotazioni SET stato = 'annullata', annullata_da = ?, annullata_il = ? WHERE id = ?`
    ).run(da, new Date().toISOString(), p.id);

    const aggiornata = dettaglio(p.id);
    accoda('sheet_prenotazione', aggiornata);
    accoda('email', emailAnnullamentoAdmin(aggiornata));
    if (aggiornata.paziente_email) accoda('email', emailAnnullamentoPaziente(aggiornata));
    return aggiornata;
  });

  return transazione();
}

/**
 * Sposta un appuntamento gia' preso: altro giorno, altra ora, altro ambulatorio.
 *
 * Non e' un annullamento seguito da una nuova prenotazione, ed e' una
 * differenza che si vede: il codice resta quello che il paziente ha in mano,
 * e non gli arrivano due email che si contraddicono ("annullata" e subito
 * dopo "confermata"). Ne riceve una sola, che dice da dove a dove.
 *
 * Lo stato resta 'confermata' apposta. Un valore diverso farebbe sparire
 * l'appuntamento da agenda, promemoria e conteggi — che filtrano tutti su
 * 'confermata' — e soprattutto gli toglierebbe idx_slot_unico, l'indice
 * parziale che impedisce di dare lo stesso posto a due pazienti.
 */
export function riprogramma(codice, correzioni = {}, chi = null, { forza = false } = {}) {
  const p = perCodice(codice);
  if (!p) throw new ErroreDominio('Prenotazione non trovata. Controlla il codice.', 404);
  if (p.stato !== 'confermata') {
    throw new ErroreDominio('Questa prenotazione è annullata: non si può spostare.');
  }

  const ambulatorio = trovaAmbulatorio(correzioni.ambulatorio_id || p.ambulatorio_id);
  if (!ambulatorio) throw new ErroreDominio('Ambulatorio non valido.');

  const quando = validaQuando({
    data: correzioni.data || p.data,
    ora_inizio: correzioni.ora_inizio || p.ora_inizio
  }, ambulatorio, forza);

  if (quando.data === p.data && quando.ora_inizio === p.ora_inizio
      && ambulatorio.id === p.ambulatorio_id) {
    throw new ErroreDominio('Non hai spostato niente: giorno, ora e ambulatorio sono gli stessi.');
  }

  const transazione = db.transaction(() => {
    db.prepare(`
      UPDATE prenotazioni
         SET data = ?, ora_inizio = ?, ora_fine = ?, ambulatorio_id = ?,
             data_originale = COALESCE(data_originale, ?),
             ora_originale  = COALESCE(ora_originale, ?),
             riprogrammata_il = ?, riprogrammata_da = ?,
             promemoria_il = NULL
       WHERE id = ?
    `).run(quando.data, quando.ora_inizio, quando.ora_fine, ambulatorio.id,
      p.data, p.ora_inizio, new Date().toISOString(), chi || null, p.id);

    const aggiornata = dettaglio(p.id);
    // Il vecchio appuntamento serve all'email per dire da dove si e' spostato.
    aggiornata.data_precedente = p.data;
    aggiornata.ora_precedente = p.ora_inizio;
    aggiornata.ambulatorio_precedente = p.ambulatorio_nome;

    accoda('sheet_prenotazione', aggiornata);
    // L'indirizzo adesso e' obbligatorio, ma le prenotazioni prese prima di
    // questa regola possono non averlo: senza il controllo finirebbe in coda
    // una email senza destinatario, che riprova e fallisce all'infinito.
    if (aggiornata.paziente_email) accoda('email', emailPrenotazioneRiprogrammata(aggiornata));
    accoda('email', emailPrenotazioneRiprogrammataAdmin(aggiornata));
    return aggiornata;
  });

  try {
    return transazione();
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint/i.test(err.message)) {
      throw new ErroreDominio(
        'In quell\'ambulatorio, a quell\'ora, c\'è già un altro paziente. Scegli un altro orario.', 409);
    }
    throw err;
  }
}

export function elencoAdmin({ dal, al, stato, ambulatorio_id, cerca, pagina = 1, perPagina = 50 } = {}) {
  const dove = [];
  const par = [];

  if (dal) { dove.push('p.data >= ?'); par.push(dal); }
  if (al) { dove.push('p.data <= ?'); par.push(al); }
  if (stato) { dove.push('p.stato = ?'); par.push(stato); }
  if (ambulatorio_id) { dove.push('p.ambulatorio_id = ?'); par.push(ambulatorio_id); }
  if (cerca) {
    dove.push(`(pa.nome LIKE ? OR pa.cognome LIKE ? OR pa.telefono LIKE ?
                OR pa.email LIKE ? OR p.problema LIKE ? OR p.codice LIKE ?)`);
    const q = `%${cerca}%`;
    par.push(q, q, q, q, q, q.toUpperCase());
  }

  const filtro = dove.length ? `WHERE ${dove.join(' AND ')}` : '';
  const totale = db.prepare(
    `SELECT COUNT(*) AS n FROM prenotazioni p JOIN pazienti pa ON pa.id = p.paziente_id ${filtro}`
  ).get(...par).n;

  const limite = Math.min(Math.max(Number(perPagina) || 50, 1), 200);
  const offset = (Math.max(Number(pagina) || 1, 1) - 1) * limite;

  const righe = db.prepare(
    `${SELECT_COMPLETO} ${filtro} ORDER BY p.data DESC, p.ora_inizio DESC LIMIT ? OFFSET ?`
  ).all(...par, limite, offset);

  return { prenotazioni: righe, totale, pagina: Number(pagina) || 1, pagine: Math.ceil(totale / limite) || 1 };
}
