import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });

export const db = new Database(config.dbFile);

// WAL permette a molti lettori di lavorare mentre uno scrive: e' cio' che
// regge le richieste contemporanee senza bloccare i pazienti.
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS ambulatori (
  id            INTEGER PRIMARY KEY,
  nome          TEXT NOT NULL,
  indirizzo     TEXT NOT NULL,
  telefono      TEXT NOT NULL,
  attivo        INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orari (
  ambulatorio_id INTEGER NOT NULL REFERENCES ambulatori(id) ON DELETE CASCADE,
  giorno         INTEGER NOT NULL,          -- 0 = domenica ... 6 = sabato
  ora_inizio     TEXT,                      -- 'HH:MM', NULL = chiuso
  ora_fine       TEXT,
  PRIMARY KEY (ambulatorio_id, giorno)
);

CREATE TABLE IF NOT EXISTS pazienti (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  nome       TEXT NOT NULL,
  cognome    TEXT NOT NULL,
  email      TEXT,
  telefono   TEXT NOT NULL,
  creato_il  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pazienti_telefono ON pazienti(telefono);
CREATE INDEX IF NOT EXISTS idx_pazienti_email    ON pazienti(email);

CREATE TABLE IF NOT EXISTS utenti (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  ruolo         TEXT NOT NULL DEFAULT 'paziente',
  paziente_id   INTEGER REFERENCES pazienti(id),
  creato_il     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessioni (
  token_hash TEXT PRIMARY KEY,
  utente_id  INTEGER NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
  scade_il   TEXT NOT NULL,
  creato_il  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessioni_scadenza ON sessioni(scade_il);

-- Stato operativo piccolo e non sensibile: recovery monouso e cursori delle
-- integrazioni devono sopravvivere ai riavvii del processo.
CREATE TABLE IF NOT EXISTS impostazioni (
  chiave        TEXT PRIMARY KEY,
  valore        TEXT,
  aggiornata_il TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cursori_integrazioni (
  chiave        TEXT PRIMARY KEY,
  ultima_riga   INTEGER NOT NULL DEFAULT 1,
  aggiornata_il TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prenotazioni (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  codice             TEXT NOT NULL UNIQUE,
  ambulatorio_id     INTEGER NOT NULL REFERENCES ambulatori(id),
  data               TEXT NOT NULL,          -- YYYY-MM-DD
  ora_inizio         TEXT NOT NULL,          -- HH:MM
  ora_fine           TEXT NOT NULL,
  paziente_id        INTEGER NOT NULL REFERENCES pazienti(id),
  problema           TEXT NOT NULL,
  stato              TEXT NOT NULL DEFAULT 'confermata',
  annullata_da       TEXT,
  annullata_il       TEXT,
  evento_calendar_id TEXT,
  origine            TEXT NOT NULL DEFAULT 'sito',
  promemoria_il      TEXT,
  creata_il          TEXT NOT NULL
);

-- Il vincolo che rende impossibile la doppia prenotazione dello stesso slot.
-- E' parziale: uno slot annullato o rifiutato torna liberamente disponibile.
-- Copre anche 'in_attesa': una richiesta ancora da confermare tiene occupato
-- il posto, cosi' due pazienti non chiedono lo stesso orario e lo studio non
-- si ritrova a smaltire richieste doppie sullo stesso slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_slot_unico
  ON prenotazioni(ambulatorio_id, data, ora_inizio)
  WHERE stato IN ('confermata', 'in_attesa');

CREATE INDEX IF NOT EXISTS idx_prenotazioni_data     ON prenotazioni(data);
CREATE INDEX IF NOT EXISTS idx_prenotazioni_paziente ON prenotazioni(paziente_id);

-- Ferie, festivi e chiusure straordinarie. ambulatorio_id NULL = chiudono entrambi.
CREATE TABLE IF NOT EXISTS chiusure (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ambulatorio_id INTEGER REFERENCES ambulatori(id) ON DELETE CASCADE,
  dal            TEXT NOT NULL,          -- YYYY-MM-DD
  al             TEXT NOT NULL,
  motivo         TEXT,
  creata_il      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chiusure_periodo ON chiusure(dal, al);

-- Chi vuole essere avvisato se si libera un posto in un certo giorno.
CREATE TABLE IF NOT EXISTS lista_attesa (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  codice         TEXT NOT NULL UNIQUE,
  ambulatorio_id INTEGER NOT NULL REFERENCES ambulatori(id),
  data           TEXT NOT NULL,
  paziente_id    INTEGER NOT NULL REFERENCES pazienti(id),
  problema       TEXT NOT NULL,
  stato          TEXT NOT NULL DEFAULT 'in_attesa',  -- in_attesa | avvisato | chiusa
  avvisato_il    TEXT,
  creata_il      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attesa_ricerca ON lista_attesa(data, ambulatorio_id, stato);

CREATE TABLE IF NOT EXISTS richieste_medicine (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  codice        TEXT NOT NULL UNIQUE,
  paziente_id   INTEGER REFERENCES pazienti(id),
  nome          TEXT NOT NULL,
  cognome       TEXT NOT NULL,
  telefono      TEXT,
  email         TEXT,
  farmaci       TEXT NOT NULL,
  note          TEXT,
  ambulatorio_id INTEGER REFERENCES ambulatori(id),
  origine       TEXT NOT NULL DEFAULT 'sito',   -- sito | email | chatbot
  stato         TEXT NOT NULL DEFAULT 'nuova',  -- nuova | confermata | rifiutata | consegnata
  creata_il     TEXT NOT NULL,
  aggiornata_il TEXT
);
CREATE INDEX IF NOT EXISTS idx_medicine_stato ON richieste_medicine(stato);
CREATE INDEX IF NOT EXISTS idx_medicine_data  ON richieste_medicine(creata_il);

-- I medicinali che un paziente prende di solito.
--
-- Non e' l'elenco delle richieste: quello e' la storia, riga per riga, e per
-- sapere cosa prende oggi una persona bisognerebbe leggersela tutta e capire
-- da soli cosa e' ancora in corso. Questa invece e' la risposta breve, quella
-- che serve quando si ha la scheda aperta davanti e il paziente al telefono.
--
-- Si riempie da sola: ogni volta che una richiesta viene confermata, i farmaci
-- che ci sono dentro finiscono qui. Se un farmaco c'era gia' non si duplica, si
-- aggiorna la data, e cosi' l'elenco dice anche da quanto tempo uno non lo
-- chiede piu'.
CREATE TABLE IF NOT EXISTS medicine_abituali (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  paziente_id   INTEGER NOT NULL REFERENCES pazienti(id),
  farmaco       TEXT NOT NULL,
  prima_volta   TEXT NOT NULL,
  ultima_volta  TEXT NOT NULL,
  volte         INTEGER NOT NULL DEFAULT 1,
  ultimo_codice TEXT
);
-- Un farmaco per paziente, scritto sempre allo stesso modo: senza questo
-- vincolo "Cardioaspirin 100" e "cardioaspirin 100" diventerebbero due voci.
CREATE UNIQUE INDEX IF NOT EXISTS idx_abituali_unico
  ON medicine_abituali(paziente_id, lower(farmaco));

-- Le foto delle prescrizioni degli specialisti, e qualsiasi altro documento che
-- il paziente allega alla sua richiesta.
--
-- Il contenuto sta QUI DENTRO, non in una cartella accanto, ed e' una scelta
-- deliberata: tutto quello che protegge questo archivio protegge un file solo.
-- La copia di sicurezza usa l'API di backup di SQLite e finisce su OneDrive; i
-- file su disco resterebbero fuori da entrambe, e ce ne accorgeremmo il giorno
-- in cui servono. Un documento sanitario che esiste in una copia sola, su un
-- disco solo, non e' archiviato: e' in prestito.
--
-- Il prezzo e' che l'archivio cresce. Con qualche foto a settimana resta
-- comunque un file piccolo, e vale lo scambio.
CREATE TABLE IF NOT EXISTS allegati (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  richiesta_id INTEGER NOT NULL REFERENCES richieste_medicine(id) ON DELETE CASCADE,
  nome         TEXT NOT NULL,
  tipo_mime    TEXT,
  byte         INTEGER NOT NULL,
  contenuto    BLOB NOT NULL,
  caricato_il  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_allegati_richiesta ON allegati(richiesta_id);

-- Coda di consegna: ogni effetto esterno (le email ai pazienti) viene prima
-- scritto qui dentro nella stessa transazione del dato. Se il servizio esterno
-- e' spento o irraggiungibile la riga resta in attesa e viene ritentata:
-- e' il meccanismo che garantisce che nessuna richiesta vada persa.
CREATE TABLE IF NOT EXISTS outbox (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo               TEXT NOT NULL,
  payload            TEXT NOT NULL,
  stato              TEXT NOT NULL DEFAULT 'in_attesa',
  tentativi          INTEGER NOT NULL DEFAULT 0,
  ultimo_errore      TEXT,
  prossimo_tentativo TEXT NOT NULL,
  creato_il          TEXT NOT NULL,
  completato_il      TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_lavorabili ON outbox(stato, prossimo_tentativo);

-- Evita di elaborare due volte la stessa email in arrivo.
CREATE TABLE IF NOT EXISTS email_processate (
  message_id  TEXT PRIMARY KEY,
  ricevuta_il TEXT NOT NULL,
  esito       TEXT NOT NULL,
  riferimento TEXT
);

CREATE TABLE IF NOT EXISTS chat_sessioni (
  id              TEXT PRIMARY KEY,
  stato_json      TEXT,
  creata_il       TEXT NOT NULL,
  ultima_attivita TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messaggi (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sessione_id TEXT NOT NULL REFERENCES chat_sessioni(id) ON DELETE CASCADE,
  ruolo       TEXT NOT NULL,
  testo       TEXT NOT NULL,
  creato_il   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messaggi ON chat_messaggi(sessione_id, id);
`);

// Colonne aggiunte dopo il primo rilascio: su un database gia' esistente
// CREATE TABLE non viene rieseguito, quindi vanno aggiunte a mano.
for (const [tabella, colonna, tipo] of [
  ['prenotazioni', 'promemoria_il', 'TEXT'],
  // Accessi personali dei collaboratori.
  ['utenti', 'nome', 'TEXT'],
  // Sospeso invece che cancellato: chi si licenzia perde l'accesso subito,
  // ma resta scritto che quell'account e' esistito.
  ['utenti', 'attivo', 'INTEGER NOT NULL DEFAULT 1'],
  // Password provvisoria da cambiare al primo ingresso: cosi' la password
  // vera la conosce solo il collaboratore, nemmeno il medico.
  ['utenti', 'cambio_password', 'INTEGER NOT NULL DEFAULT 0'],
  ['utenti', 'ultimo_accesso', 'TEXT'],
  // Le medicine non si "lavorano" piu': si confermano, si rifiutano o si
  // cambiano dopo una telefonata. Queste colonne tengono il perche' di un
  // rifiuto e la memoria di com'era la richiesta prima di essere corretta,
  // che serve per dire al paziente che cosa e' cambiato.
  ['richieste_medicine', 'motivo_rifiuto', 'TEXT'],
  ['richieste_medicine', 'farmaci_originali', 'TEXT'],
  ['richieste_medicine', 'note_originali', 'TEXT'],
  ['richieste_medicine', 'gestita_il', 'TEXT'],
  ['richieste_medicine', 'gestita_da', 'TEXT'],
  // Spostare un appuntamento non e' annullarlo: la prenotazione resta la
  // stessa e resta 'confermata'. Qui si tiene da dove e' partita, che serve
  // per dire al paziente qual era il vecchio appuntamento.
  //
  // Uno stato 'riprogrammata' sarebbe stato un errore: idx_slot_unico vale
  // solo WHERE stato = 'confermata', quindi una prenotazione spostata avrebbe
  // perso la protezione contro la doppia prenotazione, e sarebbe sparita da
  // agenda, promemoria e conteggi, che filtrano tutti sullo stesso valore.
  ['prenotazioni', 'data_originale', 'TEXT'],
  ['prenotazioni', 'ora_originale', 'TEXT'],
  ['prenotazioni', 'riprogrammata_il', 'TEXT'],
  ['prenotazioni', 'riprogrammata_da', 'TEXT'],
  // Le visite chieste dal sito o dal chatbot nascono 'in_attesa': sono
  // richieste, non prenotazioni gia' valide, e lo studio le conferma o le
  // rifiuta dal pannello. Qui si tiene chi e quando le ha confermate, e il
  // perche' di un rifiuto — che finisce nell'email al paziente.
  ['prenotazioni', 'confermata_il', 'TEXT'],
  ['prenotazioni', 'confermata_da', 'TEXT'],
  ['prenotazioni', 'motivo_rifiuto', 'TEXT'],
  // Chi ha annullato, di persona. Diverso da annullata_da, che vale solo
  // 'admin' o 'paziente' e serve a dire al paziente se e' stato lo studio o lui
  // stesso: quella distinzione finisce nell'email e non si tocca.
  //
  // Qui invece resta l'indirizzo di chi ha premuto il pulsante. Il pannello lo
  // usano in tre, e senza questa colonna la domanda "chi ha annullato la visita
  // della signora?" non aveva risposta da nessuna parte, mentre per gli
  // spostamenti l'aveva.
  ['prenotazioni', 'annullata_utente', 'TEXT'],
  // Il numero della ricetta elettronica, quello che il fascicolo restituisce
  // dopo che il medico l'ha inserita. Da quando il ritiro avviene in farmacia
  // e' il pezzo che serve davvero al paziente: senza, al banco non gli danno
  // niente. Lo scrive lo studio al momento della conferma e finisce nella sua
  // email, che e' l'unico posto dove poi va a cercarlo.
  ['richieste_medicine', 'numero_ricetta', 'TEXT'],
  // Che cosa sta chiedendo il paziente: medicinali, una visita specialistica o
  // degli esami del sangue.
  //
  // Sono tre cose diverse per lui e una sola per il programma: chiede, lo studio
  // guarda e risponde, parte l'email con il numero. Tenerle in una tabella sola
  // con un tipo, invece che in tre tabelle gemelle, vuol dire che una correzione
  // al modo di confermare vale per tutte e tre — e che nessuno si dimentica di
  // riportarla nelle altre due.
  //
  // Il valore predefinito e' 'medicina' perche' tutto quello che c'era prima di
  // questa colonna era una richiesta di medicinali.
  ['richieste_medicine', 'tipo', "TEXT NOT NULL DEFAULT 'medicina'"],
  // Quando questa persona ha smesso di essere in carico allo studio: ha
  // cambiato medico, si e' trasferita, non c'e' piu'.
  //
  // Non e' una cancellazione ed e' voluto. Sparisce dagli elenchi, dalla
  // ricerca e dai conteggi — chi lavora non se la trova piu' fra i piedi — ma
  // visite, richieste e ricette restano dove sono. Se fra due anni arriva una
  // contestazione, o l'ASL chiede conto di una prescrizione, la storia c'e'
  // ancora; una riga cancellata non si spiega piu' a nessuno.
  //
  // Per cancellare davvero c'e' un'altra strada, esplicita e separata.
  ['pazienti', 'dimesso_il', 'TEXT'],
  // Verifica dell'indirizzo email per gli account paziente. Senza, chi conosce
  // l'email o il telefono di un paziente potrebbe registrarsi al suo posto e
  // rivendicare la sua scheda. Finche' email_verificata = 0 l'account non entra
  // e non e' collegato a nessuna scheda preesistente.
  ['utenti', 'email_verificata', 'INTEGER NOT NULL DEFAULT 0'],
  ['utenti', 'token_verifica', 'TEXT'],
  ['utenti', 'token_verifica_scade', 'TEXT'],
  // La scheda paziente esistente che l'account rivendica: il collegamento
  // scatta solo dopo la verifica dell'email, non alla registrazione.
  ['utenti', 'scheda_da_collegare', 'INTEGER'],
  // Una chiusura puo' coprire solo una fascia oraria invece dell'intera
  // giornata: ora_inizio/ora_fine a NULL = tutto il giorno (com'era prima).
  ['chiusure', 'ora_inizio', 'TEXT'],
  ['chiusure', 'ora_fine', 'TEXT']
]) {
  const presente = db.prepare(`PRAGMA table_info(${tabella})`).all().some((c) => c.name === colonna);
  if (!presente) db.exec(`ALTER TABLE ${tabella} ADD COLUMN ${colonna} ${tipo}`);
}

// idx_slot_unico prima copriva solo 'confermata'. Da quando le visite dal sito
// nascono 'in_attesa', il vincolo deve valere anche per quelle, altrimenti due
// pazienti possono chiedere lo stesso slot. Su un database gia' esistente
// l'indice non viene ricreato da CREATE INDEX IF NOT EXISTS: va rifatto qui.
// A vuoto non fa niente: dopo la prima volta la definizione contiene gia'
// 'in_attesa' e la si lascia com'e'.
{
  const def = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_slot_unico'"
  ).get();
  if (def && !/in_attesa/.test(def.sql)) {
    db.exec("DROP INDEX idx_slot_unico");
    db.exec(`CREATE UNIQUE INDEX idx_slot_unico
      ON prenotazioni(ambulatorio_id, data, ora_inizio)
      WHERE stato IN ('confermata', 'in_attesa')`);
  }
}

// Gli account che esistevano prima della verifica email — il medico, la
// segreteria, gli eventuali pazienti gia' registrati — restano validi: la
// colonna nasce a 0, ma vanno segnati verificati una volta sola, altrimenti al
// primo riavvio si troverebbero l'accesso chiuso. Si fa alla prima esecuzione
// di questa versione e non piu': i nuovi account partono da 0.
if (!db.prepare("SELECT valore FROM impostazioni WHERE chiave = 'verifica_email_introdotta'").get()) {
  db.prepare('UPDATE utenti SET email_verificata = 1 WHERE token_verifica IS NULL').run();
  db.prepare("INSERT INTO impostazioni (chiave, valore, aggiornata_il) VALUES ('verifica_email_introdotta', ?, ?)")
    .run(new Date().toISOString(), new Date().toISOString());
}

/**
 * Stati delle medicine, da cinque a quattro.
 *
 * "in lavorazione" e "pronta" raccontavano il lavoro dello studio; adesso
 * conta la risposta data al paziente, che e' l'unica cosa che lui vede
 * arrivare per email. Le righe gia' scritte vanno portate nel nuovo giro,
 * altrimenti resterebbero in uno stato che il pannello non sa piu' mostrare.
 *
 * Si esegue a ogni avvio ed e' innocua a vuoto: dopo la prima volta non
 * trova piu' niente da cambiare.
 */
for (const [vecchio, nuovo] of [
  // Era stata presa in carico ma non ancora evasa: torna fra quelle da vedere.
  ['in_lavorazione', 'nuova'],
  // La ricetta c'era: per il paziente equivale a un si'.
  ['pronta', 'confermata'],
  // Un no detto con un'altra parola.
  ['annullata', 'rifiutata']
]) {
  db.prepare('UPDATE richieste_medicine SET stato = ? WHERE stato = ?').run(nuovo, vecchio);
}

/**
 * Collega le vecchie richieste al fascicolo solo quando il dato e' univoco.
 * Email e telefono possono mancare o essere duplicati: in quel caso non si
 * indovina. La riga resta senza proprietario e la puo' gestire solo lo staff.
 */
const senzaProprietario = db.prepare(`
  SELECT id, lower(trim(coalesce(email, ''))) AS email,
         replace(replace(replace(replace(replace(coalesce(telefono, ''),
           ' ', ''), '.', ''), '-', ''), '(', ''), ')', '') AS telefono
    FROM richieste_medicine WHERE paziente_id IS NULL
`).all();
const pazientiPerEmail = db.prepare('SELECT id FROM pazienti WHERE lower(trim(coalesce(email, \'\'))) = ?');
const pazientiPerTelefono = db.prepare(`
  SELECT id FROM pazienti WHERE replace(replace(replace(replace(replace(
    coalesce(telefono, ''), ' ', ''), '.', ''), '-', ''), '(', ''), ')', '') = ?
`);
const collegaRichiesta = db.prepare(
  'UPDATE richieste_medicine SET paziente_id = ? WHERE id = ? AND paziente_id IS NULL'
);

db.transaction(() => {
  for (const r of senzaProprietario) {
    const perEmail = r.email ? pazientiPerEmail.all(r.email) : [];
    const perTelefono = r.telefono ? pazientiPerTelefono.all(r.telefono) : [];
    if (perEmail.length > 1 || perTelefono.length > 1) continue;
    const candidati = [...new Set([...perEmail, ...perTelefono].map((p) => p.id))];
    if (candidati.length === 1) collegaRichiesta.run(candidati[0], r.id);
  }
})();

const AMBULATORI_INIZIALI = [
  {
    id: 1,
    nome: 'Ambulatorio di Arceto',
    indirizzo: 'Via Piazza Castello, 10 - Arceto',
    telefono: '3291545236',
    orari: { 1: ['11:00', '13:00'], 2: ['11:00', '13:00'], 3: ['17:30', '19:00'], 4: ['11:00', '13:00'], 5: ['11:00', '13:00'] }
  },
  {
    id: 2,
    nome: 'Ambulatorio di Casalgrande',
    indirizzo: 'Via Canale, 29 - Casalgrande',
    telefono: '3472450118',
    orari: { 1: ['17:30', '19:00'], 3: ['08:30', '10:00'], 4: ['17:30', '19:00'], 5: ['08:30', '10:00'] }
  }
];

const seed = db.transaction(() => {
  const insAmb = db.prepare(
    'INSERT OR IGNORE INTO ambulatori (id, nome, indirizzo, telefono) VALUES (?, ?, ?, ?)'
  );
  const insOra = db.prepare(
    'INSERT OR IGNORE INTO orari (ambulatorio_id, giorno, ora_inizio, ora_fine) VALUES (?, ?, ?, ?)'
  );
  for (const a of AMBULATORI_INIZIALI) {
    insAmb.run(a.id, a.nome, a.indirizzo, a.telefono);
    for (let giorno = 0; giorno <= 6; giorno++) {
      const o = a.orari[giorno];
      insOra.run(a.id, giorno, o ? o[0] : null, o ? o[1] : null);
    }
  }
});
seed();

// Orario di apertura ritoccato dopo il primo rilascio: la mattina di Arceto
// apre alle 11:00 invece che alle 10:30 (via gli slot 10:30 e 10:45); le sere
// (Arceto il mercoledi', Casalgrande lunedi' e giovedi') aprono alle 17:30
// invece che alle 17:00 (via 17:00 e 17:15). Si aggiorna solo dove c'e' ancora
// il valore vecchio: dopo la prima volta non trova piu' niente da cambiare.
db.prepare(
  "UPDATE orari SET ora_inizio = '11:00' WHERE ambulatorio_id = 1 AND ora_inizio = '10:30' AND ora_fine = '13:00'"
).run();
db.prepare(
  "UPDATE orari SET ora_inizio = '17:30' WHERE ora_inizio = '17:00' AND ora_fine = '19:00'"
).run();

export function chiudiDb() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch { /* gia' chiuso */ }
}
