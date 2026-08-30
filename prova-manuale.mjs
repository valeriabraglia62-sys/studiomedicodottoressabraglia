/**
 * Accende una copia del programma su un archivio usa e getta, per provare a
 * mano il sito e il pannello senza sfiorare i dati dei pazienti veri.
 *
 *   node prova-manuale.mjs
 *
 * Poi il sito sta su http://localhost:3999
 *
 * Cosa cambia rispetto al server vero, e perche':
 *
 * - Database separato, vuoto: le prenotazioni di prova non entrano
 *   nell'archivio vero, che contiene dati sanitari di persone reali.
 * - Password di amministratore inventata qui: quella vera non serve e non va
 *   scritta da nessuna parte.
 * - Lettura della casella Gmail spenta: accesa, questa copia leggerebbe la posta
 *   vera dello studio e sposterebbe nel cestino i messaggi che considera
 *   gestiti.
 * - Fogli e Moduli Google spenti: contengono richieste vere di pazienti veri.
 *   La macchina dei Moduli si prova lo stesso, con righe finte, dal pannello.
 * - Email invece ACCESE, con le credenziali vere: le notifiche partono davvero,
 *   ed e' il punto della prova. Vanno all'indirizzo che si scrive nei moduli.
 */

import path from 'path';
import { fileURLToPath } from 'url';

const RADICE = path.dirname(fileURLToPath(import.meta.url));

process.env.DB_FILE = path.join(RADICE, 'data', 'prova-manuale.sqlite');
process.env.CARTELLA_BACKUP = path.join(RADICE, 'data', 'backup-prova-manuale');
process.env.PORT = '3999';

process.env.INBOX_POLLING_ENABLED = 'false';
process.env.GOOGLE_SHEETS_ENABLED = 'false';
process.env.GOOGLE_MODULI_ENABLED = 'false';

process.env.ADMIN_EMAIL = 'auslvaleria@gmail.com';
process.env.ADMIN_PASSWORD = 'ProvaUsaEGetta2026!';

await import('./server.js');
