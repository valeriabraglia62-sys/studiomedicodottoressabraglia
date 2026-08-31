/**
 * Rilegge una copia di sicurezza cifrata.
 *
 *   node strumenti/decifra-backup.mjs  <percorso-del-file.enc>  [destinazione.sqlite]
 *
 * Serve la stessa BACKUP_ENCRYPTION_KEY con cui e' stata creata, presa dal .env
 * o dall'ambiente. Se la destinazione non e' indicata, il file viene scritto
 * accanto a quello cifrato togliendo l'estensione .enc.
 */
import path from 'path';
import fs from 'fs';
import { decifraBackup } from '../src/backup.js';

const [ , , fileEnc, dest ] = process.argv;

if (!fileEnc) {
  console.error('Uso: node strumenti/decifra-backup.mjs <file.enc> [destinazione.sqlite]');
  process.exit(1);
}
if (!fs.existsSync(fileEnc)) {
  console.error(`File non trovato: ${fileEnc}`);
  process.exit(1);
}

const destinazione = dest || fileEnc.replace(/\.enc$/i, '') ||
  path.join(path.dirname(fileEnc), 'backup-decifrato.sqlite');

try {
  const r = await decifraBackup(fileEnc, destinazione);
  console.log(`OK — scritto ${r.file} (${Math.round(r.byte / 1024)} kB).`);
} catch (err) {
  console.error(`Errore: ${err.message}`);
  process.exit(1);
}
