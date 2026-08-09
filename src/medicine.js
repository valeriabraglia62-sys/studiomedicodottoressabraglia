import { db } from './db.js';
import { accoda } from './outbox.js';
import { trovaAmbulatorio } from './orari.js';
import {
  ErroreDominio, generaCodice, trovaOCreaPaziente, telefonoValido, emailValida
} from './prenotazioni.js';
import {
  emailNuovaMedicinaAdmin, emailRicevutaMedicinaPaziente, emailMedicinaPronta
} from './mailer.js';

export const STATI = ['nuova', 'in_lavorazione', 'pronta', 'consegnata', 'annullata'];

export const ETICHETTE_STATO = {
  nuova: 'Nuova',
  in_lavorazione: 'In lavorazione',
  pronta: 'Pronta per il ritiro',
  consegnata: 'Consegnata',
  annullata: 'Annullata'
};

const testoPulito = (v, max) => String(v ?? '').trim().replace(/[ \t]+/g, ' ').slice(0, max);

const SELECT_COMPLETO = `
  SELECT r.*, a.nome AS ambulatorio_nome
    FROM richieste_medicine r
    LEFT JOIN ambulatori a ON a.id = r.ambulatorio_id
`;

export const perCodice = (codice) =>
  db.prepare(`${SELECT_COMPLETO} WHERE r.codice = ?`).get(String(codice || '').trim().toUpperCase());

export const dettaglio = (id) => db.prepare(`${SELECT_COMPLETO} WHERE r.id = ?`).get(id);

export function creaRichiesta(dati) {
  const nome = testoPulito(dati.nome, 60);
  const cognome = testoPulito(dati.cognome, 60);
  const farmaci = testoPulito(dati.farmaci, 1500);
  const note = testoPulito(dati.note, 500) || null;
  const telefono = String(dati.telefono ?? '').replace(/[\s.\-()]/g, '');
  const email = dati.email ? String(dati.email).trim().toLowerCase() : null;
  const origine = dati.origine || 'sito';

  if (nome.length < 2) throw new ErroreDominio('Inserisci un nome valido.');
  if (cognome.length < 2) throw new ErroreDominio('Inserisci un cognome valido.');
  if (farmaci.length < 2) throw new ErroreDominio('Indica quali medicinali ti servono.');
  if (email && !emailValida(email)) throw new ErroreDominio('L\'indirizzo email non è valido.');

  // Dalle email in arrivo il telefono spesso manca: non blocchiamo la richiesta,
  // perche' perderla sarebbe peggio che registrarla incompleta.
  if (origine === 'sito' && !telefonoValido(telefono)) {
    throw new ErroreDominio('Inserisci un numero di telefono valido (8-11 cifre).');
  }
  if (!email && !telefonoValido(telefono)) {
    throw new ErroreDominio('Serve almeno un recapito: telefono o email.');
  }

  const ambulatorio = dati.ambulatorio_id ? trovaAmbulatorio(dati.ambulatorio_id) : null;

  const transazione = db.transaction(() => {
    const paziente = telefonoValido(telefono)
      ? trovaOCreaPaziente({ nome, cognome, email, telefono })
      : null;

    const codice = generaCodice('MED');
    const info = db.prepare(`
      INSERT INTO richieste_medicine
        (codice, paziente_id, nome, cognome, telefono, email, farmaci, note, ambulatorio_id, origine, creata_il)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(codice, paziente?.id ?? null, nome, cognome, telefono || null, email,
      farmaci, note, ambulatorio?.id ?? null, origine, new Date().toISOString());

    const richiesta = dettaglio(info.lastInsertRowid);

    accoda('sheet_medicina', richiesta);
    accoda('email', emailNuovaMedicinaAdmin(richiesta));
    // Chi scrive via email ha gia' il proprio messaggio: evitiamo il rimbalzo.
    if (richiesta.email && origine !== 'email') {
      accoda('email', emailRicevutaMedicinaPaziente(richiesta));
    }

    return richiesta;
  });

  return transazione();
}

export function aggiornaStato(codice, nuovoStato) {
  if (!STATI.includes(nuovoStato)) throw new ErroreDominio('Stato non valido.');

  const richiesta = perCodice(codice);
  if (!richiesta) throw new ErroreDominio('Richiesta non trovata.', 404);
  if (richiesta.stato === nuovoStato) return richiesta;

  const transazione = db.transaction(() => {
    db.prepare('UPDATE richieste_medicine SET stato = ?, aggiornata_il = ? WHERE id = ?')
      .run(nuovoStato, new Date().toISOString(), richiesta.id);

    const aggiornata = dettaglio(richiesta.id);
    accoda('sheet_medicina', aggiornata);
    if (nuovoStato === 'pronta' && aggiornata.email) {
      accoda('email', emailMedicinaPronta(aggiornata));
    }
    return aggiornata;
  });

  return transazione();
}

export function elencoAdmin({ stato, cerca, pagina = 1, perPagina = 50 } = {}) {
  const dove = [];
  const par = [];

  if (stato) { dove.push('r.stato = ?'); par.push(stato); }
  if (cerca) {
    dove.push('(r.nome LIKE ? OR r.cognome LIKE ? OR r.telefono LIKE ? OR r.email LIKE ? OR r.farmaci LIKE ? OR r.codice LIKE ?)');
    const q = `%${cerca}%`;
    par.push(q, q, q, q, q, q.toUpperCase());
  }

  const filtro = dove.length ? `WHERE ${dove.join(' AND ')}` : '';
  const totale = db.prepare(`SELECT COUNT(*) AS n FROM richieste_medicine r ${filtro}`).get(...par).n;

  const limite = Math.min(Math.max(Number(perPagina) || 50, 1), 200);
  const offset = (Math.max(Number(pagina) || 1, 1) - 1) * limite;

  const righe = db.prepare(
    `${SELECT_COMPLETO} ${filtro} ORDER BY
       CASE r.stato WHEN 'nuova' THEN 0 WHEN 'in_lavorazione' THEN 1 WHEN 'pronta' THEN 2 ELSE 3 END,
       r.creata_il DESC
     LIMIT ? OFFSET ?`
  ).all(...par, limite, offset);

  return { richieste: righe, totale, pagina: Number(pagina) || 1, pagine: Math.ceil(totale / limite) || 1 };
}
