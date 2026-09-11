import webpush from 'web-push';
import { db } from './db.js';
import { config, NOTIFY_EMAIL } from './config.js';
import { RUOLI_STAFF } from './auth.js';
import { ErroreDominio } from './prenotazioni.js';

/**
 * Notifiche sul dispositivo (telefono o computer), oltre alle email.
 *
 * Si affiancano al canale email, non lo sostituiscono: se il dispositivo non
 * e' raggiungibile — spento, offline, notifiche disattivate, mai iscritto —
 * l'unica traccia resta l'email, che arriva sempre e non si perde mai.
 * Per questo, a differenza della coda email, qui non si riprova: un "e'
 * arrivata una richiesta" recapitato un'ora dopo per un problema di rete non
 * servirebbe a nessuno, e nel frattempo l'email ha gia' avvisato.
 *
 * Senza le due chiavi VAPID in .env il modulo resta silenzioso: ogni funzione
 * diventa un no-op, cosi' il sito funziona lo stesso su chi non le ha ancora
 * configurate.
 */

if (config.vapid.enabled) {
  webpush.setVapidDetails(
    `mailto:${NOTIFY_EMAIL || 'info@example.it'}`,
    config.vapid.publicKey,
    config.vapid.privateKey
  );
}

/** La chiave pubblica: la manda al browser, che la usa per iscriversi. */
export function chiavePubblica() {
  return config.vapid.enabled ? config.vapid.publicKey : null;
}

/** Registra (o aggiorna) il dispositivo da cui arriva l'iscrizione. */
export function iscrivi(utenteId, iscrizione) {
  if (!iscrizione?.endpoint || !iscrizione?.keys?.p256dh || !iscrizione?.keys?.auth) {
    throw new ErroreDominio('Iscrizione non valida.', 400);
  }
  db.prepare(`
    INSERT INTO iscrizioni_notifiche (utente_id, endpoint, p256dh, auth, creato_il)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      utente_id = excluded.utente_id, p256dh = excluded.p256dh, auth = excluded.auth
  `).run(utenteId, iscrizione.endpoint, iscrizione.keys.p256dh, iscrizione.keys.auth, new Date().toISOString());
}

export function disiscrivi(endpoint) {
  if (endpoint) db.prepare('DELETE FROM iscrizioni_notifiche WHERE endpoint = ?').run(endpoint);
}

/**
 * Manda l'avviso a un dispositivo. Non lancia MAI: chi chiama non fa
 * `await`, quindi un rifiuto qui non andrebbe da nessuna parte a finire
 * come promise rifiutata non gestita — e quella spegne tutto il server
 * (vedi il gestore in server.js). Percio' ogni riga che puo' fallire,
 * compresa la pulizia nel catch, ha la sua rete di sicurezza.
 */
async function inviaAlDispositivo(dispositivo, messaggio) {
  try {
    const sub = {
      endpoint: dispositivo.endpoint,
      keys: { p256dh: dispositivo.p256dh, auth: dispositivo.auth }
    };
    await webpush.sendNotification(sub, JSON.stringify({ url: '/', ...messaggio }));
  } catch (err) {
    try {
      // 404/410: il browser ha revocato l'iscrizione (disinstallata, permessi
      // tolti). Si toglie, altrimenti si ritenterebbe per sempre su un
      // dispositivo che non c'e' piu'.
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM iscrizioni_notifiche WHERE endpoint = ?').run(dispositivo.endpoint);
      } else {
        console.error('[push] invio fallito:', err.statusCode || err.message);
      }
    } catch (errInterno) {
      console.error('[push] anche la pulizia della iscrizione e\' fallita:', errInterno.message);
    }
  }
}

// Le tre funzioni sotto le chiama, subito dopo aver scritto nel database, il
// codice che gestisce prenotazioni e richieste — e non fa mai `await` su
// queste chiamate, perche' una prenotazione o una richiesta non deve mai
// fallire per colpa di una notifica. Per questo non lanciano MAI, nemmeno
// per un problema nella lettura dei dispositivi iscritti: un avviso mancato
// e' un peccato veniale (resta l'email), un errore qui non lo e'.

/** A un utente (paziente o staff), su tutti i suoi dispositivi iscritti. */
export function notificaUtente(utenteId, messaggio) {
  if (!config.vapid.enabled || !utenteId) return;
  try {
    const dispositivi = db.prepare('SELECT * FROM iscrizioni_notifiche WHERE utente_id = ?').all(utenteId);
    for (const d of dispositivi) inviaAlDispositivo(d, messaggio);
  } catch (err) {
    console.error('[push] notificaUtente:', err.message);
  }
}

/** Al paziente, risalendo dalla sua scheda — solo se ha un account collegato. */
export function notificaPaziente(pazienteId, messaggio) {
  if (!config.vapid.enabled || !pazienteId) return;
  try {
    const u = db.prepare(
      "SELECT id FROM utenti WHERE paziente_id = ? AND ruolo = 'paziente'"
    ).get(pazienteId);
    if (u) notificaUtente(u.id, messaggio);
  } catch (err) {
    console.error('[push] notificaPaziente:', err.message);
  }
}

/** A tutto lo staff attivo (medico e segreteria): chi lavora deve saperlo tutti. */
export function notificaStaff(messaggio) {
  if (!config.vapid.enabled) return;
  try {
    const dispositivi = db.prepare(`
      SELECT i.* FROM iscrizioni_notifiche i
      JOIN utenti u ON u.id = i.utente_id
      WHERE u.ruolo IN (${RUOLI_STAFF.map(() => '?').join(',')}) AND u.attivo = 1
    `).all(...RUOLI_STAFF);
    for (const d of dispositivi) inviaAlDispositivo(d, messaggio);
  } catch (err) {
    console.error('[push] notificaStaff:', err.message);
  }
}
