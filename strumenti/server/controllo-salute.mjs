/**
 * Controllo di salute del server, una volta al giorno.
 *
 *   node strumenti/server/controllo-salute.mjs
 *
 * Guarda le quattro cose che, se si rompono, nessuno se ne accorge finche' non
 * e' troppo tardi:
 *   - il sito risponde su localhost;
 *   - la coda delle email non e' ferma (invio inceppato);
 *   - c'e' un backup cifrato recente (il backup automatico gira);
 *   - il disco non e' pieno.
 *
 * Se qualcosa non va: scrive il problema nel journal E mette in coda una email
 * per lo studio (che parte dall'app come tutte le altre). Se e' tutto a posto
 * non manda niente. Lo lancia controllo-salute.timer.
 *
 * Volutamente non importa src/config.js: non deve far girare migrazioni ne'
 * fallire per la chiave di backup mancante — legge il .env da solo.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const env = {};
try {
  for (const riga of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = riga.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
} catch { /* senza .env si usano i default sotto */ }

const FILE_DB = env.DB_FILE
  ? path.resolve(ROOT, env.DB_FILE)
  : path.join(ROOT, 'data', 'medstudent.sqlite');
const CARTELLA_BACKUP = env.CARTELLA_BACKUP
  ? path.resolve(ROOT, env.CARTELLA_BACKUP)
  : path.join(path.dirname(FILE_DB), 'backup');
const AVVISA_A = env.NOTIFY_EMAIL || env.ADMIN_EMAIL || env.EMAIL_USER || '';
const PORTA = Number(env.PORT) || 3000;

const problemi = [];

// 1. Il sito risponde?
try {
  const r = await fetch(`http://127.0.0.1:${PORTA}/salute`, { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  if (!j?.ok) problemi.push(`Il sito risponde ma /salute non dice "ok" (${JSON.stringify(j).slice(0, 80)}).`);
} catch {
  problemi.push(`Il sito non risponde su http://127.0.0.1:${PORTA}/salute.`);
}

// 2. Coda email ferma?
let db = null;
try {
  db = new Database(FILE_DB, { readonly: true, fileMustExist: true });
  const bloccate = db.prepare(
    "SELECT COUNT(*) n FROM outbox WHERE stato = 'in_attesa' AND creato_il < datetime('now', '-6 hours')"
  ).get().n;
  if (bloccate > 0) {
    problemi.push(`${bloccate} email in coda da oltre 6 ore: l'invio potrebbe essere fermo.`);
  }
} catch (e) {
  problemi.push(`Non riesco a leggere il database (${e.message}).`);
} finally {
  db?.close();
}

// 3. Backup recente?
let ultimoBackup = 0;
try {
  for (const f of fs.readdirSync(CARTELLA_BACKUP)) {
    if (!f.endsWith('.enc')) continue;
    const t = fs.statSync(path.join(CARTELLA_BACKUP, f)).mtimeMs;
    if (t > ultimoBackup) ultimoBackup = t;
  }
} catch { /* cartella assente = nessun backup */ }

if (!ultimoBackup) {
  problemi.push(`Nessun backup cifrato in ${CARTELLA_BACKUP}.`);
} else {
  const oreFa = Math.round((Date.now() - ultimoBackup) / 3_600_000);
  if (oreFa > 26) {
    problemi.push(`L'ultimo backup ha ${oreFa} ore: il backup automatico potrebbe essersi inceppato.`);
  }
}

// 4. Disco pieno?
try {
  const s = fs.statfsSync('/');
  const usatoPct = Math.round(100 * (1 - s.bavail / s.blocks));
  if (usatoPct >= 85) problemi.push(`Il disco e' pieno al ${usatoPct}%.`);
} catch { /* niente statfs: si salta */ }

// ---- Esito ----
if (problemi.length === 0) {
  console.log('[controllo-salute] tutto a posto');
  process.exit(0);
}

const testo = 'Il controllo automatico del server ha trovato dei problemi:\n\n'
  + problemi.map((p) => ` - ${p}`).join('\n')
  + '\n\nControlla il server appena puoi.\n\n(messaggio automatico giornaliero)';

console.error('[controllo-salute] PROBLEMI:\n' + problemi.map((p) => ' - ' + p).join('\n'));

if (AVVISA_A) {
  try {
    const scrivi = new Database(FILE_DB);
    const ora = new Date().toISOString();
    scrivi.prepare(
      "INSERT INTO outbox (tipo, payload, prossimo_tentativo, creato_il) VALUES ('email', ?, ?, ?)"
    ).run(JSON.stringify({
      to: AVVISA_A,
      subject: 'Studio Medico — il controllo del server ha trovato qualcosa',
      text: testo,
      avvisoInterno: true
    }), ora, ora);
    scrivi.close();
    console.log(`[controllo-salute] avviso messo in coda per ${AVVISA_A}`);
  } catch (e) {
    console.error(`[controllo-salute] non sono riuscito ad accodare l'avviso: ${e.message}`);
  }
}

process.exit(1);
