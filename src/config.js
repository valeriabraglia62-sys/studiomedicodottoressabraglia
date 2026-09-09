import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const lista = (v) => String(v || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

function requireSecret() {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  throw new Error(
    'SESSION_SECRET mancante o troppo corta in .env.\n' +
    'Generane una con:  openssl rand -hex 32'
  );
}

const FILE_ARCHIVIO = path.resolve(ROOT, process.env.DB_FILE || 'data/medstudent.sqlite');

const inProduzione = String(process.env.NODE_ENV || '').toLowerCase() === 'production';

export const config = {
  port: Number(process.env.PORT) || 3000,
  // Su quale interfaccia ascolta il processo. In produzione dietro un reverse
  // proxy va messo a 127.0.0.1: da fuori si passa sempre dal proxy. Il valore
  // predefinito 0.0.0.0 tiene funzionante l'accesso dalla rete di studio.
  bindHost: (process.env.BIND_HOST || '').trim() || '0.0.0.0',
  sessionSecret: requireSecret(),

  // Come si chiama lo studio: finisce nel mittente delle email, nel titolo
  // delle pagine e nelle risposte del chatbot. Sta qui in un posto solo
  // perche' un nome scritto a mano in dieci file, prima o poi, in uno dei
  // dieci resta quello vecchio.
  nomeStudio: (process.env.NOME_STUDIO || '').trim() || 'Studio Medico Dottoressa Braglia',

  // Il sito e' raggiungibile da internet, dietro un proxy o un tunnel che
  // fornisce il lucchetto HTTPS. L'HTTP locale va richiesto esplicitamente:
  // una configurazione incompleta deve chiudere l'accesso, non esporre dati.
  pubblico: {
    // Fail closed: l'HTTP va scelto esplicitamente, per esempio nei test locali.
    https: process.env.SITO_HTTPS === undefined ? true : String(process.env.SITO_HTTPS).trim().toLowerCase() !== 'false',
    // Indirizzo pubblico, es. https://studio-arceto.it — finisce nelle email.
    url: (process.env.SITO_URL || '').trim().replace(/\/+$/, ''),
    hostAmmessi: lista(process.env.HOST_AMMESSI),

    // Quanti proxy stanno davanti al sito (il tunnel Cloudflare conta come 1).
    //
    // Da questo numero dipende da dove il server prende l'indirizzo di chi
    // chiama, e quindi se i freni anti-abuso funzionano davvero.
    //
    // Con un proxy davanti l'indirizzo vero non e' quello della connessione —
    // quella arriva dal tunnel — ma sta scritto nell'intestazione
    // X-Forwarded-For, che il proxy compila per noi.
    //
    // Senza proxy davanti quell'intestazione non e' piu' una testimonianza:
    // se la accettassimo, chiunque potrebbe scriversela da solo e presentarsi
    // a ogni tentativo come un indirizzo nuovo, rendendo i freni inutili.
    // Per questo il valore predefinito e' zero: si crede solo alla connessione.
    proxyDavanti: Math.max(0, Math.trunc(Number(process.env.PROXY_DAVANTI) || 0))
  },

  admin: {
    email: (process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
    // Usata solo al primo avvio per creare l'account; poi resta solo l'hash nel database.
    initialPassword: process.env.ADMIN_PASSWORD || '',
    resetOnce: String(process.env.ADMIN_PASSWORD_RESET || '').trim().toLowerCase() === 'once'
  },

  // Account della segreteria: vede l'agenda e gestisce ricette ed email,
  // ma non i motivi delle visite ne' le statistiche.
  segreteria: {
    email: (process.env.SEGRETARIA_EMAIL || '').trim().toLowerCase(),
    initialPassword: process.env.SEGRETARIA_PASSWORD || '',
    resetOnce: String(process.env.SEGRETARIA_PASSWORD_RESET || '').trim().toLowerCase() === 'once'
  },

  email: {
    user: (process.env.EMAIL_USER || '').trim(),
    pass: (process.env.EMAIL_PASS || '').trim(),
    get enabled() {
      return Boolean(this.user && this.pass && this.user !== 'your-email@gmail.com');
    }
  },

  dbFile: FILE_ARCHIVIO,

  // Dove finiscono le copie di sicurezza. Il valore predefinito le tiene accanto
  // all'archivio: comodo, ma non protegge dal guasto del disco, perche' se salta
  // quello saltano insieme l'originale e tutte le copie. Puntandola a una
  // cartella sincronizzata, per esempio OneDrive, le copie escono dalla
  // macchina. Il percorso puo' essere assoluto oppure relativo alla radice del
  // progetto.
  cartellaBackup: path.resolve(
    ROOT,
    process.env.CARTELLA_BACKUP || path.join(path.dirname(FILE_ARCHIVIO), 'backup')
  ),

  // Chiave per cifrare le copie di sicurezza (AES-256-GCM): 64 caratteri esa =
  // 32 byte. Generala una volta sola con  openssl rand -hex 32  e conservala
  // FUORI dalla macchina e fuori dalla cartella dei backup — senza, un backup
  // cifrato non si recupera.
  // In produzione (NODE_ENV=production) e' OBBLIGATORIA: senza, il programma
  // non parte, per non scrivere a lungo dati sanitari in chiaro su disco. Fuori
  // produzione la sua assenza e' solo un avviso a ogni avvio.
  backupEncryptionKey: (() => {
    const raw = (process.env.BACKUP_ENCRYPTION_KEY || '').trim();
    if (!raw) {
      if (inProduzione) {
        throw new Error('In produzione BACKUP_ENCRYPTION_KEY e\' obbligatoria (openssl rand -hex 32).');
      }
      return null;
    }
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
      throw new Error('BACKUP_ENCRYPTION_KEY deve essere 64 caratteri esadecimali (openssl rand -hex 32).');
    }
    return Buffer.from(raw, 'hex');
  })(),

  // Finestra entro cui il paziente non puo' piu' annullare da solo.
  cancellazioneMinutiMinimi: 60
};

/**
 * Dove arrivano gli avvisi allo studio.
 *
 * Era la stessa riga con cui si entra nel pannello, e le due cose non sono la
 * stessa cosa: spostare la posta su un'altra casella avrebbe voluto dire
 * cambiare anche le credenziali di accesso, e rischiare di restare chiusi
 * fuori dal proprio pannello per aver cambiato indirizzo email.
 *
 * Adesso ha la sua riga nel .env. Se manca si torna all'indirizzo
 * dell'amministratore, come e' sempre stato, e in ultima istanza alla casella
 * da cui il programma scrive: un indirizzo scritto qui dentro a mano sarebbe
 * il posto dove la posta di uno studio finisce per sbaglio a una persona che
 * non c'entra piu' niente.
 */
export const NOTIFY_EMAIL = (process.env.NOTIFY_EMAIL || '').trim().toLowerCase()
  || config.admin.email
  || config.email.user.toLowerCase();
