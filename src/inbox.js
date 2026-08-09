import { db } from './db.js';
import { config } from './config.js';
import { accoda, registraGestore } from './outbox.js';
import { generaCodice, ErroreDominio } from './prenotazioni.js';
import { creaRichiesta } from './medicine.js';

/**
 * Rete di sicurezza sulla casella in arrivo.
 *
 * Le richieste fatte dal sito finiscono gia' su database e Foglio Google senza
 * passare dall'email. Questo modulo serve solo a intercettare chi scrive a mano
 * allo studio: ogni messaggio viene salvato integralmente, anche se non se ne
 * capisce il contenuto, cosi' nulla puo' sfuggire.
 */

const PAROLE_MEDICINE = ['medicin', 'farmac', 'ricett', 'prescriz', 'pastigl', 'compress',
  'sciroppo', 'pillol', 'terapia', 'piano terapeutico', 'impegnativ'];
const PAROLE_PRENOTAZIONE = ['prenot', 'appuntament', 'visita', 'controllo', 'disponibil', 'fissare'];

function classifica(oggetto, corpo) {
  const t = `${oggetto || ''} ${corpo || ''}`.toLowerCase();
  const med = PAROLE_MEDICINE.filter((p) => t.includes(p)).length;
  const pre = PAROLE_PRENOTAZIONE.filter((p) => t.includes(p)).length;
  if (med === 0 && pre === 0) return 'altro';
  return med >= pre ? 'medicina' : 'prenotazione';
}

/** Riconosce le notifiche generate dal sistema stesso, per non rimbalzarle. */
function eNostraNotifica(mittente, oggetto) {
  const propria = mittente?.toLowerCase() === config.email.user.toLowerCase();
  const soggetti = ['nuova prenotazione', 'annullamento', 'richiesta medicinali',
    'prenotazione confermata', 'prenotazione annullata', 'ricetta pronta',
    'promemoria', 'richiesta ricevuta'];
  return propria && soggetti.some((s) => (oggetto || '').toLowerCase().includes(s));
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

const estraiTelefono = (testo) => {
  const m = String(testo).match(/(?:\+39\s?)?\b3\d{2}[\s.\-]?\d{3}[\s.\-]?\d{3,4}\b/);
  return m ? m[0].replace(/[\s.\-]/g, '') : null;
};

const stmtGiaVista = db.prepare('SELECT 1 FROM email_processate WHERE message_id = ?');

/** Salva l'email e, se e' una richiesta di medicinali, la converte subito. */
export function registraEmail({ messageId, mittente, mittenteNome, oggetto, corpo, ricevutaIl }) {
  if (messageId && stmtGiaVista.get(messageId)) return { saltata: true };

  const tipo = classifica(oggetto, corpo);
  const codice = generaCodice('EML');
  const adesso = new Date().toISOString();

  const transazione = db.transaction(() => {
    let collegata = null;

    if (tipo === 'medicina') {
      const { nome, cognome } = estraiNome(mittenteNome, mittente);
      try {
        const richiesta = creaRichiesta({
          nome, cognome, email: mittente,
          telefono: estraiTelefono(corpo) || '',
          farmaci: (oggetto ? `${oggetto}\n\n` : '') + corpo.slice(0, 1200),
          note: 'Richiesta ricevuta via email, da verificare.',
          origine: 'email'
        });
        collegata = richiesta.codice;
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

    if (messageId) {
      db.prepare('INSERT INTO email_processate (message_id, ricevuta_il, esito, riferimento) VALUES (?, ?, ?, ?)')
        .run(messageId, adesso, collegata ? 'convertita' : 'archiviata', collegata || codice);
    }

    // Anche le email non classificate finiscono nel foglio, come traccia.
    if (!collegata) {
      accoda('sheet_medicina', {
        codice, stato: 'nuova',
        nome: mittenteNome || mittente, cognome: '',
        telefono: estraiTelefono(corpo) || '', email: mittente,
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

export function segnaEmail(codice, stato) {
  if (!['nuova', 'gestita', 'archiviata'].includes(stato)) throw new ErroreDominio('Stato non valido.');
  const r = db.prepare('UPDATE richieste_email SET stato = ?, gestita_il = ? WHERE codice = ?')
    .run(stato, new Date().toISOString(), String(codice).toUpperCase());
  if (!r.changes) throw new ErroreDominio('Email non trovata.', 404);
  return db.prepare('SELECT * FROM richieste_email WHERE codice = ?').get(String(codice).toUpperCase());
}

// ---- Polling IMAP ---------------------------------------------------------

let inCorso = false;
let timer = null;
let ultimoEsito = { mai_eseguito: true };

// Limite invalicabile per un giro di lettura. I timeout di ImapFlow coprono la
// connessione, non l'intera sessione: se il server accetta e poi tace, senza
// questo il controllo resterebbe appeso e la lettura si fermerebbe per sempre.
const TEMPO_MASSIMO_MS = 90_000;

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

export async function controllaCasella() {
  if (inCorso) return { saltato: true };

  let scadenza;
  const limite = new Promise((_, rifiuta) => {
    scadenza = setTimeout(() => rifiuta(new Error('la casella non ha risposto entro 90 secondi')),
      TEMPO_MASSIMO_MS);
  });

  try {
    return await Promise.race([leggiCasella(), limite]);
  } catch (err) {
    ultimoEsito = { ok: false, motivo: err.message, quando: new Date().toISOString() };
    return ultimoEsito;
  } finally {
    clearTimeout(scadenza);
    inCorso = false;
  }
}

async function leggiCasella() {
  if (!config.email.enabled) {
    ultimoEsito = { ok: false, motivo: 'credenziali email non configurate' };
    return ultimoEsito;
  }

  inCorso = true;
  const { ImapFlow, simpleParser } = await caricaLibreriePosta();
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: config.email.user, pass: config.email.pass },
    logger: false,
    // Senza questi limiti una connessione che non risponde resta appesa per
    // sempre: inCorso non tornerebbe mai false e la lettura si fermerebbe in
    // silenzio, proprio la cosa che questa rete di sicurezza deve evitare.
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 60000
  });

  let nuove = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Solo i messaggi non letti: quelli gia' visti sono stati elaborati.
      const uid = await client.search({ seen: false }, { uid: true });

      for (const id of (uid || []).slice(0, 50)) {
        const msg = await client.fetchOne(String(id), { source: true }, { uid: true });
        if (!msg?.source) continue;

        const mail = await simpleParser(msg.source);
        const mittente = mail.from?.value?.[0]?.address || '';
        const oggetto = mail.subject || '';

        if (!mittente || eNostraNotifica(mittente, oggetto)) {
          await client.messageFlagsAdd(String(id), ['\\Seen'], { uid: true });
          continue;
        }

        const esito = registraEmail({
          messageId: mail.messageId || `uid-${id}`,
          mittente,
          mittenteNome: mail.from?.value?.[0]?.name || '',
          oggetto,
          corpo: (mail.text || mail.html?.replace(/<[^>]+>/g, ' ') || '').trim(),
          ricevutaIl: (mail.date || new Date()).toISOString()
        });

        if (!esito.saltata) nuove++;
        await client.messageFlagsAdd(String(id), ['\\Seen'], { uid: true });
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
  }

  return ultimoEsito;
}

export const statoCasella = () => ({ ...ultimoEsito, attivo: Boolean(timer) });

export function avviaPolling() {
  if (timer || !config.inbox.enabled) return;
  const tick = () => controllaCasella().catch((e) => console.error('[inbox]', e));
  timer = setInterval(tick, config.inbox.intervalSeconds * 1000);
  timer.unref?.();
  tick();
  console.log(`[inbox] lettura casella attiva ogni ${config.inbox.intervalSeconds}s`);
}

export function fermaPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}
