import express from 'express';
import { db } from './db.js';
import { config } from './config.js';
import {
  autenticazioneOpzionale, richiedeStaff, richiedeAdmin, verificaPassword,
  creaSessione, eliminaSessione
} from './auth.js';
import {
  listaAmbulatori, orariAmbulatorio, slotDisponibili, giorniConDisponibilita,
  oggiISO, aggiungiGiorni, dataValida, GIORNI_PRENOTABILI, DURATA_SLOT_MINUTI
} from './orari.js';
import * as prenotazioni from './prenotazioni.js';
import { ErroreDominio } from './prenotazioni.js';
import * as medicine from './medicine.js';
import * as chatbot from './chatbot.js';
import * as inbox from './inbox.js';
import * as moduli from './moduli.js';
import * as attesa from './attesa.js';
import * as chiusure from './chiusure.js';
import * as statistiche from './statistiche.js';
import * as utenti from './utenti.js';
import { eseguiBackup, statoBackup } from './backup.js';
import { statoCoda, riprovaTutto } from './outbox.js';
import { verificaConnessioneEmail } from './mailer.js';
import { verificaFoglio } from './sheets.js';
import { linkGoogleCalendar } from './evento.js';

/** Cattura anche gli errori asincroni: senza questo un await fallito sfugge a Express. */
const via = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const ok = (res, dati) => res.json({ success: true, ...dati });

/**
 * Freno anti-abuso in memoria: finestra scorrevole per IP.
 * Serve a impedire che un singolo client saturi il server, non a bloccare
 * il traffico normale — le soglie sono larghe rispetto all'uso reale.
 */
function limite({ max, secondi }) {
  const visite = new Map();
  setInterval(() => {
    const taglio = Date.now() - secondi * 1000;
    for (const [k, v] of visite) if (v.at(-1) < taglio) visite.delete(k);
  }, 60000).unref?.();

  return (req, res, next) => {
    const ora = Date.now();
    const taglio = ora - secondi * 1000;
    const chiave = req.ip || 'ignoto';
    const recenti = (visite.get(chiave) || []).filter((t) => t > taglio);

    if (recenti.length >= max) {
      return res.status(429).json({
        success: false,
        message: 'Troppe richieste ravvicinate. Attendi qualche istante e riprova.'
      });
    }
    recenti.push(ora);
    visite.set(chiave, recenti);
    next();
  };
}

const limiteScrittura = limite({ max: 30, secondi: 60 });
const limiteLogin = limite({ max: 10, secondi: 300 });
const limiteChat = limite({ max: 60, secondi: 60 });

/**
 * Secondo freno sul login, contato per account invece che per indirizzo.
 *
 * Quello per indirizzo ferma una macchina sola che prova mille password. Non
 * ferma pero' mille macchine che ne provano una a testa sullo stesso account:
 * ognuna resta larghissimamente sotto la soglia, e l'indirizzo del medico e'
 * noto perche' e' scritto sul sito. Questo freno guarda l'account, quindi vede
 * l'attacco anche quando arriva sparpagliato.
 *
 * Si contano solo i fallimenti, e un accesso riuscito azzera tutto: chi sa la
 * password non se ne accorge mai, nemmeno dopo qualche errore di battitura.
 *
 * Il prezzo da pagare e' che qualcuno puo' sbagliare apposta trenta volte per
 * tenere fuori il medico per un quarto d'ora. E' un fastidio recuperabile,
 * mentre lasciare indovinare la password senza limite non lo e'. Con Cloudflare
 * Access davanti al pannello il problema non si pone: chi non e' in elenco non
 * arriva nemmeno a questa riga.
 */
const MAX_FALLITI = 30;
const FINESTRA_FALLITI_MS = 15 * 60 * 1000;

// Nessun ritardo sui primi errori, che sono quelli veri delle persone.
// Poi la pausa raddoppia: rende l'attacco lento senza bloccare nessuno.
const RITARDI_MS = [0, 0, 0, 500, 1000, 2000, 4000, 8000];

const falliti = new Map();

setInterval(() => {
  const taglio = Date.now() - FINESTRA_FALLITI_MS;
  for (const [k, v] of falliti) if (v.ultimo < taglio) falliti.delete(k);
}, 60000).unref?.();

const pausa = (ms) => (ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

function fallimentiRecenti(email) {
  const v = falliti.get(email);
  if (!v) return 0;
  if (Date.now() - v.ultimo > FINESTRA_FALLITI_MS) {
    falliti.delete(email);
    return 0;
  }
  return v.n;
}

export const router = express.Router();
router.use(autenticazioneOpzionale);

// ---- Dati pubblici --------------------------------------------------------

router.get('/ambulatori', (_req, res) => {
  const ambulatori = listaAmbulatori().map((a) => ({ ...a, orari: orariAmbulatorio(a.id) }));
  ok(res, { ambulatori, durata_slot: DURATA_SLOT_MINUTI, giorni_prenotabili: GIORNI_PRENOTABILI });
});

router.get('/disponibilita', (req, res) => {
  const data = String(req.query.data || '');
  if (!dataValida(data)) throw new ErroreDominio('Data non valida.');
  const ambulatorioId = req.query.ambulatorio_id ? Number(req.query.ambulatorio_id) : null;
  ok(res, { data, slot: slotDisponibili(data, ambulatorioId) });
});

router.get('/calendario', (req, res) => {
  const oggi = oggiISO();
  const dal = dataValida(req.query.dal) && req.query.dal >= oggi ? req.query.dal : oggi;
  const massimo = aggiungiGiorni(oggi, GIORNI_PRENOTABILI);
  let al = dataValida(req.query.al) ? req.query.al : aggiungiGiorni(dal, 30);
  if (al > massimo) al = massimo;
  if (al < dal) al = dal;
  const ambulatorioId = req.query.ambulatorio_id ? Number(req.query.ambulatorio_id) : null;
  ok(res, { giorni: giorniConDisponibilita(dal, al, ambulatorioId) });
});

// ---- Prenotazioni ---------------------------------------------------------

router.post('/prenotazioni', limiteScrittura, (req, res) => {
  const p = prenotazioni.creaPrenotazione({ ...req.body, origine: 'sito' });
  res.status(201).json({ success: true, prenotazione: pubblica(p) });
});

router.get('/prenotazioni/:codice', (req, res) => {
  const p = prenotazioni.perCodice(req.params.codice);
  if (!p) throw new ErroreDominio('Prenotazione non trovata. Controlla il codice.', 404);
  ok(res, {
    prenotazione: pubblica(p),
    annullabile: p.stato === 'confermata'
      && prenotazioni.minutiAllAppuntamento(p) >= config.cancellazioneMinutiMinimi
  });
});

router.post('/prenotazioni/:codice/annulla', limiteScrittura, (req, res) => {
  const p = prenotazioni.annullaPrenotazione(req.params.codice, { da: 'paziente' });
  attesa.avvisaPerPostoLibero(p);
  ok(res, { prenotazione: pubblica(p) });
});

// ---- Lista d'attesa -------------------------------------------------------

router.post('/attesa', limiteScrittura, (req, res) => {
  const v = attesa.iscrivi(req.body || {});
  res.status(201).json({ success: true, attesa: { codice: v.codice, data: v.data } });
});

/** Nasconde i campi interni: al pubblico non servono gli id di database. */
function pubblica(p) {
  return {
    codice: p.codice,
    data: p.data,
    ora_inizio: p.ora_inizio,
    ora_fine: p.ora_fine,
    stato: p.stato,
    problema: p.problema,
    ambulatorio: {
      nome: p.ambulatorio_nome,
      indirizzo: p.ambulatorio_indirizzo,
      telefono: p.ambulatorio_telefono
    },
    paziente: {
      nome: p.paziente_nome,
      cognome: p.paziente_cognome,
      telefono: p.paziente_telefono,
      email: p.paziente_email
    },
    // Solo per le visite ancora valide: proporre di salvare in calendario
    // un appuntamento annullato confonderebbe e basta.
    calendario: p.stato === 'confermata' ? linkGoogleCalendar(p) : null
  };
}

// ---- Richieste medicinali -------------------------------------------------

router.post('/medicine', limiteScrittura, (req, res) => {
  const r = medicine.creaRichiesta({ ...req.body, origine: 'sito' });
  res.status(201).json({
    success: true,
    richiesta: { codice: r.codice, stato: r.stato, farmaci: r.farmaci, creata_il: r.creata_il }
  });
});

router.get('/medicine/:codice', (req, res) => {
  const r = medicine.perCodice(req.params.codice);
  if (!r) throw new ErroreDominio('Richiesta non trovata. Controlla il codice.', 404);
  ok(res, {
    richiesta: {
      codice: r.codice, stato: r.stato, etichetta: medicine.ETICHETTE_STATO[r.stato],
      farmaci: r.farmaci, creata_il: r.creata_il, aggiornata_il: r.aggiornata_il
    }
  });
});

// ---- Chatbot --------------------------------------------------------------

router.get('/chat', limiteChat, (req, res) => {
  ok(res, chatbot.benvenuto(String(req.query.sessione || '')));
});

router.post('/chat', limiteChat, (req, res) => {
  const { sessione, testo, etichetta } = req.body || {};
  ok(res, chatbot.messaggio(String(sessione || ''), testo, String(etichetta || '')));
});

// ---- Autenticazione -------------------------------------------------------

router.post('/auth/login', limiteLogin, via(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const da = req.ip || 'ignoto';
  const prima = fallimentiRecenti(email);

  if (prima >= MAX_FALLITI) {
    console.error(`[login] account in pausa dopo ${prima} fallimenti: ${email} — ultimo da ${da}`);
    throw new ErroreDominio(
      'Troppi tentativi falliti su questo account. Riprova fra un quarto d\'ora.', 429
    );
  }

  const utente = db.prepare('SELECT * FROM utenti WHERE email = ?').get(email);

  if (!utente || !verificaPassword(String(req.body?.password || ''), utente.password_hash)) {
    const n = prima + 1;
    falliti.set(email, { n, ultimo: Date.now() });

    // Finisce in logs/errori.log: e' l'unica traccia di un attacco in corso.
    // Si scrive l'indirizzo tentato, mai la password provata.
    console.error(`[login] tentativo fallito n.${n} su ${email || '(email vuota)'} da ${da}`);

    await pausa(RITARDI_MS[Math.min(n, RITARDI_MS.length - 1)]);

    // Messaggio unico: non riveliamo se l'indirizzo esiste.
    throw new ErroreDominio('Email o password non corretti.', 401);
  }

  // Account sospeso: la password puo' anche essere giusta, ma non si entra.
  if (utente.attivo === 0) {
    throw new ErroreDominio('Questo accesso e\' stato sospeso. Rivolgiti al medico.', 403);
  }

  // Chi sa la password riparte pulito: gli errori di battitura non si sommano
  // fino a chiudergli la porta il giorno dopo.
  falliti.delete(email);

  utenti.segnaAccesso(utente.id);
  const { token, scadenza } = creaSessione(utente.id);
  ok(res, {
    token,
    scadenza,
    utente: {
      email: utente.email,
      ruolo: utente.ruolo,
      nome: utente.nome || '',
      // Con la password provvisoria si entra, ma il pannello resta chiuso
      // finche' non se ne sceglie una personale.
      deve_cambiare_password: Boolean(utente.cambio_password)
    }
  });
}));

/** Cambio della propria password: lo fa l'interessato, serve quella attuale. */
router.post('/auth/password', limiteLogin, (req, res) => {
  if (!req.utente) throw new ErroreDominio('Sessione scaduta.', 401);
  ok(res, utenti.cambiaPasswordProprio(req.utente.id, req.body?.attuale, req.body?.nuova));
});

router.post('/auth/logout', (req, res) => {
  const header = req.get('authorization') || '';
  if (header.startsWith('Bearer ')) eliminaSessione(header.slice(7).trim());
  ok(res, {});
});

router.get('/auth/me', (req, res) => {
  if (!req.utente) return res.status(401).json({ success: false, message: 'Sessione scaduta.' });
  ok(res, { utente: req.utente });
});

// ---- Area amministratore --------------------------------------------------

const admin = express.Router();
admin.use(richiedeStaff);
router.use('/admin', admin);

/**
 * Il motivo della visita e' un dato clinico: la segreteria vede l'agenda per
 * far funzionare lo studio, ma non deve leggere perche' il paziente viene.
 */
const soloMedico = (req) => req.utente?.ruolo === 'admin';

const MOTIVO_NASCOSTO = '— riservato al medico —';

function filtraClinico(req, righe) {
  if (soloMedico(req)) return righe;
  return righe.map((r) => ('problema' in r ? { ...r, problema: MOTIVO_NASCOSTO } : r));
}

admin.get('/riepilogo', (_req, res) => {
  const oggi = oggiISO();
  const conta = (sql, ...par) => db.prepare(sql).get(...par).n;

  ok(res, {
    riepilogo: {
      prenotazioni_oggi: conta(
        `SELECT COUNT(*) n FROM prenotazioni WHERE data = ? AND stato = 'confermata'`, oggi),
      prenotazioni_future: conta(
        `SELECT COUNT(*) n FROM prenotazioni WHERE data > ? AND stato = 'confermata'`, oggi),
      medicine_da_evadere: conta(
        `SELECT COUNT(*) n FROM richieste_medicine WHERE stato = 'nuova'`),
      email_da_leggere: conta(`SELECT COUNT(*) n FROM richieste_email WHERE stato = 'nuova'`),
      moduli_da_confermare: moduli.daConfermare(),
      pazienti: conta('SELECT COUNT(*) n FROM pazienti'),
      consegne_in_attesa: statoCoda().in_attesa
    },
    agenda_oggi: filtraClinico(_req, db.prepare(`
      SELECT p.codice, p.ora_inizio, p.ora_fine, p.problema, p.stato,
             a.nome AS ambulatorio_nome, pa.nome, pa.cognome, pa.telefono
        FROM prenotazioni p
        JOIN ambulatori a ON a.id = p.ambulatorio_id
        JOIN pazienti pa ON pa.id = p.paziente_id
       WHERE p.data = ? AND p.stato = 'confermata'
       ORDER BY p.ora_inizio
    `).all(oggi))
  });
});

admin.get('/prenotazioni', (req, res) => {
  const esito = prenotazioni.elencoAdmin(req.query);
  ok(res, { ...esito, prenotazioni: filtraClinico(req, esito.prenotazioni) });
});

admin.post('/prenotazioni/:codice/annulla', (req, res) => {
  const p = prenotazioni.annullaPrenotazione(req.params.codice, { da: 'admin' });
  ok(res, { prenotazione: p, avvisati: attesa.avvisaPerPostoLibero(p) });
});

/**
 * Prenotazione scritta a mano dallo studio: la telefonata, il paziente allo
 * sportello, la visita da recuperare.
 *
 * `forza` salta i limiti pensati per chi prenota da solo — orari di apertura,
 * giorni di anticipo, il passato. Non salta il divieto di mettere due pazienti
 * nello stesso posto: quello lo tiene il database.
 */
admin.post('/prenotazioni', (req, res) => {
  const p = prenotazioni.creaPrenotazione(
    { ...req.body, origine: 'studio' },
    { forza: Boolean(req.body?.forza) }
  );
  res.status(201).json({ success: true, prenotazione: p });
});

/** Prima di forzare: che cosa si sta scavalcando. Non blocca, informa. */
admin.get('/prenotazioni/avvertimenti', (req, res) => {
  ok(res, { avvertimenti: prenotazioni.avvertimenti(req.query) });
});

admin.post('/prenotazioni/:codice/riprogramma', (req, res) => {
  ok(res, {
    prenotazione: prenotazioni.riprogramma(
      req.params.codice, req.body || {}, req.utente.email,
      { forza: Boolean(req.body?.forza) }
    )
  });
});

/** Richiesta di medicinali presa al telefono e scritta dallo studio. */
admin.post('/medicine', (req, res) => {
  const r = medicine.creaRichiesta({ ...req.body, origine: 'studio' });
  res.status(201).json({ success: true, richiesta: r });
});

admin.get('/medicine', (req, res) => ok(res, medicine.elencoAdmin(req.query)));

/**
 * Una rotta per ogni risposta possibile, invece di un solo PATCH con lo stato
 * dentro. Cosi' il pannello non puo' inventarsi passaggi che non esistono, e
 * ogni azione porta con se' quello che le serve: il motivo per il rifiuto, i
 * farmaci corretti per la modifica.
 */
admin.post('/medicine/:codice/conferma', (req, res) => {
  ok(res, { richiesta: medicine.conferma(req.params.codice, req.utente.email) });
});

admin.post('/medicine/:codice/rifiuta', (req, res) => {
  ok(res, { richiesta: medicine.rifiuta(req.params.codice, req.body?.motivo, req.utente.email) });
});

admin.post('/medicine/:codice/modifica', (req, res) => {
  ok(res, { richiesta: medicine.modifica(req.params.codice, req.body || {}, req.utente.email) });
});

admin.post('/medicine/:codice/consegnata', (req, res) => {
  ok(res, { richiesta: medicine.segnaConsegnata(req.params.codice, req.utente.email) });
});

admin.get('/email', (req, res) => ok(res, inbox.elencoEmail(req.query)));

admin.patch('/email/:codice', (req, res) => {
  ok(res, { email: inbox.segnaEmail(req.params.codice, req.body?.stato) });
});

admin.post('/email/controlla', via(async (_req, res) => {
  ok(res, { esito: await inbox.controllaCasella() });
}));

admin.get('/pazienti', (req, res) => {
  const cerca = String(req.query.cerca || '').trim();
  const dove = cerca ? 'WHERE nome LIKE ? OR cognome LIKE ? OR telefono LIKE ? OR email LIKE ?' : '';
  const par = cerca ? Array(4).fill(`%${cerca}%`) : [];

  ok(res, {
    pazienti: db.prepare(`
      SELECT p.*, (SELECT COUNT(*) FROM prenotazioni WHERE paziente_id = p.id) AS visite
        FROM pazienti p ${dove} ORDER BY p.cognome, p.nome LIMIT 200
    `).all(...par)
  });
});

/** Tutto quello che sappiamo di un paziente, in una schermata sola. */
admin.get('/pazienti/:id', richiedeAdmin, (req, res) => {
  const paziente = db.prepare('SELECT * FROM pazienti WHERE id = ?').get(Number(req.params.id));
  if (!paziente) throw new ErroreDominio('Paziente non trovato.', 404);

  ok(res, {
    paziente,
    prenotazioni: prenotazioni.perPaziente(paziente.id),
    medicine: db.prepare(`
      SELECT codice, farmaci, note, stato, creata_il FROM richieste_medicine
       WHERE paziente_id = ? OR (lower(email) = lower(?) AND ? <> '')
       ORDER BY creata_il DESC
    `).all(paziente.id, paziente.email || '', paziente.email || '')
  });
});

// ---- Chiusure e ferie -----------------------------------------------------

admin.get('/chiusure', (_req, res) => ok(res, { chiusure: chiusure.elenco() }));

admin.post('/chiusure', (req, res) => {
  res.status(201).json({ success: true, ...chiusure.aggiungi(req.body || {}) });
});

admin.delete('/chiusure/:id', (req, res) => ok(res, chiusure.rimuovi(req.params.id)));

// ---- Lista d'attesa -------------------------------------------------------

admin.get('/attesa', (req, res) => ok(res, attesa.elencoAdmin(req.query)));

admin.post('/attesa/:codice/chiudi', (req, res) => ok(res, attesa.chiudi(req.params.codice)));

// ---- Statistiche ed esportazione ------------------------------------------

admin.get('/statistiche', richiedeAdmin, (req, res) =>
  ok(res, { statistiche: statistiche.riepilogo(req.query) }));

admin.get('/esporta/:cosa', richiedeAdmin, (req, res) => {
  const { cosa } = req.params;
  if (cosa !== 'prenotazioni' && cosa !== 'medicine') {
    throw new ErroreDominio('Esportazione non disponibile.', 404);
  }
  const csv = cosa === 'prenotazioni'
    ? statistiche.esportaPrenotazioni(req.query)
    : statistiche.esportaMedicine(req.query);

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${cosa}-${oggiISO()}.csv"`);
  res.send(csv);
});

admin.post('/sistema/backup', richiedeAdmin, via(async (_req, res) => {
  const r = await eseguiBackup();
  ok(res, { backup: { byte: r.byte, stato: statoBackup() } });
}));

admin.get('/sistema', via(async (_req, res) => {
  ok(res, {
    coda: statoCoda(),
    email: await verificaConnessioneEmail(),
    foglio: await verificaFoglio(),
    casella: inbox.statoCasella(),
    moduli: moduli.statoModuli(),
    backup: statoBackup()
  });
}));

admin.post('/sistema/riprova-consegne', (_req, res) => ok(res, { rimesse_in_coda: riprovaTutto() }));

// ---- Richieste arrivate dai Moduli Google ---------------------------------
// Sono arrivate a sito spento e aspettano che una persona le confermi.

admin.get('/moduli', (req, res) => ok(res, moduli.elenco(req.query)));

admin.post('/moduli/controlla', via(async (_req, res) => {
  ok(res, { esito: await moduli.controllaModuli() });
}));

admin.post('/moduli/:codice/conferma', (req, res) => {
  const esito = moduli.conferma(req.params.codice, req.body || {}, req.utente.email);
  ok(res, { richiesta: esito.richiesta, generata: { codice: esito.generata.codice } });
});

admin.post('/moduli/:codice/rifiuta', (req, res) =>
  ok(res, { richiesta: moduli.rifiuta(req.params.codice, req.body?.motivo, req.utente.email) }));

// ---- Collaboratori --------------------------------------------------------
// Chi entra nello studio e chi non entra piu' lo decide solo il medico.

admin.get('/utenti', richiedeAdmin, (_req, res) => ok(res, utenti.elenco()));

admin.post('/utenti', richiedeAdmin, (req, res) =>
  res.status(201).json({ success: true, ...utenti.crea(req.body || {}, req.utente.id) }));

admin.patch('/utenti/:id', richiedeAdmin, (req, res) => {
  const { ruolo, attivo } = req.body || {};
  if (ruolo !== undefined) return ok(res, utenti.cambiaRuolo(req.params.id, ruolo, req.utente.id));
  if (attivo !== undefined) return ok(res, utenti.cambiaAttivazione(req.params.id, attivo, req.utente.id));
  throw new ErroreDominio('Niente da modificare.', 400);
});

admin.post('/utenti/:id/password', richiedeAdmin, (req, res) =>
  ok(res, utenti.rinnovaPassword(req.params.id)));

admin.delete('/utenti/:id', richiedeAdmin, (req, res) =>
  ok(res, utenti.rimuovi(req.params.id, req.utente.id)));

// ---- Gestione errori ------------------------------------------------------

router.use((_req, res) => {
  res.status(404).json({ success: false, message: 'Risorsa non trovata.' });
});

router.use((err, _req, res, _next) => {
  if (err instanceof ErroreDominio) {
    return res.status(err.codiceHttp || 400).json({ success: false, message: err.message });
  }
  console.error('[api] errore non previsto:', err);
  res.status(500).json({
    success: false,
    message: 'Si è verificato un problema tecnico. La tua richiesta non è stata registrata: riprova.'
  });
});
