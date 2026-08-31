import crypto from 'crypto';
import { db } from './db.js';
import { hashPassword, verificaPassword, RUOLI_STAFF } from './auth.js';
import { ErroreDominio } from './prenotazioni.js';

/**
 * Accessi personali di chi lavora nello studio.
 *
 * Una password condivisa da tutti sembra comoda finche' non serve sapere chi
 * ha annullato una prenotazione, o finche' qualcuno non se ne va e bisogna
 * cambiarla a mezzo studio. Qui ognuno ha il suo accesso: si crea, si sospende
 * e si revoca singolarmente, senza disturbare gli altri.
 *
 * Il medico non conosce mai la password dei collaboratori: ne consegna una
 * provvisoria, che al primo ingresso il collaboratore e' obbligato a cambiare.
 */

// Niente O/0/I/1: queste password vengono lette a voce o copiate a mano.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz';
export const LUNGHEZZA_MINIMA_PASSWORD = 10;

export function passwordProvvisoria(lunghezza = 12) {
  const byte = crypto.randomBytes(lunghezza);
  return [...byte].map((b) => ALFABETO[b % ALFABETO.length]).join('');
}

const pulisciEmail = (v) => String(v ?? '').trim().toLowerCase();
const pulisciTelefono = (v) => String(v ?? '').replace(/[\s.\-()]/g, '');

/** Quello che si puo' mostrare: mai l'hash della password. */
const pubblico = (u) => ({
  id: u.id,
  nome: u.nome || '',
  email: u.email,
  ruolo: u.ruolo,
  paziente_id: u.paziente_id || null,
  attivo: Boolean(u.attivo),
  deve_cambiare_password: Boolean(u.cambio_password),
  ultimo_accesso: u.ultimo_accesso || null,
  creato_il: u.creato_il
});

export function elenco() {
  const righe = db.prepare(`
    SELECT id, nome, email, ruolo, attivo, cambio_password, ultimo_accesso, creato_il
      FROM utenti
     WHERE ruolo IN (${RUOLI_STAFF.map(() => '?').join(',')})
     ORDER BY attivo DESC, ruolo, email
  `).all(...RUOLI_STAFF);
  return { utenti: righe.map(pubblico) };
}

/**
 * Crea l'identita' del paziente e la collega a una sola scheda certa.
 * TODO sicurezza: aggiungere verifica dell'indirizzo email prima di consentire
 * la rivendicazione di una scheda preesistente.
 */
export function registraPaziente({ nome, cognome, telefono, email, password }) {
  const indirizzo = pulisciEmail(email);
  const numero = pulisciTelefono(telefono);
  const nomePulito = String(nome ?? '').trim();
  const cognomePulito = String(cognome ?? '').trim();
  const scelta = String(password ?? '');

  if (!nomePulito || !cognomePulito) throw new ErroreDominio('Nome e cognome sono obbligatori.', 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(indirizzo)) {
    throw new ErroreDominio('Serve un indirizzo email valido.', 400);
  }
  if (!/^(\+39)?\d{8,11}$/.test(numero)) throw new ErroreDominio('Serve un numero di telefono valido.', 400);
  if (scelta.length < LUNGHEZZA_MINIMA_PASSWORD) {
    throw new ErroreDominio(`La password deve avere almeno ${LUNGHEZZA_MINIMA_PASSWORD} caratteri.`, 400);
  }
  if (db.prepare('SELECT id FROM utenti WHERE email = ?').get(indirizzo)) {
    throw new ErroreDominio('Esiste già un account con questa email.', 409);
  }

  const perEmail = db.prepare('SELECT id FROM pazienti WHERE lower(trim(email)) = ?').all(indirizzo);
  const perTelefono = db.prepare(`
    SELECT id FROM pazienti WHERE replace(replace(replace(replace(replace(
      telefono, ' ', ''), '.', ''), '-', ''), '(', ''), ')', '') = ?
  `).all(numero);
  const candidati = [...new Set([...perEmail, ...perTelefono].map((p) => p.id))];
  const collegabile = perEmail.length <= 1 && perTelefono.length <= 1 && candidati.length === 1;

  return db.transaction(() => {
    let pazienteId = collegabile ? candidati[0] : null;
    if (!pazienteId) {
      pazienteId = db.prepare(`
        INSERT INTO pazienti (nome, cognome, email, telefono, creato_il) VALUES (?, ?, ?, ?, ?)
      `).run(nomePulito, cognomePulito, indirizzo, numero, new Date().toISOString()).lastInsertRowid;
    }
    const info = db.prepare(`
      INSERT INTO utenti (nome, email, password_hash, ruolo, paziente_id, attivo, cambio_password, creato_il)
      VALUES (?, ?, ?, 'paziente', ?, 1, 0, ?)
    `).run(`${nomePulito} ${cognomePulito}`, indirizzo, hashPassword(scelta), pazienteId,
      new Date().toISOString());
    return pubblico(db.prepare('SELECT * FROM utenti WHERE id = ?').get(info.lastInsertRowid));
  })();
}

function trova(id) {
  const u = db.prepare('SELECT * FROM utenti WHERE id = ?').get(Number(id));
  if (!u || !RUOLI_STAFF.includes(u.ruolo)) {
    throw new ErroreDominio('Collaboratore non trovato.', 404);
  }
  return u;
}

const contaAdminAttivi = () =>
  db.prepare("SELECT COUNT(*) n FROM utenti WHERE ruolo = 'admin' AND attivo = 1").get().n;

/**
 * La rete di sicurezza piu' importante di tutto il file: qualunque mossa che
 * lascerebbe lo studio senza nemmeno un medico attivo viene rifiutata. Senza
 * questo controllo basta un clic distratto per chiudersi fuori dal pannello,
 * e da fuori non si rientra piu'.
 */
function proteggiUltimoAdmin(utente, { restaAdmin, restaAttivo }) {
  const eraAdminAttivo = utente.ruolo === 'admin' && utente.attivo;
  if (eraAdminAttivo && !(restaAdmin && restaAttivo) && contaAdminAttivi() <= 1) {
    throw new ErroreDominio(
      'Questo e\' l\'unico accesso da medico rimasto: creane un altro prima di toglierlo, ' +
      'altrimenti nessuno potrebbe piu\' entrare nel pannello.',
      400
    );
  }
}

function vietaSuSeStesso(utente, richiedenteId, azione) {
  if (utente.id === Number(richiedenteId)) {
    throw new ErroreDominio(`Non puoi ${azione} il tuo stesso accesso.`, 400);
  }
}

export function crea({ nome, email, ruolo }, richiedenteId) {
  const indirizzo = pulisciEmail(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(indirizzo)) {
    throw new ErroreDominio('Serve un indirizzo email valido.', 400);
  }
  if (!RUOLI_STAFF.includes(ruolo)) {
    throw new ErroreDominio('Ruolo non valido.', 400);
  }
  if (db.prepare('SELECT id FROM utenti WHERE email = ?').get(indirizzo)) {
    throw new ErroreDominio('Esiste gia\' un accesso con questa email.', 400);
  }

  const password = passwordProvvisoria();
  const info = db.prepare(`
    INSERT INTO utenti (nome, email, password_hash, ruolo, attivo, cambio_password, creato_il)
    VALUES (?, ?, ?, ?, 1, 1, ?)
  `).run(String(nome ?? '').trim(), indirizzo, hashPassword(password), ruolo, new Date().toISOString());

  // La password provvisoria si vede una volta sola: nel database ne resta
  // solo l'impronta, quindi non e' piu' recuperabile nemmeno da qui.
  return { utente: pubblico(trova(info.lastInsertRowid)), password_provvisoria: password, creato_da: richiedenteId };
}

export function cambiaRuolo(id, ruolo, richiedenteId) {
  if (!RUOLI_STAFF.includes(ruolo)) throw new ErroreDominio('Ruolo non valido.', 400);
  const utente = trova(id);
  vietaSuSeStesso(utente, richiedenteId, 'cambiare ruolo al');
  proteggiUltimoAdmin(utente, { restaAdmin: ruolo === 'admin', restaAttivo: Boolean(utente.attivo) });

  db.prepare('UPDATE utenti SET ruolo = ? WHERE id = ?').run(ruolo, utente.id);
  return { utente: pubblico(trova(utente.id)) };
}

export function cambiaAttivazione(id, attivo, richiedenteId) {
  const acceso = Boolean(attivo);
  const utente = trova(id);
  vietaSuSeStesso(utente, richiedenteId, 'sospendere');
  proteggiUltimoAdmin(utente, { restaAdmin: utente.ruolo === 'admin', restaAttivo: acceso });

  db.prepare('UPDATE utenti SET attivo = ? WHERE id = ?').run(acceso ? 1 : 0, utente.id);
  // Sospendere deve avere effetto subito, anche su chi e' gia' dentro.
  if (!acceso) db.prepare('DELETE FROM sessioni WHERE utente_id = ?').run(utente.id);
  return { utente: pubblico(trova(utente.id)) };
}

export function rinnovaPassword(id) {
  const utente = trova(id);
  const password = passwordProvvisoria();
  db.prepare('UPDATE utenti SET password_hash = ?, cambio_password = 1 WHERE id = ?')
    .run(hashPassword(password), utente.id);
  // Chi ha perso la password potrebbe essersela fatta rubare: chiudo tutto.
  db.prepare('DELETE FROM sessioni WHERE utente_id = ?').run(utente.id);
  return { utente: pubblico(trova(utente.id)), password_provvisoria: password };
}

export function rimuovi(id, richiedenteId) {
  const utente = trova(id);
  vietaSuSeStesso(utente, richiedenteId, 'eliminare');
  proteggiUltimoAdmin(utente, { restaAdmin: false, restaAttivo: false });

  db.prepare('DELETE FROM sessioni WHERE utente_id = ?').run(utente.id);
  db.prepare('DELETE FROM utenti WHERE id = ?').run(utente.id);
  return { rimosso: utente.email };
}

/** Cambio password fatto dall'interessato: richiede quella vecchia. */
export function cambiaPasswordProprio(utenteId, attuale, nuova) {
  const utente = db.prepare('SELECT * FROM utenti WHERE id = ?').get(Number(utenteId));
  if (!utente) throw new ErroreDominio('Sessione non valida.', 401);

  if (!verificaPassword(String(attuale ?? ''), utente.password_hash)) {
    throw new ErroreDominio('La password attuale non e\' corretta.', 400);
  }
  const scelta = String(nuova ?? '');
  if (scelta.length < LUNGHEZZA_MINIMA_PASSWORD) {
    throw new ErroreDominio(
      `La nuova password deve avere almeno ${LUNGHEZZA_MINIMA_PASSWORD} caratteri.`, 400);
  }
  if (verificaPassword(scelta, utente.password_hash)) {
    throw new ErroreDominio('La nuova password deve essere diversa dalla precedente.', 400);
  }

  db.transaction(() => {
    db.prepare('UPDATE utenti SET password_hash = ?, cambio_password = 0 WHERE id = ?')
      .run(hashPassword(scelta), utente.id);
    // Una password cambiata per sospetto furto deve chiudere anche il token rubato.
    db.prepare('DELETE FROM sessioni WHERE utente_id = ?').run(utente.id);
  })();
  return { cambiata: true };
}

export function segnaAccesso(utenteId) {
  db.prepare('UPDATE utenti SET ultimo_accesso = ? WHERE id = ?')
    .run(new Date().toISOString(), utenteId);
}
