import fs from 'fs';
import path from 'path';
import { db } from './db.js';
import { config } from './config.js';

/**
 * Copia di sicurezza giornaliera del database.
 *
 * Usa l'API di backup di SQLite invece di copiare il file: una copia fatta con
 * cp mentre qualcuno prenota puo' catturare il database a meta' scrittura e
 * risultare illeggibile proprio nel momento in cui servirebbe.
 */

const CARTELLA = config.cartellaBackup;
const COPIE_DA_TENERE = 14;

// Le copie prendono il nome dal database che stiamo copiando, non un "medstudent-"
// scritto fisso. I test girano su data/prova.sqlite, che sta nella stessa cartella
// e quindi finisce nella stessa cartella di backup: con il nome fisso le copie di
// prova, vuote, diventavano indistinguibili da quelle vere, e ruota() le contava
// fra le quattordici da tenere spingendo fuori i backup buoni. Quattordici
// esecuzioni dei test e non restava una copia utile.
const PREFISSO = `${path.basename(config.dbFile, path.extname(config.dbFile))}-`;

/** Le copie di questo database, dalla piu' vecchia alla piu' recente. */
const copieEsistenti = () =>
  fs.readdirSync(CARTELLA)
    .filter((f) => f.startsWith(PREFISSO) && f.endsWith('.sqlite'))
    .sort();

const timbro = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

export async function eseguiBackup() {
  fs.mkdirSync(CARTELLA, { recursive: true });
  const destinazione = path.join(CARTELLA, `${PREFISSO}${timbro()}.sqlite`);

  await db.backup(destinazione);
  ruota();

  return { file: destinazione, byte: fs.statSync(destinazione).size };
}

/** Tiene solo le ultime copie: senza questo la cartella cresce all'infinito. */
function ruota() {
  const copie = copieEsistenti().reverse();

  for (const vecchia of copie.slice(COPIE_DA_TENERE)) {
    fs.unlinkSync(path.join(CARTELLA, vecchia));
  }
}

export function statoBackup() {
  if (!fs.existsSync(CARTELLA)) return { copie: 0, ultima: null };

  const copie = copieEsistenti();
  const ultima = copie.at(-1);

  return {
    copie: copie.length,
    ultima: ultima ? { nome: ultima, quando: fs.statSync(path.join(CARTELLA, ultima)).mtime.toISOString() } : null,
    cartella: CARTELLA
  };
}

let timer = null;
const OGNI_ORE = 24;

export function avviaBackup() {
  if (timer) return;
  const tick = () => {
    eseguiBackup()
      .then((r) => console.log(`[backup] copia salvata (${Math.round(r.byte / 1024)} kB)`))
      .catch((err) => console.error('[backup]', err));
  };
  timer = setInterval(tick, OGNI_ORE * 3600_000);
  timer.unref?.();
  tick();
}

export function fermaBackup() {
  if (timer) clearInterval(timer);
  timer = null;
}
