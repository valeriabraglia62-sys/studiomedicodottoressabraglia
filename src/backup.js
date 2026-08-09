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

const CARTELLA = path.join(path.dirname(config.dbFile), 'backup');
const COPIE_DA_TENERE = 14;

const timbro = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

export async function eseguiBackup() {
  fs.mkdirSync(CARTELLA, { recursive: true });
  const destinazione = path.join(CARTELLA, `medstudent-${timbro()}.sqlite`);

  await db.backup(destinazione);
  ruota();

  return { file: destinazione, byte: fs.statSync(destinazione).size };
}

/** Tiene solo le ultime copie: senza questo la cartella cresce all'infinito. */
function ruota() {
  const copie = fs.readdirSync(CARTELLA)
    .filter((f) => f.startsWith('medstudent-') && f.endsWith('.sqlite'))
    .sort()
    .reverse();

  for (const vecchia of copie.slice(COPIE_DA_TENERE)) {
    fs.unlinkSync(path.join(CARTELLA, vecchia));
  }
}

export function statoBackup() {
  if (!fs.existsSync(CARTELLA)) return { copie: 0, ultima: null };

  const copie = fs.readdirSync(CARTELLA)
    .filter((f) => f.startsWith('medstudent-') && f.endsWith('.sqlite'))
    .sort();
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
