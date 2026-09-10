import crypto from 'crypto';
import { db } from './db.js';
import { config } from './config.js';
import { accoda } from './outbox.js';
import {
  DURATA_SLOT_MINUTI, dataValida, giornoSettimana, minutiDaOra, oraDaMinuti,
  oggiISO, minutiCorrentiRoma, aggiungiGiorni, trovaAmbulatorio, GIORNI_PRENOTABILI,
  chiusureDelGiorno, slotBloccatoDaChiusura
} from './orari.js';
import {
  emailConfermaPaziente, emailNuovaPrenotazioneAdmin,
  emailAnnullamentoPaziente, emailAnnullamentoAdmin,
  emailPrenotazioneRiprogrammata, emailPrenotazioneRiprogrammataAdmin,
  emailAnagraficaDiscordante,
  emailRichiestaVisitaRicevutaPaziente, emailRichiestaVisitaDaConfermareAdmin,
  emailRichiestaVisitaRifiutataPaziente, emailRichiestaVisitaConfermataConModifiche
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

/**
 * Riusa il paziente se lo riconosce, altrimenti lo crea.
 *
 * Le strade per riconoscerlo sono due e non valgono uguale.
 *
 * Se coincidono telefono, nome e cognome e' la stessa persona, senza dubbi: li'
 * si puo' aggiornare l'email, ed e' anche necessario, perche' le conferme
 * partono verso l'indirizzo scritto sulla scheda e non verso quello appena
 * digitato. Chi cambia indirizzo, altrimenti, smetterebbe di ricevere qualsiasi
 * cosa senza capire perche'.
 *
 * Se invece coincide solo l'email, la persona potrebbe essere un'altra: basta
 * una lettera sbagliata per finire sull'indirizzo di qualcun altro. Prima questa
 * seconda strada riscriveva comunque nome, cognome e telefono della scheda
 * trovata, e in un archivio sanitario vuol dire che un paziente si prendeva
 * l'identita' di un altro senza che nessuno se ne accorgesse. Adesso la scheda
 * non si tocca e la discordanza va allo studio, che sa chi sono i suoi pazienti
 * e puo' distinguere un cambio di numero da uno scambio di persona.
 */
export function trovaOCreaPaziente(
  { nome, cognome, email, telefono, pazienteId },
  { contesto = 'il sito' } = {}
) {
  // Chi ha gia' un account collegato a una scheda la porta con se': si usa
  // quella e basta. Ricostruirla per nome+telefono, se un dato non combacia
  // alla lettera, creerebbe un doppione e il paziente non ritroverebbe piu'
  // le sue prenotazioni col codice.
  if (pazienteId) {
    const scheda = db.prepare('SELECT * FROM pazienti WHERE id = ?').get(Number(pazienteId));
    if (scheda) return scheda;
  }

  const tel = normalizzaTelefono(telefono);
  const mail = email ? String(email).trim().toLowerCase() : null;

  const perIdentita = db.prepare(
    `SELECT * FROM pazienti
      WHERE telefono = ? AND lower(nome) = lower(?) AND lower(cognome) = lower(?)`
  ).get(tel, nome, cognome);

  if (perIdentita) {
    db.prepare('UPDATE pazienti SET email = COALESCE(?, email) WHERE id = ?')
      .run(mail, perIdentita.id);
    return db.prepare('SELECT * FROM pazienti WHERE id = ?').get(perIdentita.id);
  }

  const perEmail = mail
    ? db.prepare('SELECT * FROM pazienti WHERE lower(email) = ?').get(mail)
    : null;

  if (perEmail) {
    const diverso = (a, b) =>
      String(a ?? '').trim().toLowerCase() !== String(b ?? '').trim().toLowerCase();

    if (diverso(perEmail.nome, nome) || diverso(perEmail.cognome, cognome)
        || diverso(perEmail.telefono, tel)) {
      // Sta nella stessa transazione di chi ci ha chiamati: se la prenotazione
      // poi non va a buon fine, non parte nemmeno questa segnalazione.
      accoda('email', emailAnagraficaDiscordante({
        scheda: perEmail,
        arrivato: { nome, cognome, telefono: tel },
        contesto
      }));
    }
    return perEmail;
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
  // La sintassi dell'orario si controlla SEMPRE, anche forzando: forza salta i
  // vincoli operativi (apertura, anticipo, passato), non un "99:99".
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(dati.ora_inizio || ''))) {
    throw new ErroreDominio('Orario non valido (usa HH:MM, 00:00–23:59).');
  }

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
    // Giornate o fasce orarie che lo studio ha bloccato per le prenotazioni.
    if (slotBloccatoDaChiusura(chiusureDelGiorno(dati.data), ambulatorio.id,
      inizio, inizio + DURATA_SLOT_MINUTI)) {
      throw new ErroreDominio('In questo periodo le prenotazioni sono sospese: scegli un altro giorno o orario.');
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

  const inizioMin = minutiDaOra(ora_inizio);
  const chiusure = chiusureDelGiorno(data).filter((c) =>
    c.ambulatorio_id === null || c.ambulatorio_id === ambulatorio.id);
  const bloccante = chiusure.find((c) =>
    !c.ora_inizio || (inizioMin < minutiDaOra(c.ora_fine) && inizioMin + DURATA_SLOT_MINUTI > minutiDaOra(c.ora_inizio)));
  if (bloccante) {
    note.push(bloccante.ora_inizio
      ? `Fascia bloccata (${bloccante.ora_inizio}-${bloccante.ora_fine})${bloccante.motivo ? `: ${bloccante.motivo}` : ''}.`
      : `Giornata di chiusura${bloccante.motivo ? `: ${bloccante.motivo}` : ''}.`);
  }

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
  // Dal sito l'email e' obbligatoria: conferma, annullamento e spostamento
  // vengono comunicati per iscritto, e senza indirizzo il paziente resterebbe
  // l'unico a non sapere che cosa e' successo al suo appuntamento. Dal pannello
  // (origine 'studio', o forzatura) e' facoltativa: al banco o al telefono
  // spesso non ce l'hanno, e la prenotazione la scrive lo studio, che il
  // paziente lo avvisa a voce.
  const scrittaDalloStudio = forza || dati.origine === 'studio';
  if (!scrittaDalloStudio && !email) {
    throw new ErroreDominio('Serve un indirizzo email: le confermiamo lì l\'appuntamento.');
  }
  if (email && !emailValida(email)) throw new ErroreDominio('L\'indirizzo email non è valido.');
  if (problema.length < 3) throw new ErroreDominio('Descrivi brevemente il motivo della visita.');

  const ambulatorio = trovaAmbulatorio(dati.ambulatorio_id);
  if (!ambulatorio) throw new ErroreDominio('Ambulatorio non valido.');

  return {
    nome, cognome, email, telefono, problema, ambulatorio,
    pazienteId: dati.pazienteId || null,
    ...validaQuando(dati, ambulatorio, forza),
    origine: dati.origine || 'sito'
  };
}

const SLOT_OCCUPATO = 'Questo orario è appena stato prenotato da un altro paziente. Scegline un altro.';

/**
 * Crea la prenotazione. Dato ed email vengono
 * scritti in un'unica transazione: o riesce tutto, o non resta traccia di nulla.
 *
 * Chi la scrive decide anche se nasce gia' valida o come semplice richiesta:
 *  - lo studio dal pannello (`forza`, o origine 'studio') mette in agenda una
 *    prenotazione 'confermata', com'e' sempre stato;
 *  - una richiesta da modulo che una persona conferma dal pannello passa
 *    `confermata: true`: e' lo studio che se ne fa carico;
 *  - tutto il resto — sito, chatbot — nasce 'in_attesa': e' una richiesta, e
 *    lo studio la conferma o la rifiuta a mano. Il paziente riceve un "abbiamo
 *    ricevuto", non un "confermato".
 */
export function creaPrenotazione(datiGrezzi, { forza = false, confermata = false } = {}) {
  const d = validaRichiesta(datiGrezzi, forza);
  const nasceConfermata = forza || confermata || d.origine === 'studio';
  const stato = nasceConfermata ? 'confermata' : 'in_attesa';

  const transazione = db.transaction(() => {
    const paziente = trovaOCreaPaziente(d, { contesto: 'una prenotazione di visita' });
    const codice = generaCodice('PRE');
    const adesso = new Date().toISOString();

    const info = db.prepare(`
      INSERT INTO prenotazioni
        (codice, ambulatorio_id, data, ora_inizio, ora_fine, paziente_id, problema, stato, origine, creata_il)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(codice, d.ambulatorio.id, d.data, d.ora_inizio, d.ora_fine,
      paziente.id, d.problema, stato, d.origine, adesso);

    const prenotazione = dettaglio(info.lastInsertRowid);

    if (nasceConfermata) {
      accoda('email', emailNuovaPrenotazioneAdmin(prenotazione));
      if (prenotazione.paziente_email) accoda('email', emailConfermaPaziente(prenotazione));
    } else {
      accoda('email', emailRichiestaVisitaDaConfermareAdmin(prenotazione));
      if (prenotazione.paziente_email) {
        accoda('email', emailRichiestaVisitaRicevutaPaziente(prenotazione));
      }
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

export const perCodiceDelPaziente = (codice, pazienteId) => db.prepare(
  `${SELECT_COMPLETO} WHERE p.codice = ? AND p.paziente_id = ?`
).get(String(codice || '').trim().toUpperCase(), Number(pazienteId));

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

/**
 * Lo studio accetta una richiesta 'in_attesa': diventa una prenotazione vera.
 *
 * Se `correzioni` porta un altro giorno, un'altra ora o un altro ambulatorio,
 * la conferma li applica: il paziente aveva chiesto le 11:00, lo studio lo
 * mette alle 11:15 e conferma in un colpo solo — non serve prima accettare e
 * poi spostare. In quel caso l'email al paziente e' quella "confermata con
 * modifiche", che gli dice cosa aveva chiesto e cosa gli e' stato fissato;
 * senza modifiche e' la conferma di sempre, col link al calendario.
 *
 * Da qui in poi la prenotazione e' identica a una nata dal pannello — entra
 * in agenda, nei promemoria, nei conteggi.
 */
export function confermaPrenotazione(codice, chi = null, correzioni = {}, { forza = false } = {}) {
  const p = perCodice(codice);
  if (!p) throw new ErroreDominio('Prenotazione non trovata. Controlla il codice.', 404);
  if (p.stato === 'confermata') throw new ErroreDominio('Questa richiesta è già stata confermata.');
  if (p.stato !== 'in_attesa') throw new ErroreDominio('Questa richiesta non è più in attesa: è stata annullata o rifiutata.');

  const ambulatorio = trovaAmbulatorio(correzioni.ambulatorio_id || p.ambulatorio_id);
  if (!ambulatorio) throw new ErroreDominio('Ambulatorio non valido.');

  const quando = validaQuando({
    data: correzioni.data || p.data,
    ora_inizio: correzioni.ora_inizio || p.ora_inizio
  }, ambulatorio, forza);

  const problema = String(correzioni.problema ?? '').trim()
    ? testoPulito(correzioni.problema, 500)
    : p.problema;

  const cambiata = quando.data !== p.data || quando.ora_inizio !== p.ora_inizio
    || ambulatorio.id !== p.ambulatorio_id;

  const transazione = db.transaction(() => {
    db.prepare(
      `UPDATE prenotazioni
          SET stato = 'confermata', ambulatorio_id = ?, data = ?, ora_inizio = ?, ora_fine = ?,
              problema = ?, confermata_il = ?, confermata_da = ?
        WHERE id = ?`
    ).run(ambulatorio.id, quando.data, quando.ora_inizio, quando.ora_fine, problema,
      new Date().toISOString(), chi || null, p.id);

    const aggiornata = dettaglio(p.id);
    if (cambiata) {
      // Servono all'email per dire "aveva chiesto ... / confermata per ...".
      aggiornata.data_precedente = p.data;
      aggiornata.ora_precedente = p.ora_inizio;
      aggiornata.ambulatorio_precedente = p.ambulatorio_nome;
    }
    if (aggiornata.paziente_email) {
      accoda('email', cambiata
        ? emailRichiestaVisitaConfermataConModifiche(aggiornata)
        : emailConfermaPaziente(aggiornata));
    }
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

/**
 * Lo studio non accetta una richiesta 'in_attesa'.
 *
 * Non e' un annullamento: la visita non c'e' mai stata. Resta scritta col suo
 * motivo, cosi' al fascicolo si vede cosa era stato chiesto e perche' e' stato
 * detto di no; il posto torna libero e chi era in lista d'attesa per quel
 * giorno va avvisato (lo fa il chiamante, come per gli annullamenti).
 */
export function rifiutaPrenotazione(codice, motivo, chi = null) {
  const p = perCodice(codice);
  if (!p) throw new ErroreDominio('Prenotazione non trovata. Controlla il codice.', 404);
  if (p.stato !== 'in_attesa') {
    throw new ErroreDominio(p.stato === 'confermata'
      ? 'Questa richiesta è già stata confermata: per disdirla usa "Annulla".'
      : 'Questa richiesta è già stata annullata o rifiutata.');
  }
  const testo = testoPulito(motivo, 300);
  if (testo.length < 3) throw new ErroreDominio('Scrivi un motivo per il rifiuto: finisce nell\'email al paziente.');

  const transazione = db.transaction(() => {
    db.prepare(
      `UPDATE prenotazioni
          SET stato = 'rifiutata', motivo_rifiuto = ?, annullata_da = 'admin',
              annullata_il = ?, annullata_utente = ?
        WHERE id = ?`
    ).run(testo, new Date().toISOString(), chi || null, p.id);

    const aggiornata = dettaglio(p.id);
    if (aggiornata.paziente_email) accoda('email', emailRichiestaVisitaRifiutataPaziente(aggiornata));
    return aggiornata;
  });

  return transazione();
}

export function annullaPrenotazione(codice, { da = 'paziente', chi = null } = {}) {
  const p = perCodice(codice);
  if (!p) throw new ErroreDominio('Prenotazione non trovata. Controlla il codice.', 404);
  if (p.stato === 'annullata') throw new ErroreDominio('Questa prenotazione è già stata annullata.');
  if (p.stato === 'rifiutata') throw new ErroreDominio('Questa richiesta è stata rifiutata dallo studio.');

  // Il limite vale per il paziente su una prenotazione confermata; una richiesta
  // ancora 'in_attesa' si ritira sempre, e lo studio può annullare sempre.
  if (da !== 'admin' && p.stato === 'confermata') {
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
      `UPDATE prenotazioni
          SET stato = 'annullata', annullata_da = ?, annullata_il = ?, annullata_utente = ?
        WHERE id = ?`
    ).run(da, new Date().toISOString(), chi || null, p.id);

    const aggiornata = dettaglio(p.id);
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

  // Un annullamento serve il giorno che succede: bisogna vederlo, capire se
  // richiamare il paziente, accorgersi che un orario si e' liberato. Il giorno
  // dopo e' solo una riga in mezzo alle altre, e su un elenco che si guarda di
  // corsa la mattina il rumore fa perdere le cose che contano.
  //
  // Spariscono dalla vista, non dall'archivio: chi le cerca le ritrova mettendo
  // il filtro su "Annullate", e la storia resta scritta. Nascondere e cancellare
  // si somigliano solo finche' non serve rispondere a "ma io non avevo disdetto".
  if (!stato) {
    dove.push(
      "(p.stato NOT IN ('annullata', 'rifiutata') OR date(p.annullata_il) >= date('now', '-1 day'))");
  }

  /**
   * E una visita gia' fatta sgombera il giorno dopo.
   *
   * L'elenco delle prenotazioni serve a sapere chi deve ancora venire. Una
   * visita di marzo, ad agosto, e' solo una riga fra cui scorrere per arrivare
   * a quelle di domani, e ogni settimana ce ne sono di piu'.
   *
   * Il giorno di margine c'e' apposta: la visita di oggi resta in elenco fino a
   * domani, perche' la giornata si chiude la sera e non a mezzogiorno.
   *
   * Anche questa e' una sparizione dalla vista: la visita resta nell'archivio e
   * nella scheda del paziente, sotto "Visite", che e' il posto dove si va a
   * cercarla mesi dopo. Chi la vuole nell'elenco la ritrova mettendo le date.
   */
  if (!stato && !dal && !al && !cerca) {
    dove.push("(p.stato NOT IN ('confermata', 'in_attesa') OR p.data >= date('now', '-1 day'))");
  }
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
