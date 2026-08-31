import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { db } from './db.js';
import { config } from './config.js';

/**
 * Copia di sicurezza giornaliera del database.
 *
 * Usa l'API di backup di SQLite invece di copiare il file: una copia fatta con
 * cp mentre qualcuno prenota puo' catturare il database a meta' scrittura e
 * risultare illeggibile proprio nel momento in cui servirebbe.
 *
 * Se e' impostata BACKUP_ENCRYPTION_KEY la copia viene cifrata con AES-256-GCM
 * e sul disco resta solo il file .enc: cosi' una cartella sincronizzata (o un
 * account cloud compromesso) non espone dati sanitari in chiaro. Per rileggere
 * un backup:  node strumenti/decifra-backup.mjs <file.enc>
 */

const CARTELLA = config.cartellaBackup;
const COPIE_DA_TENERE = 14;
const CHIAVE = config.backupEncryptionKey;      // Buffer da 32 byte, oppure null
const MAGIC = Buffer.from('SMB1');              // Studio Medico Backup, formato 1

// Le copie prendono il nome dal database che stiamo copiando, non un "medstudent-"
// scritto fisso. I test girano su data/prova.sqlite, che sta nella stessa cartella
// e quindi finisce nella stessa cartella di backup: con il nome fisso le copie di
// prova, vuote, diventavano indistinguibili da quelle vere, e ruota() le contava
// fra le quattordici da tenere spingendo fuori i backup buoni.
const PREFISSO = `${path.basename(config.dbFile, path.extname(config.dbFile))}-`;

const eUnaCopia = (f) =>
  f.startsWith(PREFISSO) && (f.endsWith('.sqlite') || f.endsWith('.sqlite.enc'));

/** Le copie di questo database, dalla piu' vecchia alla piu' recente. */
const copieEsistenti = () =>
  (fs.existsSync(CARTELLA) ? fs.readdirSync(CARTELLA) : []).filter(eUnaCopia).sort();

const timbro = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

let avvisoChiaveDato = false;
function avvisaChiaveMancante() {
  if (avvisoChiaveDato) return;
  avvisoChiaveDato = true;
  console.warn('[backup] ATTENZIONE: BACKUP_ENCRYPTION_KEY non impostata. ' +
    'Le copie di sicurezza restano IN CHIARO: contengono dati sanitari.');
}

/** Cifra file -> file.enc (MAGIC | IV 12B | ciphertext | tag GCM 16B), poi elimina il chiaro. */
async function cifra(sorgente) {
  const destinazione = `${sorgente}.enc`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', CHIAVE, iv);
  const uscita = fs.createWriteStream(destinazione);
  uscita.write(MAGIC);
  uscita.write(iv);
  await pipeline(fs.createReadStream(sorgente), cipher, uscita, { end: false });
  await new Promise((ris, err) => uscita.end(cipher.getAuthTag(), (e) => (e ? err(e) : ris())));
  fs.unlinkSync(sorgente);
  return destinazione;
}

export async function eseguiBackup() {
  fs.mkdirSync(CARTELLA, { recursive: true });
  const grezzo = path.join(CARTELLA, `${PREFISSO}${timbro()}.sqlite`);

  await db.backup(grezzo);

  let file = grezzo;
  if (CHIAVE) {
    file = await cifra(grezzo);
  } else {
    avvisaChiaveMancante();
  }

  ruota();
  return { file, byte: fs.statSync(file).size, cifrato: Boolean(CHIAVE) };
}

/** Tiene solo le ultime copie: senza questo la cartella cresce all'infinito. */
function ruota() {
  const copie = copieEsistenti().reverse();
  for (const vecchia of copie.slice(COPIE_DA_TENERE)) {
    fs.unlinkSync(path.join(CARTELLA, vecchia));
  }
}

export function statoBackup() {
  if (!fs.existsSync(CARTELLA)) return { copie: 0, ultima: null, cifrati: Boolean(CHIAVE) };

  const copie = copieEsistenti();
  const ultima = copie.at(-1);

  return {
    copie: copie.length,
    cifrati: Boolean(CHIAVE),
    ultima: ultima
      ? { nome: ultima, quando: fs.statSync(path.join(CARTELLA, ultima)).mtime.toISOString() }
      : null,
    cartella: CARTELLA
  };
}

/** Rilegge un backup cifrato. Usata dallo strumento da riga di comando. */
export async function decifraBackup(fileEnc, destinazione) {
  if (!CHIAVE) throw new Error('BACKUP_ENCRYPTION_KEY non impostata: impossibile decifrare.');
  const grezzo = fs.readFileSync(fileEnc);
  if (!grezzo.subarray(0, 4).equals(MAGIC)) throw new Error('File non riconosciuto (magic errato).');
  const iv = grezzo.subarray(4, 16);
  const tag = grezzo.subarray(grezzo.length - 16);
  const corpo = grezzo.subarray(16, grezzo.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', CHIAVE, iv);
  decipher.setAuthTag(tag);
  const chiaro = Buffer.concat([decipher.update(corpo), decipher.final()]);
  fs.writeFileSync(destinazione, chiaro);
  return { file: destinazione, byte: chiaro.length };
}

let timer = null;
const OGNI_ORE = 24;

export function avviaBackup() {
  if (timer) return;
  const tick = () => {
    eseguiBackup()
      .then((r) => console.log(
        `[backup] copia salvata (${Math.round(r.byte / 1024)} kB${r.cifrato ? ', cifrata' : ', IN CHIARO'})`))
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
