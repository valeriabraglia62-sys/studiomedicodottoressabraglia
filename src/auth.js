import crypto from 'crypto';
import { db } from './db.js';
import { config } from './config.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const DURATA_SESSIONE_GIORNI = 30;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verificaPassword(password, stored) {
  if (!stored || !password) return false;
  const [algo, saltHex, hashHex] = stored.split('$');
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false;
  const atteso = Buffer.from(hashHex, 'hex');
  const calcolato = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), atteso.length, SCRYPT);
  return crypto.timingSafeEqual(atteso, calcolato);
}

const hashToken = (token) =>
  crypto.createHmac('sha256', config.sessionSecret).update(token).digest('hex');

export function creaSessione(utenteId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ora = new Date();
  const scadenza = new Date(ora.getTime() + DURATA_SESSIONE_GIORNI * 86400000);
  db.prepare(
    'INSERT INTO sessioni (token_hash, utente_id, scade_il, creato_il) VALUES (?, ?, ?, ?)'
  ).run(hashToken(token), utenteId, scadenza.toISOString(), ora.toISOString());
  return { token, scadenza };
}

export function utenteDaToken(token) {
  if (!token) return null;
  const riga = db.prepare(`
    SELECT u.id, u.email, u.nome, u.ruolo, u.paziente_id, u.attivo, u.cambio_password, s.scade_il
      FROM sessioni s
      JOIN utenti u ON u.id = s.utente_id
     WHERE s.token_hash = ?
  `).get(hashToken(token));

  if (!riga) return null;
  if (new Date(riga.scade_il) < new Date()) {
    db.prepare('DELETE FROM sessioni WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  // Un account sospeso non vale piu' niente, nemmeno con un token ancora buono.
  if (riga.attivo === 0) return null;

  return {
    id: riga.id,
    email: riga.email,
    nome: riga.nome || '',
    ruolo: riga.ruolo,
    paziente_id: riga.paziente_id,
    deve_cambiare_password: Boolean(riga.cambio_password)
  };
}

export function eliminaSessione(token) {
  if (token) db.prepare('DELETE FROM sessioni WHERE token_hash = ?').run(hashToken(token));
}

export function pulisciSessioniScadute() {
  return db.prepare('DELETE FROM sessioni WHERE scade_il < ?').run(new Date().toISOString()).changes;
}

function estraiToken(req) {
  const header = req.get('authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/** Popola req.utente se il token e' valido, senza bloccare le richieste anonime. */
export function autenticazioneOpzionale(req, _res, next) {
  req.utente = utenteDaToken(estraiToken(req));
  next();
}

export const RUOLI_STAFF = ['admin', 'segretaria'];

/**
 * Con la password provvisoria ancora addosso non si combina nulla.
 * Il blocco sta qui e non solo nelle pagine: altrimenti basterebbe conoscere
 * l'indirizzo di una chiamata per saltare il cambio password.
 */
function passwordDaCambiare(utente, res) {
  if (!utente.deve_cambiare_password) return false;
  res.status(403).json({
    success: false,
    cambio_password: true,
    message: 'Prima di continuare devi scegliere una password personale.'
  });
  return true;
}

/** Chi lavora nello studio: medico e segreteria. */
export function richiedeStaff(req, res, next) {
  const utente = req.utente || utenteDaToken(estraiToken(req));
  if (!utente || !RUOLI_STAFF.includes(utente.ruolo)) {
    return res.status(401).json({ success: false, message: 'Accesso riservato al personale dello studio.' });
  }
  if (passwordDaCambiare(utente, res)) return;
  req.utente = utente;
  next();
}

/** Solo il medico: dati clinici, statistiche, backup, impostazioni. */
export function richiedeAdmin(req, res, next) {
  const utente = req.utente || utenteDaToken(estraiToken(req));
  if (!utente || utente.ruolo !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Questa sezione è riservata al medico.'
    });
  }
  req.utente = utente;
  next();
}

/** Crea o aggiorna un account di servizio a partire da .env, all'avvio. */
function inizializzaUtente(email, password, ruolo, etichetta) {
  if (!email) return;

  const esistente = db.prepare('SELECT id, password_hash, ruolo FROM utenti WHERE email = ?').get(email);

  if (!esistente) {
    if (!password) {
      console.warn(`[auth] Nessun account ${etichetta} per ${email}: imposta la password in .env.`);
      return;
    }
    db.prepare('INSERT INTO utenti (email, password_hash, ruolo, creato_il) VALUES (?, ?, ?, ?)')
      .run(email, hashPassword(password), ruolo, new Date().toISOString());
    console.log(`[auth] Account ${etichetta} creato per ${email}.`);
    return;
  }

  if (esistente.ruolo !== ruolo) {
    db.prepare('UPDATE utenti SET ruolo = ? WHERE id = ?').run(ruolo, esistente.id);
  }

  // Permette di recuperare l'accesso reimpostando la password in .env.
  if (password && !verificaPassword(password, esistente.password_hash)) {
    db.prepare('UPDATE utenti SET password_hash = ? WHERE id = ?')
      .run(hashPassword(password), esistente.id);
    console.log(`[auth] Password ${etichetta} aggiornata da .env per ${email}.`);
  }
}

export function inizializzaAdmin() {
  inizializzaUtente(config.admin.email, config.admin.initialPassword, 'admin', 'medico');
  inizializzaUtente(config.segreteria.email, config.segreteria.initialPassword,
    'segretaria', 'segreteria');
}
