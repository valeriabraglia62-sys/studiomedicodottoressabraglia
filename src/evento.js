import { formattaDataEstesa } from './orari.js';

/**
 * Collegamento per aggiungere la visita al calendario del paziente.
 *
 * Nessun accesso al calendario altrui, nessuna autorizzazione da chiedere:
 * il paziente apre il link, vede l'evento gia' compilato e decide lui se
 * salvarlo. E' anche l'unica strada che funziona per chiunque, subito, senza
 * che lo studio debba custodire i permessi Google dei suoi pazienti.
 */

const FUSO = 'Europe/Rome';

/** 'YYYY-MM-DD' + 'HH:MM' -> 'YYYYMMDDTHHMMSS' come lo vuole Google. */
function istante(data, ora) {
  const [h, m] = String(ora).split(':');
  return `${String(data).replace(/-/g, '')}T${h}${m}00`;
}

export function linkGoogleCalendar(p) {
  if (!p?.data || !p?.ora_inizio || !p?.ora_fine) return null;

  const dettagli = [
    `Codice prenotazione: ${p.codice}`,
    p.problema ? `Motivo: ${p.problema}` : '',
    p.ambulatorio_telefono ? `Telefono ambulatorio: ${p.ambulatorio_telefono}` : ''
  ].filter(Boolean).join('\n')
    + '\n\nPer consultare o annullare la prenotazione usa il codice qui sopra.';

  const parametri = new URLSearchParams({
    action: 'TEMPLATE',
    text: `Visita medica — ${p.ambulatorio_nome || 'Studio Medico'}`,
    dates: `${istante(p.data, p.ora_inizio)}/${istante(p.data, p.ora_fine)}`,
    ctz: FUSO,
    details: dettagli,
    location: p.ambulatorio_indirizzo || ''
  });

  return `https://calendar.google.com/calendar/render?${parametri.toString()}`;
}

/** Riga di testo per chi legge l'email in versione non formattata. */
export function descrizioneEvento(p) {
  return `${formattaDataEstesa(p.data)}, ore ${p.ora_inizio}`;
}
