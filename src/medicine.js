import { db } from './db.js';
import { accoda, avvisoAncoraInCoda } from './outbox.js';
import { trovaAmbulatorio } from './orari.js';
import {
  ErroreDominio, generaCodice, trovaOCreaPaziente, telefonoValido, emailValida
} from './prenotazioni.js';
import {
  emailNuovaMedicinaAdmin, emailRicevutaMedicinaPaziente,
  emailMedicinaConfermata, emailMedicinaRifiutata, emailMedicinaModificata,
  emailAllegatoTardivo, impostaLettoreAllegati
} from './mailer.js';

/**
 * Il giro di una richiesta di medicinali.
 *
 *   nuova ──┬─ conferma ──────────► confermata
 *           ├─ modifica ──────────► confermata
 *           └─ rifiuta ───────────► rifiutata
 *
 * Gli stati raccontano la risposta data al paziente, non il lavoro dello
 * studio: sono le stesse tre parole che gli arrivano per email. "Modifica"
 * non e' uno stato a se' perche' cambiare una richiesta vuol dire accettarla
 * cambiando qualcosa, e al paziente interessa sapere che e' stata accolta.
 *
 * C'e' un quarto stato, "consegnata", ma nessuno lo scrive piu': valeva quando
 * la ricetta si ritirava in ambulatorio e il paziente lo si vedeva arrivare.
 * Ora si ritira in farmacia e qui nessuno puo' sapere se ci e' andato, quindi
 * il bottone e' stato tolto. Lo stato resta perche' le richieste chiuse cosi'
 * sono ancora in archivio e devono restare leggibili.
 */
export const STATI = ['nuova', 'confermata', 'rifiutata', 'consegnata'];

/**
 * I tre tipi di richiesta, che per il programma sono la stessa cosa.
 *
 * Cambiano le parole — al paziente si chiede "quali medicinali" o "quale visita"
 * — e cambia il codice, cosi' guardando MED-, SPE- o ESA- si sa gia' di cosa si
 * parla senza aprire niente. Il resto del giro e' identico, e deve restare tale:
 * il giorno in cui si corregge il modo di confermare, la correzione vale per
 * tutti e tre invece di essere riportata a mano in tre posti, dimenticandone
 * uno.
 */
export const TIPI = {
  medicina: {
    prefisso: 'MED',
    etichetta: 'Medicinali',
    cosaChiede: 'medicinali',
    vuoto: 'Indica quali medicinali ti servono.'
  },
  specialistica: {
    prefisso: 'SPE',
    etichetta: 'Visita specialistica',
    cosaChiede: 'visita specialistica',
    vuoto: 'Indica di quale visita specialistica hai bisogno.',
    allegati: true
  },
  esami: {
    prefisso: 'ESA',
    etichetta: 'Esami del sangue',
    cosaChiede: 'esami del sangue',
    vuoto: 'Indica quali esami ti servono, o allega la richiesta dello specialista.',
    allegati: true
  }
};

/**
 * Quanto aspettare prima di avvisare lo studio, quando la richiesta puo' avere
 * una foto attaccata.
 *
 * La foto arriva sempre DOPO la richiesta: prima deve esistere qualcosa a cui
 * attaccarla. Se l'avviso partisse subito, in casella arriverebbe una richiesta
 * di esami senza la prescrizione, e qualcuno dovrebbe aprire il pannello per
 * vedere se nel frattempo la foto e' arrivata — cioe' esattamente il lavoro che
 * l'email dovrebbe risparmiare. Qualche minuto di ritardo non cambia niente per
 * chi legge; una prescrizione mancante sì.
 */
const ATTESA_ALLEGATI_MINUTI = 4;

const tipoValido = (t) => (Object.hasOwn(TIPI, String(t || '')) ? String(t) : 'medicina');

export const ETICHETTE_STATO = {
  nuova: 'Da vedere',
  confermata: 'Confermata',
  rifiutata: 'Rifiutata',
  consegnata: 'Consegnata'
};

const testoPulito = (v, max) => String(v ?? '').trim().replace(/[ \t]+/g, ' ').slice(0, max);

const SELECT_COMPLETO = `
  SELECT r.*, a.nome AS ambulatorio_nome
    FROM richieste_medicine r
    LEFT JOIN ambulatori a ON a.id = r.ambulatorio_id
`;

export const perCodice = (codice) =>
  db.prepare(`${SELECT_COMPLETO} WHERE r.codice = ?`).get(String(codice || '').trim().toUpperCase());

export const perCodiceDelPaziente = (codice, pazienteId) => db.prepare(
  `${SELECT_COMPLETO} WHERE r.codice = ? AND r.paziente_id = ?`
).get(String(codice || '').trim().toUpperCase(), Number(pazienteId));

export const perPaziente = (pazienteId) => db.prepare(
  `${SELECT_COMPLETO} WHERE r.paziente_id = ? ORDER BY r.creata_il DESC`
).all(Number(pazienteId));

export const dettaglio = (id) => db.prepare(`${SELECT_COMPLETO} WHERE r.id = ?`).get(id);

export function creaRichiesta(dati) {
  const nome = testoPulito(dati.nome, 60);
  const cognome = testoPulito(dati.cognome, 60);
  const farmaci = testoPulito(dati.farmaci, 1500);
  const note = testoPulito(dati.note, 500) || null;
  const telefono = String(dati.telefono ?? '').replace(/[\s.\-()]/g, '');
  const email = dati.email ? String(dati.email).trim().toLowerCase() : null;
  const origine = dati.origine || 'sito';

  const tipo = tipoValido(dati.tipo);

  if (nome.length < 2) throw new ErroreDominio('Inserisci un nome valido.');
  if (cognome.length < 2) throw new ErroreDominio('Inserisci un cognome valido.');

  // Per gli esami il testo puo' mancare, ma solo se c'e' un allegato: la
  // prescrizione dello specialista *e'* la richiesta, e ricopiarla a mano
  // sarebbe chiedere al paziente di trascrivere una cosa che ha gia' in mano,
  // con il rischio di sbagliarla.
  const conAllegato = Boolean(dati.conAllegato);
  if (farmaci.length < 2 && !(tipo === 'esami' && conAllegato)) {
    throw new ErroreDominio(TIPI[tipo].vuoto);
  }

  /**
   * L'email adesso serve sempre, e non e' una formalita': conferma, rifiuto e
   * modifica esistono solo come messaggi scritti al paziente. Una richiesta
   * senza indirizzo sarebbe una richiesta a cui non si puo' rispondere.
   *
   * Unica eccezione, la lettura automatica della casella: li' l'indirizzo c'e'
   * sempre per forza — e' il mittente — ma se un giorno mancasse, buttare via
   * la richiesta sarebbe peggio che registrarla e richiamare.
   */
  if (!email && origine !== 'email') {
    throw new ErroreDominio('Serve un indirizzo email: le rispondiamo lì.');
  }
  if (email && !emailValida(email)) throw new ErroreDominio('L\'indirizzo email non è valido.');

  // Dalle email in arrivo il telefono spesso manca: non blocchiamo la richiesta,
  // perche' perderla sarebbe peggio che registrarla incompleta.
  if (origine === 'sito' && !telefonoValido(telefono)) {
    throw new ErroreDominio('Inserisci un numero di telefono valido (8-11 cifre).');
  }
  if (!email && !telefonoValido(telefono)) {
    throw new ErroreDominio('Serve almeno un recapito: telefono o email.');
  }

  const ambulatorio = dati.ambulatorio_id ? trovaAmbulatorio(dati.ambulatorio_id) : null;

  const transazione = db.transaction(() => {
    const paziente = telefonoValido(telefono)
      ? trovaOCreaPaziente({ nome, cognome, email, telefono, pazienteId: dati.pazienteId },
        { contesto: `una richiesta di ${TIPI[tipo].cosaChiede}` })
      : null;

    const codice = generaCodice(TIPI[tipo].prefisso);
    const info = db.prepare(`
      INSERT INTO richieste_medicine
        (codice, tipo, paziente_id, nome, cognome, telefono, email, farmaci, note, ambulatorio_id, origine, creata_il)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(codice, tipo, paziente?.id ?? null, nome, cognome, telefono || null, email,
      farmaci, note, ambulatorio?.id ?? null, origine, new Date().toISOString());

    const richiesta = dettaglio(info.lastInsertRowid);

    // allegatiDi dice al mailer di andare a prendere i file al momento
    // dell'invio, non adesso: adesso non ce n'e' ancora nessuno.
    accoda('email',
      { ...emailNuovaMedicinaAdmin(richiesta), allegatiDi: richiesta.id },
      { fraMinuti: TIPI[tipo].allegati ? ATTESA_ALLEGATI_MINUTI : 0 });
    // Chi scrive via email ha gia' il proprio messaggio: evitiamo il rimbalzo.
    if (richiesta.email && origine !== 'email') {
      accoda('email', emailRicevutaMedicinaPaziente(richiesta));
    }

    return richiesta;
  });

  return transazione();
}

/**
 * Prende la richiesta e la prepara al passaggio successivo.
 *
 * Il controllo sullo stato di partenza non e' pignoleria: senza, due persone
 * che aprono il pannello insieme potrebbero rispondere due volte alla stessa
 * richiesta, e al paziente arriverebbero due email che si contraddicono.
 */
function daGestire(codice, statiAmmessi) {
  const richiesta = perCodice(codice);
  if (!richiesta) throw new ErroreDominio('Richiesta non trovata.', 404);
  if (!statiAmmessi.includes(richiesta.stato)) {
    throw new ErroreDominio(
      `Questa richiesta è già stata gestita: risulta ${ETICHETTE_STATO[richiesta.stato].toLowerCase()}.`
    );
  }
  return richiesta;
}

/**
 * Attacca la richiesta al fascicolo di un paziente, creandolo se non c'e'.
 *
 * Alla nascita non lo facciamo sempre, e per un buon motivo: una richiesta
 * arrivata via email puo' averla scritta chiunque, e il nome ricavato
 * dall'indirizzo ("mario.rossi@" → Mario Rossi) e' un indizio, non un'identita'.
 * Registrarlo li' vorrebbe dire riempire l'archivio di persone che forse non
 * esistono. Cosi' pero' quelle richieste restavano appese al nulla: la
 * consegnata che c'era in archivio non compariva nel fascicolo di nessuno.
 *
 * Confermare invece e' un atto: qualcuno ha letto la richiesta, spesso ha anche
 * telefonato, e ha detto di si'. Da quel momento la persona esiste davvero, e i
 * medicinali approvati devono stare nel suo fascicolo accanto alle visite —
 * altrimenti sono foglietti sparsi che al controllo dopo nessuno ritrova.
 */
function collegaAlFascicolo(richiesta) {
  if (richiesta.paziente_id) return null;

  if (telefonoValido(richiesta.telefono)) {
    return trovaOCreaPaziente({
      nome: richiesta.nome, cognome: richiesta.cognome,
      email: richiesta.email, telefono: richiesta.telefono
    }).id;
  }

  // Senza telefono l'unica cosa che identifica davvero la persona e'
  // l'indirizzo. Il nome no: due omonimi senza numero diventerebbero lo stesso
  // fascicolo, ed e' un errore che in un archivio sanitario non si ripara.
  const mail = String(richiesta.email || '').trim().toLowerCase();
  if (!mail) return null;

  const esistente = db.prepare('SELECT id FROM pazienti WHERE lower(email) = ?').get(mail);
  if (esistente) return esistente.id;

  return db.prepare(
    'INSERT INTO pazienti (nome, cognome, email, telefono, creato_il) VALUES (?, ?, ?, ?, ?)'
  ).run(richiesta.nome, richiesta.cognome, mail, '', new Date().toISOString()).lastInsertRowid;
}

/** Scrive il nuovo stato e rimanda indietro la riga aggiornata. */
function applica(richiesta, campi, chi) {
  const colonne = Object.keys(campi).map((c) => `${c} = ?`).join(', ');
  db.prepare(
    `UPDATE richieste_medicine SET ${colonne}, aggiornata_il = ?, gestita_il = ?, gestita_da = ? WHERE id = ?`
  ).run(...Object.values(campi), new Date().toISOString(), new Date().toISOString(), chi || null, richiesta.id);

  const aggiornata = dettaglio(richiesta.id);
  return aggiornata;
}

/**
 * Il paziente riceve una email per ognuna delle tre risposte, ma solo se ha
 * lasciato un indirizzo: molte richieste arrivano con il solo telefono, e
 * quelle si chiudono con una chiamata. Il pannello lo segnala, cosi' chi
 * gestisce sa che quel paziente va avvisato a voce.
 */
const avvisa = (richiesta, componi) => {
  if (richiesta.email) accoda('email', componi(richiesta));
};

/**
 * Aggiorna l'elenco dei medicinali che il paziente prende di solito.
 *
 * Il campo dei farmaci e' testo libero, ma il modulo chiede "un medicinale per
 * riga" e quella e' la regola che si segue qui. Non si prova a interpretare il
 * dosaggio o a riconoscere il principio attivo: sarebbe indovinare su dati
 * clinici, e una riga sbagliata in questo elenco vale meno di zero. Si prende
 * la riga com'e' scritta.
 *
 * Un farmaco gia' presente non si duplica: si aggiorna la data e si conta una
 * volta in piu'. Cosi' l'elenco dice anche quali sono quelli veri, che tornano
 * ogni mese, e quali li ha chiesti una volta sola tre anni fa.
 */
function aggiornaAbituali(richiesta) {
  if (!richiesta.paziente_id || !richiesta.farmaci) return;

  const adesso = new Date().toISOString();
  const righe = String(richiesta.farmaci)
    .split('\n')
    .map((r) => r.trim())
    .filter((r) => r.length >= 2)
    .slice(0, 30);

  for (const farmaco of righe) {
    db.prepare(`
      INSERT INTO medicine_abituali (paziente_id, farmaco, prima_volta, ultima_volta, volte, ultimo_codice)
      VALUES (?, ?, ?, ?, 1, ?)
      ON CONFLICT(paziente_id, lower(farmaco)) DO UPDATE SET
        ultima_volta = excluded.ultima_volta,
        volte = volte + 1,
        ultimo_codice = excluded.ultimo_codice
    `).run(richiesta.paziente_id, farmaco, adesso, adesso, richiesta.codice);
  }
}

// ---- Allegati --------------------------------------------------------------

// Dieci mega bastano a una foto fatta col telefono, anche di quelle grandi, e
// a un PDF di referto. Serve un tetto: senza, una richiesta con un video da
// mezzo giga finirebbe dentro l'archivio, che e' lo stesso file che si copia su
// OneDrive ogni giorno.
export const MASSIMO_BYTE_ALLEGATO = 10 * 1024 * 1024;

// Piu' di cosi' non e' una prescrizione, e' un album. Il tetto protegge anche
// dal caricamento ripetuto per sbaglio, che con le foto capita spesso.
const MASSIMO_ALLEGATI = 5;

/**
 * I formati che si possono aprire dentro il pannello senza rischi.
 *
 * L'elenco e' corto apposta, ed e' il prezzo per poter guardare un documento
 * senza scaricarlo. Mostrare un file dentro la pagina vuol dire darlo in pasto
 * al browser nella sessione di chi ha appena fatto il login: un HTML o un SVG
 * li' dentro eseguono il loro contenuto, e chi carica e' un paziente qualunque
 * arrivato da internet. Immagini e PDF invece il browser li disegna e basta.
 *
 * Ogni voce porta la firma con cui il file si riconosce davvero. Il tipo
 * dichiarato da chi carica non conta niente: e' una cosa che dice lui, e
 * cambiarla costa un secondo.
 */
const FORMATI = [
  { mime: 'image/jpeg', firma: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', firma: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/gif', firma: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', firma: [0x25, 0x50, 0x44, 0x46] },
  // WEBP e HEIC non hanno la firma all'inizio: sta dopo i primi byte di
  // intestazione. I telefoni recenti fotografano in HEIC senza dichiararlo.
  { mime: 'image/webp', firma: [0x57, 0x45, 0x42, 0x50], da: 8 },
  { mime: 'image/heic', firma: [0x66, 0x74, 0x79, 0x70], da: 4 }
];

export const FORMATI_AMMESSI = FORMATI.map((f) => f.mime);

/**
 * Che cosa e' davvero questo file, guardandoci dentro.
 *
 * Fidarsi dell'etichetta vorrebbe dire rifiutare foto buone — i telefoni a
 * volte non dichiarano niente — e accettarne di cattive. La firma sta scritta
 * nei primi byte e non si puo' dichiarare.
 */
function riconosci(contenuto) {
  for (const f of FORMATI) {
    const da = f.da || 0;
    if (contenuto.length < da + f.firma.length) continue;
    if (f.firma.every((b, i) => contenuto[da + i] === b)) return f;
  }
  return null;
}

const NOME_PULITO = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * Attacca un file a una richiesta.
 *
 * Si accettano solo foto e PDF, ed e' un restringimento voluto: lo studio deve
 * poter guardare la prescrizione dentro il pannello senza scaricarla, e per
 * farlo il file finisce dentro la pagina. Li' un HTML o un SVG eseguirebbero il
 * loro contenuto nella sessione di chi ha appena fatto il login.
 *
 * Il formato si riconosce dai byte, non da quello che dichiara chi carica: un
 * file puo' chiamarsi foto.jpg e dire di essere image/jpeg pur essendo altro,
 * mentre la firma dentro non si cambia senza cambiare il file.
 */
export function allegaFile(richiestaId, { nome, contenuto }) {
  const richiesta = dettaglio(richiestaId);
  if (!richiesta) throw new ErroreDominio('Richiesta non trovata.', 404);

  if (!contenuto?.length) throw new ErroreDominio('Il file è vuoto.');
  if (contenuto.length > MASSIMO_BYTE_ALLEGATO) {
    throw new ErroreDominio(
      `Il file è troppo grande: il limite è ${Math.round(MASSIMO_BYTE_ALLEGATO / 1024 / 1024)} MB.`
    );
  }

  const formato = riconosci(contenuto);
  if (!formato) {
    throw new ErroreDominio(
      'Si possono allegare solo foto (JPG, PNG, GIF, WEBP, HEIC) o PDF. '
      + 'Se hai un documento di altro tipo, fotografalo.'
    );
  }

  const quanti = db.prepare('SELECT COUNT(*) AS c FROM allegati WHERE richiesta_id = ?')
    .get(richiestaId).c;
  if (quanti >= MASSIMO_ALLEGATI) {
    throw new ErroreDominio(`Hai già allegato ${MASSIMO_ALLEGATI} file a questa richiesta.`);
  }

  const nomePulito = testoPulito(String(nome || 'documento').replace(NOME_PULITO, '-'), 120)
    || 'documento';

  const info = db.prepare(`
    INSERT INTO allegati (richiesta_id, nome, tipo_mime, byte, contenuto, caricato_il)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(richiestaId, nomePulito, formato.mime,
    contenuto.length, contenuto, new Date().toISOString());

  // L'avviso allo studio aspetta qualche minuto proprio per raccogliere questo
  // file. Se pero' e' gia' partito — perche' il paziente ci ha messo di piu' a
  // trovare la foto — la prescrizione resterebbe solo dentro il pannello, e chi
  // legge la casella non saprebbe nemmeno di doverla andare a cercare.
  if (!avvisoAncoraInCoda(richiestaId)) {
    accoda('email', { ...emailAllegatoTardivo(richiesta), allegatiDi: richiestaId });
  }

  return { id: info.lastInsertRowid, nome: nomePulito, byte: contenuto.length, tipo: formato.mime };
}

/** L'elenco degli allegati, senza il contenuto: quello pesa e serve solo a chi lo apre. */
export const allegatiDi = (richiestaId) => db.prepare(
  'SELECT id, nome, tipo_mime, byte, caricato_il FROM allegati WHERE richiesta_id = ? ORDER BY id'
).all(richiestaId);

/** Gli allegati col contenuto dentro, per attaccarli a una email. */
const allegatiCompleti = (richiestaId) => db.prepare(
  'SELECT nome, tipo_mime, contenuto FROM allegati WHERE richiesta_id = ? ORDER BY id'
).all(richiestaId);

impostaLettoreAllegati(allegatiCompleti);

export const allegato = (id) => db.prepare('SELECT * FROM allegati WHERE id = ?').get(id);

/** I medicinali che questo paziente prende di solito, i piu' recenti per primi. */
export const abitualiDelPaziente = (pazienteId) => db.prepare(`
  SELECT farmaco, prima_volta, ultima_volta, volte, ultimo_codice
    FROM medicine_abituali WHERE paziente_id = ?
   ORDER BY ultima_volta DESC
`).all(pazienteId);

/** Va bene cosi' come l'ha chiesta il paziente. */
export function conferma(codice, chi = null, { numeroRicetta = null } = {}) {
  const richiesta = daGestire(codice, ['nuova']);
  return db.transaction(() => {
    const aggiornata = applica(richiesta, {
      stato: 'confermata',
      numero_ricetta: testoPulito(numeroRicetta, 40) || null,
      paziente_id: collegaAlFascicolo(richiesta) ?? richiesta.paziente_id
    }, chi);
    aggiornaAbituali(aggiornata);
    avvisa(aggiornata, emailMedicinaConfermata);
    return aggiornata;
  })();
}

/** Non si puo' fare. Il motivo finisce nell'email: un no secco non aiuta nessuno. */
export function rifiuta(codice, motivo, chi = null) {
  const richiesta = daGestire(codice, ['nuova']);
  return db.transaction(() => {
    const aggiornata = applica(
      richiesta,
      { stato: 'rifiutata', motivo_rifiuto: testoPulito(motivo, 300) || null },
      chi
    );
    avvisa(aggiornata, emailMedicinaRifiutata);
    return aggiornata;
  })();
}

/**
 * Si accetta, ma cambiando qualcosa: e' il caso della telefonata al paziente.
 *
 * La richiesta di partenza va conservata prima di sovrascriverla, altrimenti
 * l'email non potrebbe dire *che cosa* e' cambiato e il paziente si ritroverebbe
 * scritto un elenco diverso da quello che ricorda di aver chiesto. Si salva solo
 * la prima volta: il confronto utile e' sempre con quello che aveva chiesto lui.
 *
 * Si puo' modificare anche una richiesta gia' confermata — capita che la
 * farmacia non abbia un farmaco e si debba richiamare il paziente. Una
 * richiesta rifiutata o gia' ritirata invece e' chiusa.
 */
export function modifica(codice, correzioni = {}, chi = null) {
  const richiesta = daGestire(codice, ['nuova', 'confermata']);

  const farmaci = testoPulito(correzioni.farmaci ?? richiesta.farmaci, 1500);
  if (farmaci.length < 2) throw new ErroreDominio('Indica quali medicinali sono stati approvati.');

  const note = testoPulito(correzioni.note ?? richiesta.note, 500) || null;
  const ambulatorio = correzioni.ambulatorio_id
    ? trovaAmbulatorio(correzioni.ambulatorio_id)
    : null;

  const numeroRicetta = correzioni.numero_ricetta !== undefined
    ? (testoPulito(correzioni.numero_ricetta, 40) || null)
    : (richiesta.numero_ricetta ?? null);

  // Aggiungere il numero della ricetta e' una modifica come le altre: capita di
  // confermare prima e inserirla nel fascicolo dopo, e senza questo il pannello
  // direbbe "non hai cambiato niente" proprio mentre si sta aggiungendo il
  // pezzo che serve al paziente per ritirare.
  if (farmaci === richiesta.farmaci && note === richiesta.note && !ambulatorio
      && numeroRicetta === (richiesta.numero_ricetta ?? null)) {
    throw new ErroreDominio('Non hai cambiato niente: usa Conferma se la richiesta va bene così.');
  }

  return db.transaction(() => {
    const aggiornata = applica(richiesta, {
      farmaci,
      note,
      ambulatorio_id: ambulatorio?.id ?? richiesta.ambulatorio_id,
      farmaci_originali: richiesta.farmaci_originali ?? richiesta.farmaci,
      note_originali: richiesta.farmaci_originali ? richiesta.note_originali : richiesta.note,
      stato: 'confermata',
      numero_ricetta: numeroRicetta,
      paziente_id: collegaAlFascicolo(richiesta) ?? richiesta.paziente_id
    }, chi);

    aggiornaAbituali(aggiornata);
    avvisa(aggiornata, emailMedicinaModificata);
    return aggiornata;
  })();
}

/**
 * Il paziente e' passato a ritirare. Nessuna email: se ne e' appena andato,
 * un messaggio che gli dice quello che ha appena fatto sarebbe solo rumore.
 */
export function segnaConsegnata(codice, chi = null) {
  const richiesta = daGestire(codice, ['confermata']);
  return db.transaction(() => applica(richiesta, { stato: 'consegnata' }, chi))();
}

export function elencoAdmin({ stato, tipo, cerca, pagina = 1, perPagina = 50 } = {}) {
  const dove = [];
  const par = [];

  if (stato) { dove.push('r.stato = ?'); par.push(stato); }

  /**
   * Una richiesta chiusa resta in vista un giorno, poi sgombera.
   *
   * Il giorno serve: chi ha confermato una ricetta la mattina vuole ritrovarla
   * il pomeriggio se il paziente richiama, e vederla sparire nell'istante in cui
   * si preme il bottone e' peggio che tenersela. Passate le ventiquattro ore
   * pero' e' storia, e la storia ha il suo posto: la scheda del paziente, dove
   * si va a cercarla quando serve davvero — mesi dopo, non lo stesso giorno.
   *
   * Sparisce dalla vista, non dall'archivio. Chi la vuole rivedere mette il
   * filtro sullo stato e la ritrova tutta, e la scheda del paziente non ne
   * perde nemmeno una. Anche una ricerca per nome le riporta tutte: chi scrive
   * un cognome nella casella sta cercando la storia di quella persona, e
   * nascondergliene meta' sarebbe il contrario di quello che ha chiesto.
   */
  if (!stato && !cerca) {
    dove.push(`(r.stato = 'nuova'
                OR datetime(COALESCE(r.gestita_il, r.aggiornata_il, r.creata_il))
                   >= datetime('now', '-1 day'))`);
  }

  // Senza tipo si vede tutto, ed e' voluto: chi apre la scheda al mattino vuole
  // sapere cosa c'e' da fare, non da fare di che genere.
  if (tipo && Object.hasOwn(TIPI, tipo)) { dove.push('r.tipo = ?'); par.push(tipo); }
  if (cerca) {
    dove.push('(r.nome LIKE ? OR r.cognome LIKE ? OR r.telefono LIKE ? OR r.email LIKE ? OR r.farmaci LIKE ? OR r.codice LIKE ?)');
    const q = `%${cerca}%`;
    par.push(q, q, q, q, q, q.toUpperCase());
  }

  const filtro = dove.length ? `WHERE ${dove.join(' AND ')}` : '';
  const totale = db.prepare(`SELECT COUNT(*) AS n FROM richieste_medicine r ${filtro}`).get(...par).n;

  const limite = Math.min(Math.max(Number(perPagina) || 50, 1), 200);
  const offset = (Math.max(Number(pagina) || 1, 1) - 1) * limite;

  const righe = db.prepare(
    `${SELECT_COMPLETO} ${filtro} ORDER BY
       CASE r.stato WHEN 'nuova' THEN 0 WHEN 'confermata' THEN 1 ELSE 2 END,
       r.creata_il DESC
     LIMIT ? OFFSET ?`
  ).all(...par, limite, offset);

  // Gli allegati vengono attaccati qui e non con una JOIN: sono pochi per
  // richiesta e una riga per allegato moltiplicherebbe le richieste stesse.
  // Il contenuto non entra mai in questo elenco, solo nome e dimensione.
  for (const r of righe) r.allegati = allegatiDi(r.id);

  return { richieste: righe, totale, pagina: Number(pagina) || 1, pagine: Math.ceil(totale / limite) || 1 };
}
