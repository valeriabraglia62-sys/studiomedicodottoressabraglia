/**
 * Dice quanto c'e' dentro l'archivio, senza mostrare nessun dato.
 *
 *   node strumenti/conta-archivio.cjs
 *
 * Sola lettura. Lo usa azzera-archivio.ps1 per far vedere il prima e il dopo,
 * ma serve anche da solo quando si vuole sapere a colpo d'occhio se dentro c'e'
 * qualcosa. Stampa numeri e basta: niente nomi, niente recapiti, niente
 * medicinali, cosi' si puo' lasciare aperto sullo schermo senza pensieri.
 */
const path = require('path');
const fs = require('fs');

const RADICE = path.dirname(__dirname);
const FILE = path.join(RADICE, 'data', 'medstudent.sqlite');

if (!fs.existsSync(FILE)) {
  console.log('  archivio non ancora creato (lo fa il programma alla prima accensione)');
  process.exit(0);
}

const Database = require(path.join(RADICE, 'node_modules', 'better-sqlite3'));
const db = new Database(FILE, { readonly: true });

const INTERESSANTI = [
  ['pazienti', 'pazienti in archivio'],
  ['prenotazioni', 'prenotazioni'],
  ['richieste_medicine', 'richieste di medicinali'],
  ['medicine_abituali', 'medicinali abituali'],
  ['richieste_email', 'email raccolte'],
  ['richieste_modulo', 'richieste dai Moduli'],
  ['utenti', 'accessi al pannello']
];

for (const [tabella, etichetta] of INTERESSANTI) {
  try {
    const n = db.prepare(`select count(*) as c from "${tabella}"`).get().c;
    console.log('  ' + String(n).padStart(5) + '  ' + etichetta);
  } catch {
    console.log('      -  ' + etichetta + ' (tabella non ancora creata)');
  }
}

db.close();
