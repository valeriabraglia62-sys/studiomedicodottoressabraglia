import { db } from './db.js';
import { accoda } from './outbox.js';
import { trovaAmbulatorio } from './orari.js';
import {
  ErroreDominio, generaCodice, trovaOCreaPaziente, telefonoValido, emailValida
} from './prenotazioni.js';
import {
  emailNuovaMedicinaAdmin, emailRicevutaMedicinaPaziente,
  emailMedicinaConfermata, emailMedicinaRifiutata, emailMedicinaModificata
} from './mailer.js';

/**
 * Il giro di una richiesta di medicinali.
 *
 *   nuova ──┬─ conferma ──────────► confermata ── ritiro ──► consegnata
 *           ├─ modifica ──────────► confermata
 *           └─ rifiuta ───────────► rifiutata
 *
 * Gli stati raccontano la risposta data al paziente, non il lavoro dello
 * studio: sono le stesse tre parole che gli arrivano per email. "Modifica"
 * non e' uno stato a se' perche' cambiare una richiesta vuol dire accettarla
 * cambiando qualcosa, e al paziente interessa sapere che e' stata accolta.
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
    vuoto: 'Indica di quale visita specialistica hai bisogno.'
  },
  esami: {
    prefisso: 'ESA',
    etichetta: 'Esami del sangue',
    cosaChiede: 'esami del sangue',
    vuoto: 'Indica quali esami ti servono, o allega la richiesta dello specialista.'
  }
};

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
      ? trovaOCreaPaziente({ nome, cognome, email, telefono },
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

    accoda('sheet_medicina', richiesta);
    accoda('email', emailNuovaMedicinaAdmin(richiesta));
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
  accoda('sheet_medicina', aggiornata);
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

const NOME_PULITO = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * Attacca un file a una richiesta.
 *
 * Si accetta qualunque tipo, come chiesto: il paziente fotografa la
 * prescrizione con quello che ha, e discutere di formati con chi sta cercando
 * di mandarci un documento e' il modo migliore per non riceverlo. Quello che
 * NON si fa e' fidarsi di come si chiama o di cosa dice di essere: il nome
 * viene ripulito dai caratteri che sui percorsi combinano guai, e il tipo
 * dichiarato dal browser si tiene solo per sapere come mostrarlo.
 */
export function allegaFile(richiestaId, { nome, tipoMime, contenuto }) {
  const richiesta = dettaglio(richiestaId);
  if (!richiesta) throw new ErroreDominio('Richiesta non trovata.', 404);

  if (!contenuto?.length) throw new ErroreDominio('Il file è vuoto.');
  if (contenuto.length > MASSIMO_BYTE_ALLEGATO) {
    throw new ErroreDominio(
      `Il file è troppo grande: il limite è ${Math.round(MASSIMO_BYTE_ALLEGATO / 1024 / 1024)} MB.`
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
  `).run(richiestaId, nomePulito, testoPulito(tipoMime, 120) || null,
    contenuto.length, contenuto, new Date().toISOString());

  return { id: info.lastInsertRowid, nome: nomePulito, byte: contenuto.length };
}

/** L'elenco degli allegati, senza il contenuto: quello pesa e serve solo a chi lo apre. */
export const allegatiDi = (richiestaId) => db.prepare(
  'SELECT id, nome, tipo_mime, byte, caricato_il FROM allegati WHERE richiesta_id = ? ORDER BY id'
).all(richiestaId);

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

  return { richieste: righe, totale, pagina: Number(pagina) || 1, pagine: Math.ceil(totale / limite) || 1 };
}
