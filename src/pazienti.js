import { db } from './db.js';
import { ErroreDominio } from './prenotazioni.js';

/**
 * Chi non e' piu' in carico allo studio.
 *
 * Ci sono due gesti diversi, e la differenza non e' un dettaglio tecnico:
 *
 *   dimetti   la persona sparisce dagli elenchi, la sua storia resta scritta.
 *             E' quello che serve quasi sempre: ha cambiato medico, si e'
 *             trasferita. Chi lavora non se la trova piu' fra i pazienti, e se
 *             fra due anni qualcuno chiede conto di una prescrizione la
 *             risposta c'e' ancora.
 *
 *   cancella  non resta niente. Visite, richieste, ricette, allegati: via.
 *             Serve quando una persona non doveva esserci — un doppione, un
 *             nome scritto per prova, qualcuno che chiede di essere rimosso —
 *             e non si torna indietro.
 *
 * Il secondo esiste perche' e' stato chiesto, ma non e' quello proposto per
 * primo, e prima di eseguirlo il pannello dice ad alta voce quanta storia sta
 * per portarsi via. Un errore qui non lo rimedia nessun backup di stasera.
 */

const trova = (id) => {
  const p = db.prepare('SELECT * FROM pazienti WHERE id = ?').get(Number(id));
  if (!p) throw new ErroreDominio('Paziente non trovato.', 404);
  return p;
};

/** Cosa si porterebbe via una cancellazione: si mostra prima di farla. */
export function conteggi(id) {
  const p = trova(id);
  const conta = (sql) => db.prepare(sql).get(p.id).n;

  return {
    paziente: p,
    visite: conta('SELECT COUNT(*) n FROM prenotazioni WHERE paziente_id = ?'),
    richieste: conta('SELECT COUNT(*) n FROM richieste_medicine WHERE paziente_id = ?'),
    abituali: conta('SELECT COUNT(*) n FROM medicine_abituali WHERE paziente_id = ?'),
    allegati: db.prepare(`
      SELECT COUNT(*) n FROM allegati
       WHERE richiesta_id IN (SELECT id FROM richieste_medicine WHERE paziente_id = ?)
    `).get(p.id).n,
    in_attesa: conta('SELECT COUNT(*) n FROM lista_attesa WHERE paziente_id = ?')
  };
}

/** Dimette o riammette. Riammettere serve: le persone tornano. */
export function dimetti(id, dimesso = true) {
  const p = trova(id);
  db.prepare('UPDATE pazienti SET dimesso_il = ? WHERE id = ?')
    .run(dimesso ? new Date().toISOString() : null, p.id);
  return trova(p.id);
}

/**
 * Cancella la persona e tutto quello che la riguarda.
 *
 * In una transazione sola: a meta' strada resterebbero prenotazioni che
 * puntano a un paziente che non esiste, e il pannello che le mostra andrebbe in
 * errore su una riga sola, senza far capire perche'.
 *
 * L'ordine e' dal basso: prima quello che dipende, per ultimo il paziente.
 * Gli allegati vanno tolti a mano prima delle richieste perche' il vincolo che
 * li lega con ON DELETE CASCADE funziona solo se le chiavi esterne sono
 * accese, e qui non si vuole dipendere da un'impostazione della connessione per
 * non lasciare in archivio delle foto di ricette senza piu' un proprietario.
 */
export function cancella(id) {
  const prima = conteggi(id);

  db.transaction(() => {
    db.prepare(`
      DELETE FROM allegati
       WHERE richiesta_id IN (SELECT id FROM richieste_medicine WHERE paziente_id = ?)
    `).run(prima.paziente.id);

    for (const sql of [
      'DELETE FROM richieste_medicine WHERE paziente_id = ?',
      'DELETE FROM medicine_abituali WHERE paziente_id = ?',
      'DELETE FROM lista_attesa WHERE paziente_id = ?',
      'DELETE FROM prenotazioni WHERE paziente_id = ?',
      // Un eventuale accesso personale collegato: si slega, non si cancella,
      // perche' potrebbe essere l'accesso di un collaboratore.
      'UPDATE utenti SET paziente_id = NULL WHERE paziente_id = ?',
      'DELETE FROM pazienti WHERE id = ?'
    ]) db.prepare(sql).run(prima.paziente.id);
  })();

  return {
    cancellato: `${prima.paziente.nome} ${prima.paziente.cognome}`,
    visite: prima.visite,
    richieste: prima.richieste,
    abituali: prima.abituali,
    allegati: prima.allegati
  };
}

/**
 * L'elenco per il pannello.
 *
 * I dimessi non ci sono, a meno che non si chiedano: e' il motivo per cui si
 * dimette qualcuno. Ma devono restare raggiungibili, altrimenti riammettere
 * una persona diventerebbe impossibile e la dimissione una porta a senso unico.
 */
export function elenco({ cerca, dimessi = false } = {}) {
  const q = String(cerca || '').trim();
  const dove = [];
  const par = [];

  if (q) {
    dove.push('(p.nome LIKE ? OR p.cognome LIKE ? OR p.telefono LIKE ? OR p.email LIKE ?)');
    par.push(...Array(4).fill(`%${q}%`));
  }
  if (!dimessi) dove.push('p.dimesso_il IS NULL');

  return db.prepare(`
    SELECT p.*,
           (SELECT COUNT(*) FROM prenotazioni WHERE paziente_id = p.id) AS visite,
           -- I primi farmaci che prende, i piu' recenti. Servono nell'elenco e
           -- non solo nel fascicolo: con il paziente al telefono si cerca il
           -- nome e la risposta deve essere gia' li', senza dover aprire la
           -- scheda per scoprire che quella persona prende il Coumadin.
           (SELECT group_concat(farmaco, ' · ') FROM (
              SELECT farmaco FROM medicine_abituali
               WHERE paziente_id = p.id ORDER BY ultima_volta DESC LIMIT 3
            )) AS medicine,
           (SELECT COUNT(*) FROM medicine_abituali WHERE paziente_id = p.id) AS quante_medicine
      FROM pazienti p
      ${dove.length ? `WHERE ${dove.join(' AND ')}` : ''}
     ORDER BY p.cognome, p.nome LIMIT 200
  `).all(...par);
}
