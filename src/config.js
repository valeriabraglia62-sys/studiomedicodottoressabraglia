import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

const bool = (v, def = false) => (v === undefined ? def : /^(1|true|si|sì|yes)$/i.test(String(v).trim()));
const lista = (v) => String(v || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

function requireSecret() {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 32) return s;
  throw new Error(
    'SESSION_SECRET mancante o troppo corta in .env.\n' +
    'Generane una con:  openssl rand -hex 32'
  );
}

/**
 * L'indirizzo pubblico di un Modulo Google, quello che si puo' dare a un
 * paziente.
 *
 * Accetta sia l'identificativo del modulo sia un indirizzo intero, perche' chi
 * lo configura copia quello che ha sotto mano. E quello che ha sotto mano, se
 * ha appena aperto il modulo per modificarlo, e' il link di modifica: finisce
 * per /edit e si porta dietro parametri come ouid, che e' l'identificativo
 * dell'account Google di chi possiede il modulo.
 *
 * Quel link non deve arrivare a un paziente. Quindi non lo si usa com'e': si
 * tiene solo l'identificativo del modulo e si ricostruisce l'indirizzo di
 * compilazione. Un errore di configurazione qui non si vedrebbe finche' non e'
 * troppo tardi, perche' a chi ha gia' i permessi il link di modifica si apre
 * benissimo.
 */
function linkModulo(valore) {
  const v = String(valore || '').trim();
  if (!v) return null;

  // Un link accorciato di Google (forms.gle) e' gia' quello di compilazione e
  // non contiene identificativi da ripulire: si lascia com'e'.
  if (/^https?:\/\/forms\.gle\//i.test(v)) return v;

  const daIndirizzo = v.match(/\/forms\/d\/(e\/)?([A-Za-z0-9_-]+)/);
  const id = daIndirizzo ? daIndirizzo[2] : (/^[A-Za-z0-9_-]{20,}$/.test(v) ? v : null);
  if (!id) return null;

  // Il pezzo "/e/" va tenuto, e non e' un dettaglio: gli identificativi che
  // cominciano con 1FAIpQL sono quelli del modulo pubblicato e vivono solo
  // sotto /forms/d/e/. Ricostruire l'indirizzo senza quel pezzo darebbe una
  // pagina che non si apre — e il guaio si vedrebbe solo il giorno in cui il
  // sito e' spento e qualcuno prova a usarlo davvero.
  const pubblicato = Boolean(daIndirizzo?.[1]) || id.startsWith('1FAIpQL');

  return `https://docs.google.com/forms/d/${pubblicato ? 'e/' : ''}${id}/viewform`;
}

const FILE_ARCHIVIO = path.resolve(ROOT, process.env.DB_FILE || 'data/medstudent.sqlite');

export const config = {
  port: Number(process.env.PORT) || 3000,
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

  inbox: {
    enabled: bool(process.env.INBOX_POLLING_ENABLED),
    intervalSeconds: Math.max(30, Number(process.env.INBOX_POLL_INTERVAL_SECONDS) || 120),
    massimoByteMessaggio: Math.max(1024 * 1024,
      Number(process.env.INBOX_MAX_MESSAGE_BYTES) || 15 * 1024 * 1024)
  },

  sheets: {
    enabled: bool(process.env.GOOGLE_SHEETS_ENABLED),
    /**
     * Un foglio per tipo di richiesta, come sono separati i Moduli.
     *
     * Prima specialistiche ed esami finivano nel foglio dei medicinali, perche'
     * per il programma sono la stessa cosa: chi guardava il foglio ci trovava
     * "Visita cardiologica di controllo" nella colonna "Medicinali", e per
     * capire di cosa si trattasse doveva leggere il prefisso del codice.
     *
     * I due fogli nuovi possono mancare, e non e' un guasto: finche' l'ID non
     * c'e' le righe restano in coda e partono da sole il giorno che si aggiunge.
     * GOOGLE_SHEET_ID resta accettato come ripiego per visite e medicinali,
     * cosi' una vecchia configurazione a foglio unico non si rompe.
     */
    fogli: {
      prenotazione: (process.env.GOOGLE_SHEET_ID_PRENOTAZIONI || process.env.GOOGLE_SHEET_ID || '').trim(),
      medicina: (process.env.GOOGLE_SHEET_ID_MEDICINE || process.env.GOOGLE_SHEET_ID || '').trim(),
      specialistica: (process.env.GOOGLE_SHEET_ID_SPECIALISTICHE || '').trim(),
      esami: (process.env.GOOGLE_SHEET_ID_ESAMI || '').trim()
    },
    credentialsFile: path.resolve(ROOT, process.env.GOOGLE_SERVICE_ACCOUNT_FILE || './google-credentials.json'),
    get ready() {
      // I due fogli storici bastano a dire che il collegamento e' in piedi: se
      // mancassero quelli nuovi si spegnerebbe anche cio' che gia' funziona.
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
      },
      specialistica: {
        id: (process.env.GOOGLE_MODULO_SPECIALISTICHE_ID || '').trim(),
        scheda: (process.env.GOOGLE_MODULO_SPECIALISTICHE_SCHEDA || 'Risposte del modulo 1').trim()
      },
      esami: {
        id: (process.env.GOOGLE_MODULO_ESAMI_ID || '').trim(),
        scheda: (process.env.GOOGLE_MODULO_ESAMI_SCHEDA || 'Risposte del modulo 1').trim()
      }
    },

    // Gli indirizzi da dare ai pazienti quando il sito non risponde. Sono i
    // moduli veri e propri, ospitati da Google: restano raggiungibili anche se
    // questa macchina e' spenta, ed e' esattamente il motivo per cui esistono.
    //
    // Diversi dagli identificativi qui sopra, che sono i fogli delle risposte:
    // quelli servono al programma per leggere, questi servono alle persone per
    // scrivere. Vanno tenuti separati anche perche' un foglio di risposte non
    // va mai dato in mano a un paziente.
    link: {
      prenotazione: linkModulo(process.env.MODULO_PRENOTAZIONI_LINK),
      medicina: linkModulo(process.env.MODULO_MEDICINE_LINK),
      specialistica: linkModulo(process.env.MODULO_SPECIALISTICHE_LINK),
      esami: linkModulo(process.env.MODULO_ESAMI_LINK)
    },

    get ready() {
      // Basta un foglio configurato: i moduli si aggiungono uno alla volta, e
      // pretenderli tutti e quattro spegnerebbe anche quelli gia' funzionanti
      // il giorno in cui se ne aggiunge uno nuovo.
      return this.enabled
        && Object.values(this.fogli).some((f) => f.id)
        && fs.existsSync(path.resolve(ROOT, process.env.GOOGLE_SERVICE_ACCOUNT_FILE || './google-credentials.json'));
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
  // cifrato non si recupera. Se manca, le copie restano in chiaro e il
  // programma lo segnala a ogni avvio.
  backupEncryptionKey: (() => {
    const raw = (process.env.BACKUP_ENCRYPTION_KEY || '').trim();
    if (!raw) return null;
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
