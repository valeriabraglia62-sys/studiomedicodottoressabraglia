import crypto from 'crypto';
import { db } from './db.js';
import { config } from './config.js';
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

const ORE_VALIDITA_VERIFICA = 24;
const hashTokenVerifica = (t) => crypto.createHmac('sha256', config.sessionSecret).update(t).digest('hex');

/** L'id della scheda paziente che email o telefono indicano in modo NON ambiguo. */
function schedaUnivoca(indirizzo, numero) {
  const perEmail = db.prepare('SELECT id FROM pazienti WHERE lower(trim(email)) = ?').all(indirizzo);
  const perTelefono = db.prepare(`
    SELECT id FROM pazienti WHERE replace(replace(replace(replace(replace(
      telefono, ' ', ''), '.', ''), '-', ''), '(', ''), ')', '') = ?
  `).all(numero);
  const candidati = [...new Set([...perEmail, ...perTelefono].map((p) => p.id))];
  return (perEmail.length <= 1 && perTelefono.length <= 1 && candidati.length === 1) ? candidati[0] : null;
}

/**
 * Crea l'identita' del paziente. NON collega subito una scheda preesistente: il
 * collegamento scatta solo dopo la verifica dell'email, cosi' conoscere
 * l'indirizzo o il telefono di un paziente non basta per prendersi la sua
 * storia clinica. Se non c'e' una scheda corrispondente ne nasce una nuova,
 * vuota e quindi senza rischi.
 *
 * Restituisce anche il token grezzo di verifica: chi chiama lo mette nel link
 * dell'email. Nel database ne resta solo l'impronta.
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

  const schedaEsistente = schedaUnivoca(indirizzo, numero);
  const token = crypto.randomBytes(32).toString('base64url');
  const scade = new Date(Date.now() + ORE_VALIDITA_VERIFICA * 3600000).toISOString();

  return db.transaction(() => {
    let pazienteId = null;
    let schedaDaCollegare = null;
    if (schedaEsistente) {
      schedaDaCollegare = schedaEsistente;           // collegata solo dopo la verifica
    } else {
      pazienteId = db.prepare(`
        INSERT INTO pazienti (nome, cognome, email, telefono, creato_il) VALUES (?, ?, ?, ?, ?)
      `).run(nomePulito, cognomePulito, indirizzo, numero, new Date().toISOString()).lastInsertRowid;
    }
    const info = db.prepare(`
      INSERT INTO utenti (nome, email, password_hash, ruolo, paziente_id, attivo, cambio_password,
                          email_verificata, token_verifica, token_verifica_scade, scheda_da_collegare, creato_il)
      VALUES (?, ?, ?, 'paziente', ?, 1, 0, 0, ?, ?, ?, ?)
    `).run(`${nomePulito} ${cognomePulito}`, indirizzo, hashPassword(scelta), pazienteId,
      hashTokenVerifica(token), scade, schedaDaCollegare, new Date().toISOString());
    return {
      utente: pubblico(db.prepare('SELECT * FROM utenti WHERE id = ?').get(info.lastInsertRowid)),
      token
    };
  })();
}

/**
 * Conferma l'indirizzo email a partire dal token del link. Solo qui l'account
 * viene collegato a una scheda paziente preesistente, e solo se nel frattempo
 * quella scheda e' ancora l'unica corrispondenza certa.
 */
export function verificaEmailPaziente(tokenGrezzo) {
  const token = String(tokenGrezzo || '');
  if (!token) throw new ErroreDominio('Link di verifica non valido.', 400);
  const u = db.prepare('SELECT * FROM utenti WHERE token_verifica = ?').get(hashTokenVerifica(token));
  if (!u) throw new ErroreDominio('Link di verifica non valido o gia\' usato.', 400);
  if (u.email_verificata) return pubblico(u);
  if (new Date(u.token_verifica_scade) < new Date()) {
    throw new ErroreDominio('Link di verifica scaduto: richiedine uno nuovo dalla pagina di accesso.', 400);
  }

  return db.transaction(() => {
    let pazienteId = u.paziente_id;
    if (!pazienteId && u.scheda_da_collegare) {
      const scheda = db.prepare('SELECT telefono FROM pazienti WHERE id = ?').get(u.scheda_da_collegare);
      const ancoraUnivoca = schedaUnivoca(pulisciEmail(u.email), pulisciTelefono(scheda?.telefono));
      if (ancoraUnivoca === u.scheda_da_collegare) pazienteId = u.scheda_da_collegare;
    }
    if (!pazienteId) {
      // La scheda non e' piu' identificabile con certezza: se ne crea una nuova
      // e sara' lo studio a riunire eventuali duplicati.
      const parti = String(u.nome || '').trim().split(/\s+/);
      pazienteId = db.prepare(`
        INSERT INTO pazienti (nome, cognome, email, telefono, creato_il) VALUES (?, ?, ?, ?, ?)
      `).run(parti[0] || u.email, parti.slice(1).join(' ') || '-', pulisciEmail(u.email), '',
        new Date().toISOString()).lastInsertRowid;
    }
    db.prepare(`
      UPDATE utenti SET email_verificata = 1, token_verifica = NULL, token_verifica_scade = NULL,
                        scheda_da_collegare = NULL, paziente_id = ?
       WHERE id = ?
    `).run(pazienteId, u.id);
    return pubblico(db.prepare('SELECT * FROM utenti WHERE id = ?').get(u.id));
  })();
}

/**
 * Rigenera il token per rinviare l'email di verifica. Non rivela mai se
 * l'account esiste: chi chiama risponde sempre allo stesso modo.
 */
export function preparaRinvioVerifica(email) {
  const u = db.prepare("SELECT * FROM utenti WHERE email = ? AND ruolo = 'paziente'").get(pulisciEmail(email));
  if (!u || u.email_verificata) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('UPDATE utenti SET token_verifica = ?, token_verifica_scade = ? WHERE id = ?')
    .run(hashTokenVerifica(token), new Date(Date.now() + ORE_VALIDITA_VERIFICA * 3600000).toISOString(), u.id);
  return { utente: pubblico(u), token };
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
