import express from 'express';
import { db } from './db.js';
import { config } from './config.js';
import {
  autenticazioneOpzionale, richiedeStaff, richiedeAdmin, verificaPassword,
  richiedePaziente, RUOLI_STAFF, creaSessione, eliminaSessione
} from './auth.js';
import {
  listaAmbulatori, orariAmbulatorio, slotDisponibili, giorniConDisponibilita,
  oggiISO, aggiungiGiorni, dataValida, GIORNI_PRENOTABILI, DURATA_SLOT_MINUTI
} from './orari.js';
import * as prenotazioni from './prenotazioni.js';
import { ErroreDominio } from './prenotazioni.js';
import * as medicine from './medicine.js';
import * as chatbot from './chatbot.js';
import * as assistente from './assistente.js';
import * as pazienti from './pazienti.js';
import * as inbox from './inbox.js';
import * as moduli from './moduli.js';
import * as attesa from './attesa.js';
import * as chiusure from './chiusure.js';
import * as statistiche from './statistiche.js';
import * as utenti from './utenti.js';
import { eseguiBackup, statoBackup } from './backup.js';
import { statoCoda, riprovaTutto, accoda } from './outbox.js';
import {
  verificaConnessioneEmail, emailVerificaPaziente, emailIndirizzoCambiato,
  emailRegistrazioneEsistente
} from './mailer.js';
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
const limiteLogin = limite({ max: 20, secondi: 300 });
const limiteChat = limite({ max: 60, secondi: 60 });

// La registrazione e' un gesto unico per persona, ma tante persone possono
// condividere un indirizzo: la rete di casa di una famiglia, il wifi di uno
// studio, e soprattutto le uscite NAT degli operatori mobili, dietro cui
// stanno migliaia di clienti. Cinque all'ora chiudevano fuori il lancio, in
// cui centinaia di pazienti si iscrivono nello stesso giorno. Sessanta all'ora
// per indirizzo lasciano passare quei gruppi e fermano comunque uno script che
// martella da una sorgente sola; il freno vero contro gli account falsi e' la
// verifica dell'email, non questo conteggio.
const limiteRegistrazione = limite({ max: 60, secondi: 3600 });

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

const eStaff = (req) => RUOLI_STAFF.includes(req.utente?.ruolo);

function richiedeAccount(req, res, next) {
  if (!req.utente) return res.status(401).json({ success: false, message: 'Accedi per continuare.' });
  if (eStaff(req) && req.utente.deve_cambiare_password) {
    return res.status(403).json({ success: false, message: 'Devi prima cambiare la password provvisoria.' });
  }
  if (!eStaff(req) && (req.utente.ruolo !== 'paziente' || !req.utente.paziente_id)) {
    return res.status(403).json({ success: false, message: 'Account non collegato a un paziente.' });
  }
  next();
}

function schedaPaziente(req) {
  const p = db.prepare('SELECT * FROM pazienti WHERE id = ?').get(Number(req.utente.paziente_id));
  if (!p) throw new ErroreDominio('Il tuo account non è collegato a una scheda valida.', 403);
  return p;
}

function praticaVisibile(req, completa, delPaziente) {
  return eStaff(req) ? completa() : delPaziente(req.utente.paziente_id);
}

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

router.post('/prenotazioni', limiteScrittura, richiedePaziente, (req, res) => {
  const proprietario = schedaPaziente(req);
  const p = prenotazioni.creaPrenotazione({
    ambulatorio_id: req.body?.ambulatorio_id,
    data: req.body?.data,
    ora_inizio: req.body?.ora_inizio,
    problema: req.body?.problema,
    pazienteId: req.utente.paziente_id,
    nome: proprietario.nome, cognome: proprietario.cognome,
    email: proprietario.email, telefono: proprietario.telefono,
    origine: 'sito'
  });
  res.status(201).json({ success: true, prenotazione: pubblica(p) });
});

router.get('/prenotazioni/:codice', richiedeAccount, (req, res) => {
  const p = praticaVisibile(req,
    () => prenotazioni.perCodice(req.params.codice),
    (id) => prenotazioni.perCodiceDelPaziente(req.params.codice, id));
  if (!p) throw new ErroreDominio('Prenotazione non trovata. Controlla il codice.', 404);
  ok(res, {
    prenotazione: pubblica(p),
    annullabile: p.stato === 'confermata'
      && prenotazioni.minutiAllAppuntamento(p) >= config.cancellazioneMinutiMinimi
  });
});

router.post('/prenotazioni/:codice/annulla', limiteScrittura, richiedeAccount, (req, res) => {
  if (req.body?.conferma !== true) throw new ErroreDominio('Conferma esplicitamente l\'annullamento.', 400);
  const propria = praticaVisibile(req,
    () => prenotazioni.perCodice(req.params.codice),
    (id) => prenotazioni.perCodiceDelPaziente(req.params.codice, id));
  if (!propria) throw new ErroreDominio('Prenotazione non trovata.', 404);
  const p = prenotazioni.annullaPrenotazione(req.params.codice,
    { da: eStaff(req) ? req.utente.email : 'paziente' });
  attesa.avvisaPerPostoLibero(p);
  ok(res, { prenotazione: pubblica(p) });
});

// ---- Lista d'attesa -------------------------------------------------------

router.post('/attesa', limiteScrittura, richiedePaziente, (req, res) => {
  const proprietario = schedaPaziente(req);
  const v = attesa.iscrivi({
    ambulatorio_id: req.body?.ambulatorio_id, data: req.body?.data, problema: req.body?.problema,
    pazienteId: req.utente.paziente_id,
    nome: proprietario.nome, cognome: proprietario.cognome,
    email: proprietario.email, telefono: proprietario.telefono
  });
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

router.post('/medicine', limiteScrittura, richiedePaziente, (req, res) => {
  const proprietario = schedaPaziente(req);
  const r = medicine.creaRichiesta({
    tipo: req.body?.tipo, farmaci: req.body?.farmaci, note: req.body?.note,
    ambulatorio_id: req.body?.ambulatorio_id, conAllegato: req.body?.conAllegato,
    pazienteId: req.utente.paziente_id,
    nome: proprietario.nome, cognome: proprietario.cognome,
    email: proprietario.email, telefono: proprietario.telefono, origine: 'sito' });
  res.status(201).json({
    success: true,
    richiesta: {
      codice: r.codice, tipo: r.tipo, stato: r.stato, farmaci: r.farmaci, creata_il: r.creata_il
    }
  });
});

/**
 * Il file allegato a una richiesta, caricato dal paziente subito dopo averla
 * mandata.
 *
 * Arriva come corpo grezzo e non come modulo a piu' parti: leggere un multipart
 * vorrebbe dire aggiungere una libreria per fare una cosa che qui si fa con
 * quello che c'e' gia'. Il browser manda il file cosi' com'e', il nome viaggia
 * nell'indirizzo.
 *
 * Si accetta finche' la richiesta e' ancora da vedere: dopo che lo studio ha
 * risposto, un documento che compare senza che nessuno se ne accorga sarebbe
 * peggio che non riceverlo.
 */
router.post('/medicine/:codice/allegato', limiteScrittura, richiedeAccount,
  express.raw({ type: '*/*', limit: medicine.MASSIMO_BYTE_ALLEGATO }),
  (req, res) => {
    if (req.query.conferma !== 'si') throw new ErroreDominio('Conferma esplicitamente il caricamento.', 400);
    const r = praticaVisibile(req,
      () => medicine.perCodice(req.params.codice),
      (id) => medicine.perCodiceDelPaziente(req.params.codice, id));
    if (!r) throw new ErroreDominio('Richiesta non trovata. Controlla il codice.', 404);
    if (r.stato !== 'nuova') {
      throw new ErroreDominio('Questa richiesta è già stata gestita: per aggiungere un documento ci contatti.');
    }

    const esito = medicine.allegaFile(r.id, {
      nome: req.query.nome,
      contenuto: req.body
    });

    res.status(201).json({ success: true, allegato: esito });
  });

router.get('/medicine/:codice', richiedeAccount, (req, res) => {
  const r = praticaVisibile(req,
    () => medicine.perCodice(req.params.codice),
    (id) => medicine.perCodiceDelPaziente(req.params.codice, id));
  if (!r) throw new ErroreDominio('Richiesta non trovata. Controlla il codice.', 404);
  ok(res, {
    richiesta: {
      codice: r.codice, tipo: r.tipo, stato: r.stato, etichetta: medicine.ETICHETTE_STATO[r.stato],
      farmaci: r.farmaci, creata_il: r.creata_il, aggiornata_il: r.aggiornata_il,
      numero_ricetta: r.numero_ricetta,
      // Solo quanti sono: al paziente basta sapere che il documento e' arrivato.
      allegati: medicine.allegatiDi(r.id).length
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

/** Base pubblica per i link nelle email: il dominio vero se configurato. */
const basePubblica = () =>
  config.pubblico.url || `http://localhost:${config.port}`;
const linkVerificaEmail = (token) =>
  `${basePubblica()}/api/auth/verifica-email?token=${encodeURIComponent(token)}`;

router.post('/auth/register', limiteRegistrazione, (req, res) => {
  const esito = utenti.registraPaziente(req.body || {});
  // Nessuna sessione adesso: prima si conferma l'indirizzo dal link. La
  // risposta e' la stessa che l'email esista gia' o no; cambia solo quale
  // email parte, e quella la vede solo il titolare della casella.
  if (esito.giaRegistrato) {
    accoda('email', emailRegistrazioneEsistente({ to: esito.email, nome: esito.nome }));
  } else {
    accoda('email', emailVerificaPaziente({
      to: esito.utente.email, nome: esito.utente.nome, url: linkVerificaEmail(esito.token)
    }));
  }
  res.status(201).json({
    success: true,
    verifica_inviata: true,
    message: 'Se l\'indirizzo è corretto, ti abbiamo inviato un\'email: apri il link per confermare e accedere.'
  });
});

// Il link nell'email arriva qui: si conferma e si rimanda al sito.
router.get('/auth/verifica-email', (req, res) => {
  try {
    utenti.verificaEmailPaziente(req.query.token);
    res.redirect(303, '/?email=verificata');
  } catch {
    res.redirect(303, '/?email=nonvalida');
  }
});

router.post('/auth/verifica-email/rinvia', limiteRegistrazione, (req, res) => {
  const esito = utenti.preparaRinvioVerifica(req.body?.email);
  if (esito) {
    accoda('email', emailVerificaPaziente({
      to: esito.utente.email, nome: esito.utente.nome, url: linkVerificaEmail(esito.token)
    }));
  }
  // Risposta uguale in ogni caso: non si rivela se l'account esiste.
  ok(res, { message: 'Se l\'indirizzo corrisponde a un account da confermare, l\'email è ripartita.' });
});

router.post('/auth/login', limiteLogin, via(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const prima = fallimentiRecenti(email);

  if (prima >= MAX_FALLITI) {
    console.error(`[login] account in pausa dopo ${prima} fallimenti`);
    throw new ErroreDominio(
      'Troppi tentativi falliti su questo account. Riprova fra un quarto d\'ora.', 429
    );
  }

  const utente = db.prepare('SELECT * FROM utenti WHERE email = ?').get(email);

  if (!utente || !verificaPassword(String(req.body?.password || ''), utente.password_hash)) {
    const n = prima + 1;
    falliti.set(email, { n, ultimo: Date.now() });

    // Finisce in logs/errori.log senza indirizzi o altri identificativi.
    console.error(`[login] tentativo fallito n.${n}`);

    await pausa(RITARDI_MS[Math.min(n, RITARDI_MS.length - 1)]);

    // Messaggio unico: non riveliamo se l'indirizzo esiste.
    throw new ErroreDominio('Email o password non corretti.', 401);
  }

  // Account sospeso: la password puo' anche essere giusta, ma non si entra.
  if (utente.attivo === 0) {
    throw new ErroreDominio('Questo accesso e\' stato sospeso. Rivolgiti al medico.', 403);
  }

  // Un account paziente non confermato non entra: prima va aperto il link
  // dell'email di verifica. Lo staff non e' soggetto a questo controllo.
  if (utente.ruolo === 'paziente' && !utente.email_verificata) {
    falliti.delete(email);
    return res.status(403).json({
      success: false,
      verifica_email: true,
      message: 'Devi prima confermare il tuo indirizzo email. Controlla la posta o richiedi un nuovo link.'
    });
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
      paziente_id: utente.paziente_id || null,
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

router.get('/paziente/prenotazioni', richiedePaziente, (req, res) =>
  ok(res, { prenotazioni: prenotazioni.perPaziente(req.utente.paziente_id).map(pubblica) }));

router.get('/paziente/medicine', richiedePaziente, (req, res) =>
  ok(res, { richieste: medicine.perPaziente(req.utente.paziente_id) }));

router.get('/paziente/profilo', richiedePaziente, (req, res) =>
  ok(res, { profilo: utenti.profiloPaziente(req.utente.paziente_id) }));

router.patch('/paziente/profilo', limiteScrittura, richiedePaziente, (req, res) => {
  // Solo i campi previsti, presi uno per uno: gli id vengono SEMPRE dalla
  // sessione e non si possono sovrascrivere con quello che arriva nel corpo.
  const { nome, cognome, telefono, email, password } = req.body || {};
  const esito = utenti.aggiornaProfiloPaziente({
    pazienteId: req.utente.paziente_id,
    utenteId: req.utente.id,
    nome, cognome, telefono, email, password
  });
  if (esito.emailCambiata && esito.emailVecchia) {
    accoda('email', emailIndirizzoCambiato({ to: esito.emailVecchia, nuovo: esito.profilo.email }));
  }
  ok(res, { profilo: esito.profilo, email_cambiata: esito.emailCambiata });
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

/**
 * L'assistente del pannello.
 *
 * Sta dietro richiedeStaff come tutto il resto, e riceve req.utente perche' le
 * risposte cambiano con chi le chiede: il motivo della visita e' del medico, e
 * l'assistente non puo' diventare la porta di servizio da cui esce lo stesso.
 */
admin.get('/assistente', (req, res) => ok(res, assistente.benvenuto(req.utente)));

admin.post('/assistente', (req, res) =>
  ok(res, assistente.assiste(req.body?.testo, req.utente)));

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
      // Resta nel riepilogo anche se il pannello non lo mostra piu': dice
      // quante email il programma non ha ancora chiuso, ed e' il modo per
      // accorgersi che la pulizia automatica si e' inceppata.
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
  const p = prenotazioni.annullaPrenotazione(req.params.codice, {
    da: 'admin',
    chi: req.utente?.email || null
  });
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
  ok(res, {
    richiesta: medicine.conferma(req.params.codice, req.utente.email,
      { numeroRicetta: req.body?.numero_ricetta })
  });
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

/**
 * Il contenuto di un allegato, per guardarlo dentro il pannello.
 *
 * Esce con il suo tipo vero, quello riconosciuto dai byte al momento del
 * caricamento, e "inline" cosi' il browser lo disegna nella pagina invece di
 * scaricarlo. Si puo' fare solo perche' i tipi ammessi sono pochi e sono tutti
 * roba che il browser disegna e basta: se un domani si riaprisse la porta a
 * HTML o SVG, questa riga tornerebbe a dover essere "attachment".
 *
 * nosniff resta comunque: dice al browser di credere al tipo che gli diciamo e
 * di non tirare a indovinare guardando il contenuto.
 */
admin.get('/allegati/:id', (req, res) => {
  const a = medicine.allegato(Number(req.params.id));
  if (!a) throw new ErroreDominio('Allegato non trovato.', 404);

  const mostrabile = medicine.FORMATI_AMMESSI.includes(a.tipo_mime);

  res.setHeader('Content-Type', mostrabile ? a.tipo_mime : 'application/octet-stream');
  res.setHeader('Content-Length', a.byte);
  res.setHeader('Content-Disposition',
    `${mostrabile ? 'inline' : 'attachment'}; filename="${a.nome.replace(/"/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(a.contenuto);
});

admin.get('/email', (req, res) => ok(res, inbox.elencoEmail(req.query)));

admin.patch('/email/:codice', (req, res) => {
  ok(res, { email: inbox.segnaEmail(req.params.codice, req.body?.stato) });
});

admin.post('/email/controlla', via(async (_req, res) => {
  ok(res, { esito: await inbox.controllaCasella() });
}));

admin.get('/pazienti', (req, res) => ok(res, {
  pazienti: pazienti.elenco({
    cerca: req.query.cerca,
    dimessi: req.query.dimessi === '1'
  })
}));

/**
 * Dimettere e cancellare li puo' fare solo il medico.
 *
 * Non e' diffidenza verso la segreteria: e' che sono le due uniche azioni del
 * pannello che tolgono qualcosa invece di aggiungerlo, e la seconda non si
 * annulla. Chi risponde al telefono non ha motivo di trovarsele sotto il dito.
 */
admin.post('/pazienti/:id/dimetti', richiedeAdmin, (req, res) =>
  ok(res, { paziente: pazienti.dimetti(req.params.id, req.body?.dimesso !== false) }));

/** Cosa sparirebbe: il pannello lo dice prima di far premere il bottone. */
admin.get('/pazienti/:id/conteggi', richiedeAdmin, (req, res) =>
  ok(res, { conteggi: pazienti.conteggi(req.params.id) }));

admin.delete('/pazienti/:id', richiedeAdmin, (req, res) =>
  ok(res, { rimosso: pazienti.cancella(req.params.id) }));

/** Tutto quello che sappiamo di un paziente, in una schermata sola. */
admin.get('/pazienti/:id', richiedeAdmin, (req, res) => {
  const paziente = db.prepare('SELECT * FROM pazienti WHERE id = ?').get(Number(req.params.id));
  if (!paziente) throw new ErroreDominio('Paziente non trovato.', 404);

  ok(res, {
    paziente,
    prenotazioni: prenotazioni.perPaziente(paziente.id),
    // Cosa prende di solito. E' la risposta breve, quella che serve con il
    // paziente al telefono: l'elenco qui sotto e' la storia completa, e per
    // ricavarne la terapia in corso bisognerebbe leggersela tutta.
    abituali: medicine.abitualiDelPaziente(paziente.id),
    // Il fascicolo deve dire anche *come* e' finita: cosa aveva chiesto il
    // paziente prima che lo richiamassimo, perche' un no e' stato un no, chi ha
    // firmato la risposta e quando. Senza queste colonne resterebbe un elenco di
    // nomi di farmaci, che al controllo dopo non spiega niente.
    medicine: db.prepare(`
      SELECT r.id, r.codice, r.tipo, r.farmaci, r.note, r.stato, r.creata_il, r.origine,
             r.farmaci_originali, r.motivo_rifiuto, r.gestita_il, r.gestita_da,
             r.numero_ricetta,
             a.nome AS ambulatorio_nome
        FROM richieste_medicine r
        LEFT JOIN ambulatori a ON a.id = r.ambulatorio_id
       WHERE r.paziente_id = ? OR (lower(r.email) = lower(?) AND ? <> '')
       ORDER BY r.creata_il DESC
    `).all(paziente.id, paziente.email || '', paziente.email || '')
      // Le prescrizioni allegate servono anche qui: e' nel fascicolo che si
      // torna a cercarle mesi dopo, quando il paziente richiama e nessuno
      // ricorda piu' cosa aveva portato.
      .map((r) => ({ ...r, allegati: medicine.allegatiDi(r.id) }))
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
    // Gli indirizzi dei due moduli servono proprio quando il pannello non si
    // apre, quindi averli solo qui non basterebbe: stanno anche nell'email che
    // avvisa dell'assenza. Qui ci sono per poterli copiare con calma prima che
    // servano, che e' l'unico momento in cui si puo' farlo.
    moduli_link: config.moduli.link,
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

  // Un file oltre il limite lo ferma Express prima che il nostro codice lo veda,
  // quindi non passa dai controlli di medicine.js e arriverebbe qui come guasto
  // del server. Non lo e': e' una foto troppo grande, e chi la sta mandando deve
  // sentirsi dire quello, non "problema tecnico, riprova" — che lo farebbe
  // riprovare all'infinito con lo stesso file.
  if (err?.type === 'entity.too.large' || err?.status === 413) {
    return res.status(413).json({
      success: false,
      message: `Il file è troppo grande: il limite è ${Math.round(medicine.MASSIMO_BYTE_ALLEGATO / 1024 / 1024)} MB. `
        + 'Se è una foto, rifalla a risoluzione più bassa.'
    });
  }

  console.error('[api] errore non previsto:', err);
  res.status(500).json({
    success: false,
    message: 'Si è verificato un problema tecnico. La tua richiesta non è stata registrata: riprova.'
  });
});
