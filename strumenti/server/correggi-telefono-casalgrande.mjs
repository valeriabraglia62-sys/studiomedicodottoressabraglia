/**
 * Correzione una tantum: il numero di telefono dell'ambulatorio di
 * Casalgrande deve essere lo stesso di quello di Arceto (329 154 5236), non
 * il vecchio 347 245 0118. Il codice e' gia' stato aggiornato, ma il seed di
 * db.js usa INSERT OR IGNORE: su un database gia' esistente non tocca la riga
 * che c'e' gia'. Questo script sistema il dato in produzione.
 *
 *   node strumenti/server/correggi-telefono-casalgrande.mjs
 *
 * Idempotente: si puo' rilanciare senza rischi, non fa danni se il numero e'
 * gia' quello giusto.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const db = new Database(path.join(ROOT, 'data', 'medstudent.sqlite'));

console.log('Prima:', db.prepare('SELECT nome, telefono FROM ambulatori').all());

const cambiate = db.prepare(
  "UPDATE ambulatori SET telefono = '3291545236' WHERE nome = 'Ambulatorio di Casalgrande'"
).run().changes;

console.log(`Righe aggiornate: ${cambiate}`);
console.log('Dopo:', db.prepare('SELECT nome, telefono FROM ambulatori').all());
