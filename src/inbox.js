import { db } from './db.js';
import { config, NOTIFY_EMAIL } from './config.js';
import { accoda, registraGestore } from './outbox.js';
import { generaCodice, ErroreDominio, telefonoValido } from './prenotazioni.js';
import { creaRichiesta, allegaFile } from './medicine.js';

/**
 * Rete di sicurezza sulla casella in arrivo.
 *
 * Le richieste fatte dal sito finiscono gia' su database e Foglio Google senza
 * passare dall'email. Questo modulo serve solo a intercettare chi scrive a mano
 * allo studio: ogni messaggio viene salvato integralmente, anche se non se ne
 * capisce il contenuto, cosi' nulla puo' sfuggire.
 */

/**
 * Le parole si dividono in due gruppi perche' non pesano uguale.
 *
 * "Ricetta" o "appuntamento" in una email allo studio vogliono dire una cosa
 * sola. "Controllo", "disponibile", "visita", "terapia" invece sono parole
 * dell'italiano di tutti i giorni: comparivano negli avvisi della banca e nelle
 * newsletter, e bastava una di quelle per far archiviare l'avviso di un bonifico
 * come se fosse un paziente che chiede una visita.
 *
 * Quindi: senza almeno una parola forte non si indovina niente e l'email resta
 * "altro". Le deboli non decidono da sole, servono solo a sciogliere il dubbio
 * fra medicinali e prenotazione quando una parola forte c'e' gia'.
 */
const MEDICINE_FORTI = ['medicin', 'farmac', 'ricett', 'prescriz', 'impegnativ', 'piano terapeutico'];
const MEDICINE_DEBOLI = ['pastigl', 'compress', 'sciroppo', 'pillol', 'terapia'];
const PRENOTAZIONE_FORTI = ['prenot', 'appuntament'];
const PRENOTAZIONE_DEBOLI = ['visita', 'controllo', 'disponibil', 'fissare'];

const conta = (testo, parole) => parole.filter((p) => testo.includes(p)).length;

function classifica(oggetto, corpo) {
  const t = `${oggetto || ''} ${corpo || ''}`.toLowerCase();

  const medForti = conta(t, MEDICINE_FORTI);
  const preForti = conta(t, PRENOTAZIONE_FORTI);
  if (medForti === 0 && preForti === 0) return 'altro';

  // Una parola forte vale quanto due deboli: e' il modo piu' semplice di dire
  // che a decidere e' lei, e che le deboli contano solo a parita' di forti.
  const med = medForti * 2 + conta(t, MEDICINE_DEBOLI);
  const pre = preForti * 2 + conta(t, PRENOTAZIONE_DEBOLI);
  return med >= pre ? 'medicina' : 'prenotazione';
}

/**
 * Riconosce la posta che non e' una richiesta di un paziente, per non
 * rimbalzarla dentro come se lo fosse.
 *
 * Prima qui c'era anche un elenco di oggetti da riconoscere ("nuova
 * prenotazione", "ricetta pronta"...), e ogni email nuova che imparavamo a
 * mandare andava aggiunta a mano a quell'elenco. Nessuno se ne ricordava:
 * "Spostata: ..." non c'era, e le notifiche degli spostamenti hanno iniziato a
 * ricomparire fra le email da leggere come se le avesse scritte un paziente.
 *
 * L'elenco era la parte fragile e se n'e' andato. Resta il fatto che conta:
 * mandiamo dalla stessa casella che leggiamo, quindi una email che arriva dal
 * nostro indirizzo l'abbiamo scritta noi — qualunque sia l'oggetto.
 */
function eNostraNotifica(mittente) {
  const indirizzo = (mittente || '').toLowerCase();
  if (!indirizzo) return true;
  if (indirizzo === config.email.user.toLowerCase()) return true;
  if (indirizzo === NOTIFY_EMAIL.toLowerCase()) return true;

  // Avvisi di mancata consegna: parlano di una nostra email tornata indietro,
  // non di un paziente che chiede qualcosa. Vanno guardati, ma nel registro
  // della coda, non nella scrivania di chi risponde ai pazienti.
  return /^(mailer-daemon|postmaster|no-?reply|noreply)@/.test(indirizzo);
}

/**
 * Posta che non e' mai una richiesta di paziente: notifiche di Google
 * (condivisioni di Fogli e Moduli, inviti, trasferimenti di proprieta'),
 * newsletter e simili. Prima passavano dal classificatore e, siccome nel
 * testo c'era "Prenotazione visita" (il nome del Modulo) o "appuntamento"
 * (una promozione), finivano in "Da confermare" come richieste vere.
 */
const LOCALI_AUTOMATICI = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'drive-shares-dm', 'drive-shares', 'forms-receipts', 'comments-noreply',
  'calendar-notification', 'notifications', 'notification', 'mailer', 'bounce'
];
const DOMINI_AUTOMATICI = [
  'google.com', 'docs.google.com', 'drive.google.com', 'apps.google.com',
  'youtube.com', 'facebookmail.com', 'linkedin.com', 'toogoodtogo.it',
  'sendgrid.net', 'mailchimp.com', 'amazonses.com'
];
const OGGETTI_NON_RICHIESTA = [
  'condiviso con te', 'shared with you', 'ha condiviso un', 'has shared',
  'invito a rispondere', 'invito ad assumere', 'invitation to', 'ti ha invitato',
  'assumere la proprieta', 'assumere la proprietà', 'richiesta di accesso',
  'request for access', 'accesso al documento', 'in regalo', 'newsletter'
];

function eNotificaAutomatica(mittente, oggetto) {
  const ind = (mittente || '').toLowerCase();
  const [locale = '', dominio = ''] = ind.split('@');
  if (LOCALI_AUTOMATICI.some((p) => locale.includes(p))) return true;
  if (DOMINI_AUTOMATICI.some((d) => dominio === d || dominio.endsWith(`.${d}`))) return true;

  const ogg = (oggetto || '').toLowerCase();
  return OGGETTI_NON_RICHIESTA.some((p) => ogg.includes(p));
}

function estraiNome(mittenteNome, mittente) {
  const base = (mittenteNome || mittente.split('@')[0] || '').replace(/[._]+/g, ' ').trim();
  const parti = base.split(/\s+/).filter(Boolean);
  return {
    nome: parti[0] ? parti[0][0].toUpperCase() + parti[0].slice(1) : 'Paziente',
    cognome: parti.length > 1
      ? parti.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join(' ')
      : '(da email)'
  };
}

/**
 * Il numero di telefono, pescato da un'email che non ha campi.
 *
 * Si cerca in tre modi, in ordine di quanto ci si puo' fidare.
 *
 * 1. Un cellulare italiano scritto per esteso: comincia per 3 e ha dieci cifre.
 *    E' l'unica forma che si riconosce senza rischiare di sbagliare.
 *
 * 2. Un numero qualsiasi, ma solo se annunciato da una parola: "tel. 0522
 *    123456", "il mio numero e' ...". Il fisso da solo non si cerca, e non e'
 *    pigrizia: una data scritta 09.08.2026 diventa otto cifre di fila e
 *    passerebbe per un numero valido. Un telefono sbagliato in archivio e'
 *    peggio di nessun telefono — si chiama e risponde un estraneo, mentre il
 *    paziente aspetta.
 *
 * 3. Quello che sappiamo gia'. Se da quell'indirizzo email e' gia' passato
 *    qualcuno, il suo numero e' in archivio: la maggior parte di chi scrive per
 *    prenotare non lo mette, perche' da' per scontato che lo studio ce l'abbia.
 *    E infatti spesso ce l'ha.
 */
function estraiTelefono(testo, email = null) {
  const pulisci = (s) => String(s).replace(/[\s.\-()]/g, '');

  const cellulare = String(testo).match(/(?:\+39\s?)?\b3\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3,4}\b/);
  if (cellulare) return pulisci(cellulare[0]);

  const annunciato = String(testo).match(
    /(?:tel(?:efono)?|cell(?:ulare)?|numero|recapito)\W{0,4}((?:\+39[\s.\-]?)?\d[\d\s.\-]{6,13})/i);
  if (annunciato && telefonoValido(pulisci(annunciato[1]))) return pulisci(annunciato[1]);

  if (email) {
    const noto = db.prepare(`
      SELECT telefono FROM pazienti
       WHERE lower(email) = lower(?) AND telefono IS NOT NULL AND telefono <> ''
       ORDER BY id DESC LIMIT 1
    `).get(String(email).trim());
    if (noto) return noto.telefono;
  }

  return null;
}

/**
 * I file arrivati insieme all'email, ridotti a quelli che sono davvero documenti.
 *
 * In fondo a mezza posta italiana c'e' il logo dello studio, la firma con la
 * faccia e l'informativa privacy in PNG: sono immagini richiamate dall'HTML del
 * messaggio, e mailparser le segna come "related". Attaccarle alla richiesta
 * vorrebbe dire riempire il pannello di stemmi, e chi cerca la prescrizione fra
 * cinque anteprime uguali finisce per non guardarne nessuna.
 */
const documentiVeri = (allegati) => (allegati || []).filter(
  (a) => !a.related && a.contentDisposition !== 'inline' && a.content?.length
);

/**
 * Attacca alla richiesta i file arrivati per email.
 *
 * Un allegato che non passa non deve far fallire l'importazione: il messaggio e'
 * gia' arrivato e la richiesta esiste. Peggio ancora, un'eccezione qui
 * annullerebbe la transazione e l'email verrebbe riscaricata al giro dopo, per
 * sempre. Quindi si prende quello che si riesce a prendere; il testo del
 * messaggio resta comunque sulla scrivania, con dentro il nome di cio' che e'
 * stato scartato.
 */
function attaccaAllaRichiesta(richiestaId, allegati) {
  const scartati = [];
  for (const a of documentiVeri(allegati)) {
    try {
      allegaFile(richiestaId, { nome: a.filename || 'allegato', contenuto: a.content });
    } catch (err) {
      if (!(err instanceof ErroreDominio)) throw err;
      scartati.push(a.filename || 'senza nome');
    }
  }
  return scartati;
}

const stmtGiaVista = db.prepare('SELECT 1 FROM email_processate WHERE message_id = ?');

const stmtSegnaVista = db.prepare(
  'INSERT OR IGNORE INTO email_processate (message_id, ricevuta_il, esito, riferimento) VALUES (?, ?, ?, ?)'
);

/** Un messaggio gia' passato da qui, qualunque sia stata la conclusione. */
export const giaVista = (messageId) => Boolean(messageId && stmtGiaVista.get(messageId));

/** Salva l'email e, se e' una richiesta di medicinali, la converte subito. */
export function registraEmail({ messageId, mittente, mittenteNome, oggetto, corpo, ricevutaIl, allegati }) {
  if (messageId && stmtGiaVista.get(messageId)) return { saltata: true };

  // Il controllo sta qui, non nel giro di lettura: e' questa la funzione che
  // scrive sulla scrivania, e una difesa messa un passo prima protegge solo chi
  // passa da quel passo. Chiunque un domani chiami registraEmail da un'altra
  // strada trova comunque la porta chiusa.
  if (eNostraNotifica(mittente)) return { saltata: true };

  // Notifiche automatiche (Google Drive/Moduli, newsletter): non arrivano
  // nemmeno al classificatore, altrimenti il nome del Modulo "Prenotazione
  // visita" nel testo le farebbe passare per richieste.
  if (eNotificaAutomatica(mittente, oggetto)) {
    if (messageId) stmtSegnaVista.run(messageId, new Date().toISOString(), 'ignorata', null);
    return { ignorata: true, tipo: 'altro' };
  }

  const tipo = classifica(oggetto, corpo);

  // Il programma prende solo quello che riconosce. Una richiesta di un paziente
  // ha parole precise — prenotazione, appuntamento, medicinali, ricetta — e su
  // quelle si decide; tutto il resto e' posta che non lo riguarda, e prima
  // finiva lo stesso sulla scrivania, seppellendo le tre righe che contavano
  // sotto le newsletter.
  //
  // Nota per chi legge: questa e' una porta chiusa, non un cestino. Il messaggio
  // resta intatto in casella — non viene ne' cancellato ne' segnato come letto —
  // e chi guarda la posta lo trova dov'e' sempre stato. Qui si annota soltanto
  // "questo l'ho gia' guardato e non mi riguarda", altrimenti la stessa email
  // verrebbe riscaricata e riesaminata a ogni giro, per sempre.
  if (tipo === 'altro') {
    if (messageId) {
      stmtSegnaVista.run(messageId, new Date().toISOString(), 'ignorata', null);
    }
    return { ignorata: true, tipo };
  }

  const codice = generaCodice('EML');
  const adesso = new Date().toISOString();

  const transazione = db.transaction(() => {
    let collegata = null;

    if (tipo === 'medicina') {
      const { nome, cognome } = estraiNome(mittenteNome, mittente);
      try {
        const richiesta = creaRichiesta({
          nome, cognome, email: mittente,
          telefono: estraiTelefono(corpo, mittente) || '',
          farmaci: (oggetto ? `${oggetto}\n\n` : '') + corpo.slice(0, 1200),
          note: 'Richiesta ricevuta via email, da verificare.',
          origine: 'email'
        });
        collegata = richiesta.codice;

        // Chi fotografa la ricetta e la manda per email fa lo stesso gesto di
        // chi la carica dal sito, e il file deve finire nello stesso posto:
        // dentro la richiesta, dove chi risponde lo trova senza dover tornare
        // in casella a cercare il messaggio originale.
        const scartati = attaccaAllaRichiesta(richiesta.id, allegati);
        if (scartati.length) {
          db.prepare('UPDATE richieste_medicine SET note = ? WHERE id = ?').run(
            'Richiesta ricevuta via email, da verificare. '
            + `Allegati non leggibili, guardali in casella: ${scartati.join(', ')}`.slice(0, 400),
            richiesta.id);
        }
      } catch (err) {
        // Se la conversione automatica non riesce, l'email resta comunque
        // salvata qui sotto e finisce sulla scrivania dell'amministratore.
        if (!(err instanceof ErroreDominio)) throw err;
      }
    }

    db.prepare(`
      INSERT INTO richieste_email
        (codice, message_id, mittente, mittente_nome, oggetto, corpo, tipo, collegata_a, ricevuta_il)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(codice, messageId || null, mittente, mittenteNome || null,
      oggetto || null, corpo.slice(0, 20000), tipo, collegata, ricevutaIl || adesso);

    /**
     * Un'email di prenotazione va messa in mano a una persona.
     *
     * Le richieste di medicinali qui sopra diventano richieste da sole. Una
     * prenotazione no: nell'email non c'e' un giorno e un'ora in un formato di
     * cui ci si possa fidare, e sceglierli al posto del paziente sarebbe peggio
     * che non farlo. Serve qualcuno che legga e prenoti.
     *
     * Finisce quindi in "Da confermare", nella stessa fila delle richieste
     * arrivate dai Moduli Google mentre il sito era spento: e' esattamente la
     * stessa situazione — qualcosa che aspetta una mano — e mettercela dentro
     * significa che c'e' un posto solo da guardare invece di due. E' anche il
     * motivo per cui la scheda "Email ricevute" ha potuto sparire senza che si
     * perdesse niente: senza questa riga, quelle email non le vedrebbe piu'
     * nessuno.
     *
     * La chiave e' il codice dell'email: rileggendo la casella lo stesso
     * messaggio non si sdoppia.
     */
    if (tipo === 'prenotazione') {
      const { nome, cognome } = estraiNome(mittenteNome, mittente);
      db.prepare(`
        INSERT OR IGNORE INTO richieste_modulo
          (codice, chiave, tipo, nome, cognome, telefono, email, testo, note,
           riga_json, ricevuta_il)
        VALUES (?, ?, 'prenotazione', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        generaCodice('MOD'), `email:${codice}`,
        nome, cognome,
        estraiTelefono(corpo, mittente) || '', mittente,
        (oggetto ? `${oggetto}\n\n` : '') + corpo.slice(0, 1200),
        'Arrivata per email: giorno e ora vanno scelti a mano.',
        JSON.stringify({ da: 'email', codice, oggetto, corpo: corpo.slice(0, 2000) }),
        ricevutaIl || adesso);
    }

    if (messageId) {
      db.prepare('INSERT INTO email_processate (message_id, ricevuta_il, esito, riferimento) VALUES (?, ?, ?, ?)')
        .run(messageId, adesso, collegata ? 'convertita' : 'archiviata', collegata || codice);
    }

    // Anche le email non classificate finiscono nel foglio, come traccia.
    if (!collegata) {
      accoda('sheet_medicina', {
        codice, stato: 'nuova',
        nome: mittenteNome || mittente, cognome: '',
        telefono: estraiTelefono(corpo, mittente) || '', email: mittente,
        farmaci: `[${tipo.toUpperCase()} via email] ${oggetto || ''}`.trim(),
        note: corpo.slice(0, 500), ambulatorio_nome: '',
        origine: 'email', creata_il: adesso, aggiornata_il: null
      });
    }

    return { codice, tipo, collegata };
  });

  return transazione();
}

export function elencoEmail({ stato, pagina = 1, perPagina = 50 } = {}) {
  const filtro = stato ? 'WHERE stato = ?' : '';
  const par = stato ? [stato] : [];
  const totale = db.prepare(`SELECT COUNT(*) AS n FROM richieste_email ${filtro}`).get(...par).n;
  const limite = Math.min(Math.max(Number(perPagina) || 50, 1), 200);
  const offset = (Math.max(Number(pagina) || 1, 1) - 1) * limite;

  return {
    email: db.prepare(`SELECT * FROM richieste_email ${filtro} ORDER BY ricevuta_il DESC LIMIT ? OFFSET ?`)
      .all(...par, limite, offset),
    totale,
    pagine: Math.ceil(totale / limite) || 1
  };
}

/**
 * C'e' gia' un ordine di cestinare in attesa per questa email?
 *
 * Serve perche' i due segni che avremmo per accorgercene arrivano tardi:
 * `cestinata_il` si scrive solo quando lo spostamento e' riuscito, e la coda
 * gira ogni mezzo minuto. In quella finestra un "rimetti da leggere" seguito da
 * un secondo "gestita" — che e' esattamente cosa fa chi ci ripensa — accodava un
 * secondo ordine identico: due connessioni alla casella per spostare lo stesso
 * messaggio, di cui la seconda non lo trova nemmeno piu'.
 */
const ordineInCorso = (codice) => Boolean(db.prepare(`
  SELECT 1 FROM outbox
   WHERE tipo = 'cestina_email' AND stato = 'in_attesa'
     AND json_extract(payload, '$.codice') = ?
   LIMIT 1
`).get(codice));

/**
 * Cambia lo stato di un'email sulla scrivania.
 *
 * "Gestita" vuol dire che la pratica e' chiusa, e la casella deve saperlo: il
 * messaggio vero finisce nel cestino di Gmail. Sul cestino va detta una cosa a
 * voce alta, perche' non e' un archivio: Gmail lo svuota da solo dopo trenta
 * giorni, e da quel momento di quel messaggio non resta niente da nessuna parte
 * — tranne qui, dove il testo e' salvato per intero e non lo tocca nessuno.
 *
 * Lo spostamento passa dalla coda invece di partire subito. Il motivo e' che
 * chi ha premuto il bottone non deve aspettare Gmail, e soprattutto non deve
 * vedere un errore se in quel momento la casella non risponde: la riga resta in
 * coda e ci si riprova da sola. Il pannello ha gia' segnato la pratica chiusa,
 * che e' la cosa che gli interessa.
 */
export function segnaEmail(codice, stato) {
  if (!['nuova', 'gestita', 'archiviata'].includes(stato)) throw new ErroreDominio('Stato non valido.');
  const chiave = String(codice).toUpperCase();

  return db.transaction(() => {
    const r = db.prepare('UPDATE richieste_email SET stato = ?, gestita_il = ? WHERE codice = ?')
      .run(stato, new Date().toISOString(), chiave);
    if (!r.changes) throw new ErroreDominio('Email non trovata.', 404);

    const email = db.prepare('SELECT * FROM richieste_email WHERE codice = ?').get(chiave);

    // Solo "gestita": archiviare e' un gesto interno, la casella non c'entra.
    if (stato === 'gestita' && email.message_id && !email.cestinata_il && !ordineInCorso(chiave)) {
      accoda('cestina_email', { codice: chiave, message_id: email.message_id });
    }

    return email;
  })();
}

// ---- Il cestino di Gmail --------------------------------------------------

/**
 * Sposta nel cestino il messaggio corrispondente a una pratica chiusa.
 *
 * Il messaggio si ritrova dal suo Message-ID, non dal numero progressivo: i
 * numeri valgono solo dentro una sessione e per una cartella sola, il
 * Message-ID e' scritto dentro l'email e resta quello per sempre.
 *
 * Se non lo trova non e' un guasto: vuol dire che qualcuno l'ha gia' spostato a
 * mano, ed e' esattamente il risultato che volevamo. Insistere vorrebbe dire
 * lasciare in coda per sempre una riga che non potra' mai riuscire.
 *
 * La cartella del cestino non si scrive a mano ("[Gmail]/Cestino" cambia con la
 * lingua dell'account): si chiede al server quale delle sue cartelle e' il
 * cestino, che e' una cosa che il protocollo sa dire da solo.
 */
async function cestinaMessaggio({ codice, message_id: messageId }) {
  if (!config.email.enabled) {
    return { rimanda: true, motivo: 'credenziali email non configurate', minuti: 30 };
  }
  if (!messageId) return undefined;

  const { ImapFlow } = await caricaLibreriePosta();
  const client = nuovaConnessione(ImapFlow);
  let spostato = false;

  try {
    await client.connect();

    const cartelle = await client.list();
    const cestino = cartelle.find((c) => c.specialUse === '\\Trash');
    if (!cestino) throw new Error('la casella non dichiara quale cartella sia il cestino');

    const lock = await client.getMailboxLock('INBOX');
    try {
      const uid = await client.search({ header: { 'message-id': messageId } }, { uid: true });
      if (uid?.length) {
        await client.messageMove(uid, cestino.path, { uid: true });
        spostato = true;
      }
    } finally {
      lock.release();
    }
  } finally {
    // Chiusura secca: logout() puo' restare in attesa di una risposta che non
    // arriva mai, e questa gira dentro il worker della coda.
    client.close();
  }

  // La data si scrive solo se il messaggio l'abbiamo spostato noi davvero.
  // Se non c'era, il lavoro e' comunque finito — ma il pannello non deve
  // raccontare un gesto che non abbiamo fatto.
  if (spostato) {
    db.prepare('UPDATE richieste_email SET cestinata_il = ? WHERE codice = ?')
      .run(new Date().toISOString(), codice);
  }
  return undefined;
}

registraGestore('cestina_email', cestinaMessaggio);

// ---- Polling IMAP ---------------------------------------------------------

let inCorso = false;
let timer = null;
let ultimoEsito = { mai_eseguito: true };

export const superaLimiteMessaggio = (byte) =>
  Number(byte || 0) > config.inbox.massimoByteMessaggio;
// La connessione del giro in corso, per poterla chiudere se sfora il tempo.
let clientAttivo = null;

// Limite invalicabile per un giro di lettura. I timeout di ImapFlow coprono la
// connessione, non l'intera sessione: se il server accetta e poi tace, senza
// questo il controllo resterebbe appeso e la lettura si fermerebbe per sempre.
const TEMPO_MASSIMO_MS = 90_000;

// Quanti giorni di posta si riguardano a ogni giro. Sette e non uno: se il
// programma resta spento per un fine settimana, al ritorno deve ritrovare anche
// quello che e' arrivato mentre non c'era. Riguardare non costa, perche' di
// ogni messaggio si chiede prima solo la busta e quelli gia' visti si saltano.
const GIORNI_DA_GUARDARE = 7;

// Tetto ai messaggi esaminati in un giro, per non restare appesi su una casella
// molto piena. Si prendono i piu' recenti: restare indietro sui vecchi e' meno
// grave che perdere quelli appena arrivati.
const MASSIMO_PER_GIRO = 80;

/**
 * Le librerie per leggere la posta si caricano al primo controllo, non all'avvio.
 *
 * Sono grosse: pesavano minuti sull'accensione del server, e li pesavano sempre,
 * anche con la lettura della casella spenta. Ora il sito e' online in pochi
 * secondi e il costo si paga una volta sola, in sottofondo, solo se serve.
 */
let libreriePosta = null;

function caricaLibreriePosta() {
  if (!libreriePosta) {
    libreriePosta = Promise.all([import('imapflow'), import('mailparser')])
      .then(([imap, parser]) => ({ ImapFlow: imap.ImapFlow, simpleParser: parser.simpleParser }))
      .catch((err) => { libreriePosta = null; throw err; });
  }
  return libreriePosta;
}

function nuovaConnessione(ImapFlow) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: config.email.user, pass: config.email.pass },
    logger: false,
    // Senza questi limiti una connessione che non risponde resta appesa per
    // sempre: chi la sta usando non tornerebbe mai libero e il lavoro si
    // fermerebbe in silenzio, proprio la cosa da evitare.
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 60000
  });

  /**
   * Senza questo ascoltatore il server scriveva "[fatale] promise rifiutata".
   *
   * Quando la connessione cade a meta' apertura, ImapFlow fa due cose: fa
   * fallire connect() — quello lo raccoglie chi chiama — e poi, da un pezzo di
   * codice che gira per conto suo, chiama emit('error'). Su un EventEmitter
   * senza ascoltatore per 'error' quella chiamata *lancia*, e finiva fra le
   * promise rifiutate come se fosse un guasto grave del server.
   *
   * Non e' un guasto: e' la casella irraggiungibile per un momento. Si annota
   * e si riprova dopo.
   */
  client.on('error', (err) => {
    console.error('[inbox] connessione caduta:', err.message);
  });

  return client;
}

export async function controllaCasella() {
  if (inCorso) return { saltato: true };

  let scadenza;
  const limite = new Promise((_, rifiuta) => {
    scadenza = setTimeout(() => {
      // Non basta smettere di aspettare: bisogna chiudere davvero la
      // connessione. Chiudendola, le attese dentro leggiCasella falliscono,
      // la sua pulizia parte e inCorso si libera da solo. Senza questa riga
      // la lettura resterebbe aperta a vuoto e bloccherebbe tutti i giri
      // successivi.
      try { clientAttivo?.close(); } catch { /* gia' chiusa */ }
      rifiuta(new Error('la casella non ha risposto entro 90 secondi'));
    }, TEMPO_MASSIMO_MS);
  });

  try {
    return await Promise.race([leggiCasella(), limite]);
  } catch (err) {
    ultimoEsito = { ok: false, motivo: err.message, quando: new Date().toISOString() };
    return ultimoEsito;
  } finally {
    clearTimeout(scadenza);
    // inCorso NON si azzera qui. Quando vince il limite dei 90 secondi la
    // lettura vera continua per conto suo: spegnere la spia adesso lascerebbe
    // partire il giro successivo sopra quello ancora aperto, con due sessioni
    // IMAP sulla stessa casella che si marcano i messaggi a vicenda.
    // Lo fa leggiCasella quando ha davvero finito.
  }
}

async function leggiCasella() {
  if (!config.email.enabled) {
    ultimoEsito = { ok: false, motivo: 'credenziali email non configurate' };
    return ultimoEsito;
  }

  // Le librerie si caricano prima di alzare la spia: se l'import fallisse
  // dopo, inCorso resterebbe acceso per sempre e la lettura non ripartirebbe.
  const { ImapFlow, simpleParser } = await caricaLibreriePosta();

  inCorso = true;
  const client = nuovaConnessione(ImapFlow);

  // Serve al limite dei 90 secondi per poterla chiudere da fuori.
  clientAttivo = client;

  let nuove = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Si guardano i messaggi degli ultimi giorni, letti o non letti che siano.
      //
      // Prima si cercavano solo i non letti, e bastava che una persona aprisse
      // l'email in Gmail prima del giro — anche solo per vedere cos'era — perche'
      // il programma non la incontrasse mai piu'. E' successo l'11 agosto 2026:
      // due richieste arrivate alle 8:03, aperte a mano pochi minuti dopo, e per
      // il programma non erano mai esistite.
      //
      // A dire cosa e' gia' stato elaborato adesso e' la tabella
      // email_processate, che tiene il Message-ID di ognuna: e' una memoria
      // nostra, che nessuno puo' cambiare per sbaglio dal telefono. Il
      // contrassegno di lettura torna a essere quello che dovrebbe: una cosa di
      // chi legge la posta, non un pezzo di macchina.
      const daQuando = new Date(Date.now() - GIORNI_DA_GUARDARE * 86400000);
      const uid = await client.search({ since: daQuando }, { uid: true });

      // Dal piu' recente: se un giorno arrivassero piu' messaggi del tetto, e'
      // meglio restare indietro sui vecchi che sui nuovi.
      for (const id of (uid || []).slice(-MASSIMO_PER_GIRO).reverse()) {
        // Prima si chiede solo la busta, che e' poche centinaia di byte, e si
        // guarda se quel Message-ID lo conosciamo gia'. Adesso che la stessa
        // finestra di giorni viene riletta ogni due minuti, scaricare ogni volta
        // il testo di tutti i messaggi vorrebbe dire ripassare gli stessi
        // megabyte tutto il giorno per non trovarci quasi mai niente di nuovo.
        const busta = await client.fetchOne(String(id), { envelope: true, size: true }, { uid: true });
        const idMessaggio = busta?.envelope?.messageId || `uid-${id}`;
        if (giaVista(idMessaggio)) continue;
        if (superaLimiteMessaggio(busta?.size)) {
          stmtSegnaVista.run(idMessaggio, new Date().toISOString(), 'scartata_dimensione', null);
          console.warn('[inbox] messaggio scartato: dimensione oltre il limite configurato');
          continue;
        }

        // Le notifiche di annullamento che il programma manda finiscono nella
        // stessa casella che legge, perche' mittente e destinatario sono lo
        // stesso indirizzo. Restano li' a riempire la posta in arrivo senza
        // dire niente di nuovo: l'annullamento e' gia' registrato, il paziente
        // e' gia' stato avvisato, e chi apre la casella la mattina se le trova
        // in mezzo alle richieste vere. Vanno nel cestino.
        //
        // Solo quelle di annullamento: le conferme di nuove prenotazioni le
        // lasciamo stare, che qualcuno le usa per accorgersi al volo che e'
        // entrata una richiesta senza aprire il pannello.
        const mittenteBusta = busta?.envelope?.from?.[0]?.address || '';
        const oggettoBusta = busta?.envelope?.subject || '';
        if (eNostraNotifica(mittenteBusta) && /^\s*Annullamento:/i.test(oggettoBusta)) {
          accoda('cestina_email', { codice: null, message_id: idMessaggio });
          stmtSegnaVista.run(idMessaggio, new Date().toISOString(), 'cestinata', null);
          continue;
        }

        const msg = await client.fetchOne(String(id), { source: true }, { uid: true });
        if (!msg?.source) continue;
        if (superaLimiteMessaggio(msg.source.length)) {
          stmtSegnaVista.run(idMessaggio, new Date().toISOString(), 'scartata_dimensione', null);
          console.warn('[inbox] messaggio scartato: dimensione oltre il limite configurato');
          continue;
        }

        const mail = await simpleParser(msg.source);
        const mittente = mail.from?.value?.[0]?.address || '';
        const oggetto = mail.subject || '';

        const esito = registraEmail({
          messageId: mail.messageId || idMessaggio,
          mittente,
          mittenteNome: mail.from?.value?.[0]?.name || '',
          oggetto,
          corpo: (mail.text || mail.html?.replace(/<[^>]+>/g, ' ') || '').trim(),
          ricevutaIl: (mail.date || new Date()).toISOString(),
          allegati: mail.attachments
        });

        if (!esito.saltata && !esito.ignorata) nuove++;
      }
    } finally {
      lock.release();
    }

    ultimoEsito = { ok: true, nuove, quando: new Date().toISOString() };
  } catch (err) {
    console.error('[inbox] errore lettura casella:', err.message);
    ultimoEsito = { ok: false, motivo: err.message, quando: new Date().toISOString() };
  } finally {
    // Chiusura secca: logout() puo' a sua volta restare in attesa di una
    // risposta che non arriva mai.
    client.close();
    clientAttivo = null;
    // Solo adesso la casella e' davvero libera per il giro successivo.
    inCorso = false;
  }

  return ultimoEsito;
}

export const statoCasella = () => ({ ...ultimoEsito, attivo: Boolean(timer) });

// ---- La casella si svuota da sola -----------------------------------------

/**
 * Manda nel cestino di Gmail le email di cui non c'e' piu' niente da fare.
 *
 * Prima la posta in arrivo la sgombrava una persona, messaggio per messaggio,
 * dalla scheda "Email ricevute". Quella scheda non c'e' piu': un'email che il
 * programma ha gia' trasformato in una richiesta non ha bisogno di essere letta
 * due volte, e tenerla li' voleva dire solo dare a qualcuno il compito di
 * cancellarla.
 *
 * La scadenza e' la stessa con cui la pratica sparisce dalle schermate di
 * lavoro, e non e' un caso: sono la stessa cosa vista da due parti.
 *
 *   prenotazione   il giorno dopo la visita (o dopo l'annullamento)
 *   medicinali     ventiquattro ore dopo che e' stata evasa
 *   specialistiche
 *   esami
 *
 * Cestino, non cancellazione: Gmail lo svuota dopo trenta giorni, e nel
 * frattempo un messaggio spostato per errore si riprende. Il testo dell'email
 * resta comunque salvato qui nell'archivio, che e' l'unica copia che non scade.
 */
export function pulisciEmailVecchie() {
  // Solo quelle ancora in casella e ancora "da leggere": una gia' gestita ha
  // gia' avuto il suo ordine di cestinamento quando e' stata segnata.
  const candidate = db.prepare(`
    SELECT codice, tipo, collegata_a
      FROM richieste_email
     WHERE stato = 'nuova' AND message_id IS NOT NULL AND cestinata_il IS NULL
  `).all();

  let cestinate = 0;

  for (const e of candidate) {
    if (!scaduta(e)) continue;
    try {
      // segnaEmail fa gia' tutto: segna gestita, scrive la data e mette in coda
      // lo spostamento nel cestino, una volta sola anche se questo giro
      // ripassasse due volte sullo stesso messaggio.
      segnaEmail(e.codice, 'gestita');
      cestinate++;
    } catch (err) {
      console.error('[inbox] pulizia fallita:', err.message);
    }
  }

  if (cestinate) console.log(`[inbox] ${cestinate} email non piu' utili spostate nel cestino`);
  return cestinate;
}

/** Di questa email c'e' ancora qualcosa da fare, o e' storia? */
function scaduta(email) {
  const codice = email.collegata_a;

  // Nessuna richiesta collegata: e' un'email di prenotazione che aspetta una
  // persona. Sta in "Da confermare" e finche' e' li' non si tocca — cestinarla
  // vorrebbe dire buttare via l'unica cosa da cui si capisce cosa voleva.
  if (!codice) {
    const parcheggiata = db.prepare(
      "SELECT stato, gestita_il FROM richieste_modulo WHERE chiave = ?").get(`email:${email.codice}`);
    if (!parcheggiata || parcheggiata.stato === 'nuova') return false;
    return oltreUnGiorno(parcheggiata.gestita_il);
  }

  if (codice.startsWith('PRE')) {
    const p = db.prepare('SELECT data, stato, annullata_il FROM prenotazioni WHERE codice = ?')
      .get(codice);
    if (!p) return false;
    if (p.stato === 'annullata') return oltreUnGiorno(p.annullata_il);
    // Il giorno della visita si resta: si sgombera dal giorno dopo.
    return db.prepare("SELECT date(?) < date('now', '-1 day') AS si").get(p.data).si === 1;
  }

  const r = db.prepare(
    'SELECT stato, gestita_il, aggiornata_il FROM richieste_medicine WHERE codice = ?').get(codice);
  if (!r || r.stato === 'nuova') return false;
  return oltreUnGiorno(r.gestita_il || r.aggiornata_il);
}

const oltreUnGiorno = (quando) => Boolean(quando)
  && db.prepare("SELECT datetime(?) < datetime('now', '-1 day') AS si").get(quando).si === 1;

export function avviaPolling() {
  if (timer || !config.inbox.enabled) return;

  // La pulizia viaggia insieme alla lettura invece di avere un suo orologio:
  // sono due facce dello stesso giro, e un timer in meno e' un timer in meno da
  // ricordarsi di fermare quando il server si chiude.
  const tick = () => controllaCasella()
    .then(() => { try { pulisciEmailVecchie(); } catch (e) { console.error('[inbox]', e); } })
    .catch((e) => console.error('[inbox]', e));
  timer = setInterval(tick, config.inbox.intervalSeconds * 1000);
  timer.unref?.();
  tick();
  console.log(`[inbox] lettura casella attiva ogni ${config.inbox.intervalSeconds}s`);
}

export function fermaPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}
