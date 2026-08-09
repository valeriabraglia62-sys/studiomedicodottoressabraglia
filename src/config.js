import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const bool = (v, def = false) => (v === undefined ? def : /^(1|true|si|sì|yes)$/i.test(String(v).trim()));

function requireSecret() {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  throw new Error(
    'SESSION_SECRET mancante o troppo corta in .env.\n' +
    'Generane una con:  openssl rand -hex 32'
  );
}

export const config = {
  port: Number(process.env.PORT) || 3000,
  sessionSecret: requireSecret(),

  admin: {
    email: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
    // Usata solo al primo avvio per creare l'account; poi resta solo l'hash nel database.
    initialPassword: process.env.ADMIN_PASSWORD || ''
  },

  // Account della segreteria: vede l'agenda e gestisce ricette ed email,
  // ma non i motivi delle visite ne' le statistiche.
  segreteria: {
    email: (process.env.SEGRETARIA_EMAIL || '').trim().toLowerCase(),
    initialPassword: process.env.SEGRETARIA_PASSWORD || ''
  },

  email: {
    user: (process.env.EMAIL_USER || '').trim(),
    pass: (process.env.EMAIL_PASS || '').trim(),
    get enabled() {
      return Boolean(this.user && this.pass && this.user !== 'your-email@gmail.com');
    }
  },

  inbox: {
    enabled: bool(process.env.INBOX_POLLING_ENABLED),
    intervalSeconds: Math.max(30, Number(process.env.INBOX_POLL_INTERVAL_SECONDS) || 120)
  },

  sheets: {
    enabled: bool(process.env.GOOGLE_SHEETS_ENABLED),
    sheetId: (process.env.GOOGLE_SHEET_ID || '').trim(),
    credentialsFile: path.resolve(ROOT, process.env.GOOGLE_SERVICE_ACCOUNT_FILE || './google-credentials.json'),
    get ready() {
      return this.enabled && Boolean(this.sheetId) && fs.existsSync(this.credentialsFile);
    }
  },

  dbFile: path.resolve(ROOT, process.env.DB_FILE || 'data/medstudent.sqlite'),

  // Finestra entro cui il paziente non puo' piu' annullare da solo.
  cancellazioneMinutiMinimi: 60
};

export const NOTIFY_EMAIL = config.admin.email || 'valeriabraglia62@gmail.com';
