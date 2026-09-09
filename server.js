import path from 'path';
import express from 'express';
import { config, ROOT } from './src/config.js';
import { db, chiudiDb } from './src/db.js';
import { inizializzaAdmin, pulisciSessioniScadute } from './src/auth.js';
import { avviaWorker, fermaWorker } from './src/outbox.js';
import { avviaPromemoria, fermaPromemoria } from './src/promemoria.js';
import { avviaBackup, fermaBackup } from './src/backup.js';
import { avviaBattito, fermaBattito } from './src/battito.js';
import { pulisciChatVecchie } from './src/chatbot.js';
import { verificaConnessioneEmail } from './src/mailer.js';
import { router } from './src/api.js';

/**
 * Un errore dentro una richiesta non spegne il server: lo cattura il gestore
 * errori di Express (le rotte async passano da `via()`), il paziente vede un
 * 500 e gli altri continuano.
 *
 * Un `uncaughtException` o un `unhandledRejection` sono un'altra cosa: l'errore
 * e' arrivato FUORI dal ciclo delle richieste (un timer, un handler, un bug), e
 * da li' in poi lo stato del processo non e' piu' affidabile. Si registra, si
 * chiude in modo ordinato e si esce con codice non-zero: a rimetterlo in piedi
 * ci pensa il gestore del servizio (systemd / NSSM), che riparte pulito.
 */
let spegniRef = null;
function fatale(tipo, err) {
  console.error(`[fatale] ${tipo}:`, err?.name || 'Errore');
  if (spegniRef) spegniRef('errore', 1);
  else process.exit(1);          // errore durante l'avvio: si esce e basta
}
process.on('uncaughtException', (err) => fatale('eccezione non gestita', err));
process.on('unhandledRejection', (err) => fatale('promise rifiutata', err));

const app = express();

const hostConfigurato = (() => {
  try { return config.pubblico.url ? new URL(config.pubblico.url).hostname.toLowerCase() : ''; }
  catch { return ''; }
})();
const hostAmmessi = new Set([
  ...config.pubblico.hostAmmessi.map((h) => h.toLowerCase().replace(/:\d+$/, '')),
  hostConfigurato
].filter(Boolean));

export function destinazioneRedirectHttps(hostRichiesto) {
  const richiesto = String(hostRichiesto || '').toLowerCase();
  return hostConfigurato || (hostAmmessi.has(richiesto) ? richiesto : '');
}

// Vedi config.pubblico.proxyDavanti: da questo numero dipende se l'indirizzo
// di chi chiama e' un fatto o una dichiarazione dell'interessato.
app.set('trust proxy', config.pubblico.proxyDavanti);
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

/**
 * Fuori dallo studio il sito viaggia su reti di altri: Wi-Fi degli hotel,
 * rete del bar, telefono in 4G. Queste intestazioni dicono al browser del
 * paziente cosa accettare e cosa rifiutare.
 */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');

  // Il sito non carica NIENTE da fuori: nessuna libreria, nessun font, nessun
  // tracciamento. Quindi il browser puo' rifiutare qualunque codice esterno,
  // anche se qualcuno riuscisse a infilarlo in una pagina.
  // Gli stili in riga restano ammessi: sono scritti nelle nostre pagine.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // blob: serve alle anteprime delle foto che il paziente sta per allegare:
    // sono immagini costruite dal nostro stesso codice a partire da un file che
    // l'utente ha appena scelto, e non escono mai dal suo browser. Senza questo
    // l'anteprima resta un riquadro rotto proprio mentre uno cerca di capire se
    // ha inquadrato bene la prescrizione.
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'"
  ].join('; '));

  // Nessuna di queste cose serve a un sito di prenotazioni.
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');

  if (config.pubblico.https) {
    // Host fuori dalla allowlist: si rifiuta SEMPRE, non solo nel redirect.
    // Cosi' un proxy mal configurato o un DNS rebinding verso l'origine non
    // passa nemmeno quando la richiesta arriva gia' marcata come sicura. Il
    // monitoraggio locale interroga /salute su localhost e resta escluso.
    if (hostAmmessi.size && req.path !== '/salute'
        && !hostAmmessi.has(String(req.hostname || '').toLowerCase())) {
      return res.status(421).send('Host non ammesso.');
    }
    // Dietro il proxy la richiesta arriva in chiaro: e' l'intestazione a dire
    // com'e' arrivata dal paziente. Se e' partita in chiaro la rimandiamo al
    // lucchetto, altrimenti password e dati sanitari attraverserebbero reti
    // altrui leggibili da chiunque.
    if (!req.secure && req.path !== '/salute') {
      const destinazione = destinazioneRedirectHttps(req.get('host'));
      if (!destinazione) return res.status(421).send('Host non ammesso.');
      return res.redirect(308, `https://${destinazione}${req.originalUrl}`);
    }
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }

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
pulisciChatVecchie(3);

const manutenzione = setInterval(() => {
  pulisciSessioniScadute();
  pulisciChatVecchie(3);
}, 15 * 60 * 1000);
manutenzione.unref?.();

const server = app.listen(config.port, config.bindHost, async () => {
  console.log(`\n  ${config.nomeStudio} — servizio attivo su ${config.bindHost}:${config.port}\n`);

  avviaWorker(30);
  avviaPromemoria();
  avviaBackup();

  // Va fatto partire prima di tutto il resto che potrebbe scrivere in coda: se
  // il sito e' stato giu', l'avviso deve trovarsi in cima alla coda.
  const assenza = avviaBattito();
  if (assenza) {
    console.log(`  ATTENZIONE     il sito e' stato irraggiungibile per circa ${assenza.minuti} minuti`);
  }

  const email = await verificaConnessioneEmail();
  const stato = (e) => (e.ok ? 'attivo' : `non attivo (${e.motivo})`);

  console.log(`  Email          ${stato(email)}`);
  console.log(`  Apertura       ${config.pubblico.https
    ? `su internet con lucchetto${config.pubblico.url ? ` — ${config.pubblico.url}` : ''}`
    : 'solo rete locale (SITO_HTTPS=false)'}`);
  console.log(`  Indirizzi      ${config.pubblico.proxyDavanti
    ? `letti da X-Forwarded-For (${config.pubblico.proxyDavanti} proxy davanti)`
    : 'presi dalla connessione (nessun proxy davanti)'}`);
  console.log(`  Database       ${config.dbFile}\n`);

  // Le due combinazioni sbagliate fra lucchetto e proxy. Nessuna delle due
  // impedisce al sito di funzionare, ed e' proprio questo il pericolo:
  // passerebbero inosservate finche' non fanno danno.
  if (config.pubblico.https && !config.pubblico.proxyDavanti) {
    console.log('  ATTENZIONE: sito su internet ma PROXY_DAVANTI=0.');
    console.log('  Tutti i pazienti risultano provenire dallo stesso indirizzo, quindi i');
    console.log('  freni anti-abuso li contano come una persona sola e si bloccano a vicenda.');
    console.log('  Dietro un tunnel Cloudflare metti PROXY_DAVANTI=1.\n');
  }
  if (!config.pubblico.https && config.pubblico.proxyDavanti) {
    console.log('  ATTENZIONE: PROXY_DAVANTI e\' acceso ma il sito non e\' dietro un proxy.');
    console.log('  L\'indirizzo di chi chiama viene letto da un\'intestazione che chiunque puo\'');
    console.log('  scriversi da solo: i freni anti-abuso si aggirano cambiandola. Mettilo a 0.\n');
  }

  if (!email.ok) {
    console.log('  Le email restano in coda finche\' l\'invio non torna disponibile:');
    console.log('  non si perde nulla.\n');
  }
});

// Le connessioni tenute aperte a lungo impediscono la chiusura pulita.
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

let inChiusura = false;

function spegni(segnale, codice = 0) {
  if (inChiusura) return;
  inChiusura = true;
  console.log(`\n[${segnale}] chiusura in corso...`);

  fermaWorker();
  fermaPromemoria();
  fermaBackup();
  // Segna l'ora anche adesso: una chiusura ordinata non e' un'interruzione, e
  // senza quest'ultima scrittura il tempo di un riavvio verrebbe misurato a
  // partire dall'ultimo battito, fino a un minuto prima.
  fermaBattito();

  server.close(() => {
    chiudiDb();
    console.log('[chiusura] database salvato. Arrivederci.');
    process.exit(codice);
  });

  // Se qualche connessione non si chiude, non restiamo appesi all'infinito.
  setTimeout(() => {
    chiudiDb();
    process.exit(codice);
  }, 10000).unref();
}
spegniRef = spegni;

process.on('SIGINT', () => spegni('SIGINT'));
process.on('SIGTERM', () => spegni('SIGTERM'));

export { app, server, db };
