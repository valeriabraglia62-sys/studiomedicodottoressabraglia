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

const intestazioni = () => ({ 'api-key': config.brevo.apiKey, 'Content-Type': 'application/json' });

/**
 * Riattiva un indirizzo. Prova su due elenchi diversi, perche' Brevo li
 * tiene separati:
 *
 *  - i "contatti bloccati" delle email TRANSAZIONALI (conferme, promemoria —
 *    quello che manda questo sito): e' li' che finisce chi clicca "annulla
 *    iscrizione" su una nostra email, ed e' il caso piu' comune;
 *  - i "Contatti" di marketing/CRM, un elenco a parte che non c'entra con
 *    l'invio delle nostre email ma che Brevo mostra nella stessa pagina di
 *    ricerca, e puo' confondere chi guarda lo stato sbagliato.
 *
 * Se Brevo non trova l'indirizzo in nessuno dei due (non gli e' mai arrivata
 * un'email nostra, o non era comunque bloccato) non e' un errore: restituisce
 * semplicemente che non c'era niente da riattivare.
 */
export async function riattivaContatto(email) {
  if (!config.brevo.enabled) {
    throw new ErroreDominio('Integrazione con Brevo non configurata su questo server.', 501);
  }
  const indirizzo = String(email || '').trim().toLowerCase();
  if (!indirizzo) throw new ErroreDominio('Il paziente non ha un indirizzo email.', 400);
  const path = encodeURIComponent(indirizzo);

  const transazionale = await fetch(`${BASE}/smtp/blockedContacts/${path}`, {
    method: 'DELETE',
    headers: intestazioni()
  });
  if (!transazionale.ok && transazionale.status !== 404) {
    throw new ErroreDominio(`Brevo ha risposto con un errore (codice ${transazionale.status}).`, 502);
  }

  const marketing = await fetch(`${BASE}/contacts/${path}`, {
    method: 'PUT',
    headers: intestazioni(),
    body: JSON.stringify({ emailBlacklisted: false })
  });
  if (!marketing.ok && marketing.status !== 404) {
    throw new ErroreDominio(`Brevo ha risposto con un errore (codice ${marketing.status}).`, 502);
  }

  return { riattivato: transazionale.ok || marketing.ok };
}
