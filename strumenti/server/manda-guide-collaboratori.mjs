/**
 * Invio una tantum: manda entrambe le guide (staff + pazienti) a chi ha gia'
 * un accesso al pannello, non solo a chi lo riceve da ora in poi. Non tocca
 * nessuna credenziale, e' solo l'allegato che prima non c'era ancora.
 *
 *   node strumenti/server/manda-guide-collaboratori.mjs
 *
 * Mette le email in coda (stessa tabella outbox di tutte le altre): partono
 * al prossimo giro di invio del servizio, non subito da questo script.
 * Rilanciarlo manda le guide una seconda volta a tutti: va eseguito una
 * volta sola.
 */
import { db } from '../../src/db.js';
import { config } from '../../src/config.js';
import { accoda } from '../../src/outbox.js';
import { emailGuidePannello } from '../../src/mailer.js';
import { RUOLI_STAFF } from '../../src/auth.js';

const basePubblica = config.pubblico.url || `http://localhost:${config.port}`;

const collaboratori = db.prepare(`
  SELECT nome, email FROM utenti WHERE ruolo IN (${RUOLI_STAFF.map(() => '?').join(',')}) AND attivo = 1
`).all(...RUOLI_STAFF);

for (const c of collaboratori) {
  accoda('email', {
    ...emailGuidePannello({ to: c.email, nome: c.nome, url: `${basePubblica}/admin.html` }),
    allegaGuida: ['staff', 'pazienti']
  });
  console.log(`In coda per ${c.nome || c.email} <${c.email}>`);
}

console.log(`\nCollaboratori avvisati: ${collaboratori.length}`);
