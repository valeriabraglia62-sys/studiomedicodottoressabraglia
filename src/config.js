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

  // Il sito e' raggiungibile da internet, dietro un proxy o un tunnel che
  // fornisce il lucchetto HTTPS. Da attivare SOLO quando quel lucchetto c'e'
  // davvero: acceso troppo presto rimanderebbe i pazienti a un indirizzo
  // sicuro che ancora non esiste, e nessuno aprirebbe piu' il sito.
  pubblico: {
    https: bool(process.env.SITO_HTTPS),
    // Indirizzo pubblico, es. https://studio-arceto.it — finisce nelle email.
    url: (process.env.SITO_URL || '').trim().replace(/\/+$/, '')
  },

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
    // Due fogli distinti: le visite e le richieste di medicinali stanno su
    // documenti separati. GOOGLE_SHEET_ID resta accettato come ripiego per
    // entrambi, cosi' una vecchia configurazione a foglio unico non si rompe.
    fogli: {
      prenotazione: (process.env.GOOGLE_SHEET_ID_PRENOTAZIONI || process.env.GOOGLE_SHEET_ID || '').trim(),
      medicina: (process.env.GOOGLE_SHEET_ID_MEDICINE || process.env.GOOGLE_SHEET_ID || '').trim()
    },
    credentialsFile: path.resolve(ROOT, process.env.GOOGLE_SERVICE_ACCOUNT_FILE || './google-credentials.json'),
    get ready() {
      return this.enabled
        && Boolean(this.fogli.prenotazione && this.fogli.medicina)
        && fs.existsSync(this.credentialsFile);
    }
  },

  // Moduli Google: la porta d'ingresso che resta aperta anche a sito spento.
  // I fogli delle risposte sono documenti a parte rispetto a quelli dello
  // specchio: qui si legge soltanto, non si scrive mai, cosi' non c'e' modo di
  // rovinare le risposte dei pazienti.
  moduli: {
    enabled: bool(process.env.GOOGLE_MODULI_ENABLED),
    intervalSeconds: Math.max(60, Number(process.env.GOOGLE_MODULI_INTERVAL_SECONDS) || 300),
    fogli: {
      prenotazione: {
        id: (process.env.GOOGLE_MODULO_PRENOTAZIONI_ID || '').trim(),
        // Nome della scheda delle risposte. Google la chiama cosi' da sola.
        scheda: (process.env.GOOGLE_MODULO_PRENOTAZIONI_SCHEDA || 'Risposte del modulo 1').trim()
      },
      medicina: {
        id: (process.env.GOOGLE_MODULO_MEDICINE_ID || '').trim(),
        scheda: (process.env.GOOGLE_MODULO_MEDICINE_SCHEDA || 'Risposte del modulo 1').trim()
      }
    },
    get ready() {
      return this.enabled
        && Boolean(this.fogli.prenotazione.id || this.fogli.medicina.id)
        && fs.existsSync(path.resolve(ROOT, process.env.GOOGLE_SERVICE_ACCOUNT_FILE || './google-credentials.json'));
    }
  },

  dbFile: path.resolve(ROOT, process.env.DB_FILE || 'data/medstudent.sqlite'),

  // Finestra entro cui il paziente non puo' piu' annullare da solo.
  cancellazioneMinutiMinimi: 60
};

export const NOTIFY_EMAIL = config.admin.email || 'valeriabraglia62@gmail.com';
