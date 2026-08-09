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
-- E' parziale: uno slot annullato torna liberamente disponibile.
CREATE UNIQUE INDEX IF NOT EXISTS idx_slot_unico
  ON prenotazioni(ambulatorio_id, data, ora_inizio)
  WHERE stato = 'confermata';

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
  stato         TEXT NOT NULL DEFAULT 'nuova',  -- nuova | in_lavorazione | pronta | consegnata | annullata
  creata_il     TEXT NOT NULL,
  aggiornata_il TEXT
);
CREATE INDEX IF NOT EXISTS idx_medicine_stato ON richieste_medicine(stato);
CREATE INDEX IF NOT EXISTS idx_medicine_data  ON richieste_medicine(creata_il);

-- Coda di consegna: ogni effetto esterno (email, Foglio Google) viene prima
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

-- Ogni email che arriva e non e' una nostra notifica viene salvata qui, sempre,
-- anche quando non si capisce cosa chieda. E' la rete di sicurezza: meglio una
-- richiesta da smistare a mano che una richiesta persa.
CREATE TABLE IF NOT EXISTS richieste_email (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  codice       TEXT NOT NULL UNIQUE,
  message_id   TEXT,
  mittente     TEXT NOT NULL,
  mittente_nome TEXT,
  oggetto      TEXT,
  corpo        TEXT NOT NULL,
  tipo         TEXT NOT NULL DEFAULT 'altro',   -- prenotazione | medicina | altro
  stato        TEXT NOT NULL DEFAULT 'nuova',   -- nuova | gestita | archiviata
  collegata_a  TEXT,                            -- codice della richiesta generata
  ricevuta_il  TEXT NOT NULL,
  gestita_il   TEXT
);
CREATE INDEX IF NOT EXISTS idx_richieste_email_stato ON richieste_email(stato);

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
  ['utenti', 'ultimo_accesso', 'TEXT']
]) {
  const presente = db.prepare(`PRAGMA table_info(${tabella})`).all().some((c) => c.name === colonna);
  if (!presente) db.exec(`ALTER TABLE ${tabella} ADD COLUMN ${colonna} ${tipo}`);
}

const AMBULATORI_INIZIALI = [
  {
    id: 1,
    nome: 'Ambulatorio di Arceto',
    indirizzo: 'Via Piazza Castello, 10 - Arceto',
    telefono: '0522980035',
    orari: { 1: ['10:30', '13:00'], 2: ['10:30', '13:00'], 3: ['17:00', '19:00'], 4: ['10:30', '13:00'], 5: ['10:30', '13:00'] }
  },
  {
    id: 2,
    nome: 'Ambulatorio di Casalgrande',
    indirizzo: 'Via Canale, 29 - Casalgrande',
    telefono: '3472450118',
    orari: { 1: ['17:00', '19:00'], 3: ['08:30', '10:00'], 4: ['17:00', '19:00'], 5: ['08:30', '10:00'] }
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

export function chiudiDb() {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch { /* gia' chiuso */ }
}
