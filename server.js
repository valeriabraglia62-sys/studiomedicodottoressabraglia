import path from 'path';
import express from 'express';
import { config, ROOT } from './src/config.js';
import { db, chiudiDb } from './src/db.js';
import { inizializzaAdmin, pulisciSessioniScadute } from './src/auth.js';
import { avviaWorker, fermaWorker } from './src/outbox.js';
import { avviaPolling, fermaPolling } from './src/inbox.js';
import { avviaPromemoria, fermaPromemoria } from './src/promemoria.js';
import { avviaBackup, fermaBackup } from './src/backup.js';
import { pulisciChatVecchie } from './src/chatbot.js';
import { verificaConnessioneEmail } from './src/mailer.js';
import { verificaFoglio } from './src/sheets.js';
import { router } from './src/api.js';

/**
 * Nessun errore deve poter spegnere il server.
 *
 * La versione precedente moriva su una singola variabile non definita durante
 * una prenotazione, e con lei sparivano tutti i dati tenuti in memoria. Ora i
 * dati stanno su disco e il processo resta in piedi: un errore rovina al
 * massimo la singola richiesta, mai il servizio degli altri pazienti.
 */
process.on('uncaughtException', (err) => {
  console.error('[fatale] eccezione non gestita:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[fatale] promise rifiutata:', err);
});

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use('/api', router);

// Il sito e le API vivono sullo stesso indirizzo: nessun CORS da aprire.
// Si serve solo public/, mai la cartella del progetto: .env resta irraggiungibile.
// Nessuna cache cieca: il browser richiede sempre, ma con ETag riceve un 304 da
// poche decine di byte. Cosi' un aggiornamento arriva subito a tutti, senza che
// qualcuno resti con un JavaScript vecchio e una pagina nuova.
app.use(express.static(path.join(ROOT, 'public'), {
  etag: true,
  maxAge: 0,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));

app.get('/salute', (_req, res) => {
  res.json({ ok: true, tempo_attivo: Math.round(process.uptime()) });
});

app.use((_req, res) => res.status(404).sendFile(path.join(ROOT, 'public', 'index.html')));

inizializzaAdmin();

const manutenzione = setInterval(() => {
  pulisciSessioniScadute();
  pulisciChatVecchie(30);
}, 6 * 3600 * 1000);
manutenzione.unref?.();

const server = app.listen(config.port, async () => {
  console.log(`\n  Studio medico — server attivo su http://localhost:${config.port}\n`);

  avviaWorker(30);
  avviaPromemoria();
  avviaBackup();
  if (config.inbox.enabled) avviaPolling();

  const email = await verificaConnessioneEmail();
  const foglio = await verificaFoglio();
  const stato = (e) => (e.ok ? 'attivo' : `non attivo (${e.motivo})`);

  console.log(`  Email          ${stato(email)}`);
  console.log(`  Foglio Google  ${stato(foglio)}`);
  console.log(`  Casella Gmail  ${config.inbox.enabled ? 'in ascolto' : 'non attiva (INBOX_POLLING_ENABLED=false)'}`);
  console.log(`  Database       ${config.dbFile}\n`);

  if (!email.ok || !foglio.ok) {
    console.log('  Le consegne verso i servizi spenti restano in coda e partono da sole');
    console.log('  appena il servizio torna disponibile: nulla va perso.\n');
  }
});

// Le connessioni tenute aperte a lungo impediscono la chiusura pulita.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

let inChiusura = false;

function spegni(segnale) {
  if (inChiusura) return;
  inChiusura = true;
  console.log(`\n[${segnale}] chiusura in corso...`);

  fermaWorker();
  fermaPolling();
  fermaPromemoria();
  fermaBackup();

  server.close(() => {
    chiudiDb();
    console.log('[chiusura] database salvato. Arrivederci.');
    process.exit(0);
  });

  // Se qualche connessione non si chiude, non restiamo appesi all'infinito.
  setTimeout(() => {
    chiudiDb();
    process.exit(0);
  }, 10000).unref();
}

process.on('SIGINT', () => spegni('SIGINT'));
process.on('SIGTERM', () => spegni('SIGTERM'));

export { app, server, db };
