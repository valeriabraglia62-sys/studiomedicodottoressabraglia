import { config } from './config.js';
import { ErroreDominio } from './prenotazioni.js';

/**
 * Un solo compito: togliere il blocco di consegna su Brevo da un indirizzo
 * che si e' tolto da solo dalle email dello studio, di solito cliccando
 * "annulla iscrizione" per sbaglio su un'email automatica. Brevo smette di
 * mandarci qualunque cosa a quell'indirizzo finche' qualcuno non lo riattiva
 * — da qui, altrimenti dal pannello di Brevo stesso.
 *
 * Usa la chiave API di Brevo, non le credenziali SMTP: sono due cose diverse,
 * la prima serve a spedire, la seconda a gestire i contatti.
 */

const BASE = 'https://api.brevo.com/v3';

/**
 * Riattiva un indirizzo. Se Brevo non lo conosce ancora (non gli e' mai
 * arrivata un'email nostra prima d'ora) non e' un errore: restituisce
 * semplicemente che non c'era niente da riattivare.
 */
export async function riattivaContatto(email) {
  if (!config.brevo.enabled) {
    throw new ErroreDominio('Integrazione con Brevo non configurata su questo server.', 501);
  }
  const indirizzo = String(email || '').trim().toLowerCase();
  if (!indirizzo) throw new ErroreDominio('Il paziente non ha un indirizzo email.', 400);

  const risposta = await fetch(`${BASE}/contacts/${encodeURIComponent(indirizzo)}`, {
    method: 'PUT',
    headers: { 'api-key': config.brevo.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailBlacklisted: false })
  });

  if (risposta.status === 404) return { riattivato: false, motivo: 'sconosciuto_a_brevo' };
  if (!risposta.ok) {
    throw new ErroreDominio(`Brevo ha risposto con un errore (codice ${risposta.status}).`, 502);
  }
  return { riattivato: true };
}
