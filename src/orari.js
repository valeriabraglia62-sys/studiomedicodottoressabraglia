import { db } from './db.js';

// Durata di una visita. Definita qui una volta sola: prima il server generava
// slot da 15 minuti e il frontend da 30, quindi i due non coincidevano mai.
export const DURATA_SLOT_MINUTI = 15;

// Quanto in anticipo si puo' prenotare, in giorni.
export const GIORNI_PRENOTABILI = 60;

export const NOMI_GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
export const NOMI_MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

/** Vero per stringhe nella forma YYYY-MM-DD che indicano una data reale. */
export function dataValida(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [a, m, g] = s.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1, g));
  return d.getUTCFullYear() === a && d.getUTCMonth() === m - 1 && d.getUTCDate() === g;
}

/**
 * Giorno della settimana (0 = domenica) di una data YYYY-MM-DD.
 * Usa UTC di proposito: `new Date('2026-08-10')` interpretato in fuso locale
 * poteva restituire il giorno precedente, che era il bug degli slot sfasati.
 */
export function giornoSettimana(dataStr) {
  const [a, m, g] = dataStr.split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, g)).getUTCDay();
}

export const minutiDaOra = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const oraDaMinuti = (min) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Data odierna in fuso Europe/Rome, come YYYY-MM-DD. */
export function oggiISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

/** Minuti trascorsi da mezzanotte adesso, in fuso Europe/Rome. */
export function minutiCorrentiRoma() {
  const p = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const h = Number(p.find((x) => x.type === 'hour').value);
  const m = Number(p.find((x) => x.type === 'minute').value);
  return h * 60 + m;
}

export function aggiungiGiorni(dataStr, giorni) {
  const [a, m, g] = dataStr.split('-').map(Number);
  const d = new Date(Date.UTC(a, m - 1, g));
  d.setUTCDate(d.getUTCDate() + giorni);
  return d.toISOString().slice(0, 10);
}

export function formattaDataEstesa(dataStr) {
  const [a, m, g] = dataStr.split('-').map(Number);
  return `${NOMI_GIORNI[giornoSettimana(dataStr)]} ${g} ${NOMI_MESI[m - 1]} ${a}`;
}

export const listaAmbulatori = () =>
  db.prepare('SELECT * FROM ambulatori WHERE attivo = 1 ORDER BY id').all();

export const trovaAmbulatorio = (id) =>
  db.prepare('SELECT * FROM ambulatori WHERE id = ? AND attivo = 1').get(id);

export function orariAmbulatorio(ambulatorioId) {
  const righe = db.prepare(
    'SELECT giorno, ora_inizio, ora_fine FROM orari WHERE ambulatorio_id = ? ORDER BY giorno'
  ).all(ambulatorioId);
  const out = {};
  for (const r of righe) out[r.giorno] = r.ora_inizio ? { inizio: r.ora_inizio, fine: r.ora_fine } : null;
  return out;
}

/** Ambulatori chiusi in una certa data (ferie, festivi, chiusure straordinarie). */
export function chiusureDelGiorno(dataStr) {
  return db.prepare('SELECT ambulatorio_id, motivo FROM chiusure WHERE ? BETWEEN dal AND al')
    .all(dataStr);
}

/**
 * Slot di una data, con disponibilita' reale calcolata sul database.
 * E' l'unica fonte di verita': il frontend non ricalcola piu' nulla per conto suo.
 */
export function slotDisponibili(dataStr, ambulatorioId = null) {
  if (!dataValida(dataStr)) return [];

  const oggi = oggiISO();
  if (dataStr < oggi || dataStr > aggiungiGiorni(oggi, GIORNI_PRENOTABILI)) return [];

  const giorno = giornoSettimana(dataStr);
  const adesso = dataStr === oggi ? minutiCorrentiRoma() : -1;

  const chiusure = chiusureDelGiorno(dataStr);
  // Una chiusura senza ambulatorio vale per tutto lo studio.
  if (chiusure.some((c) => c.ambulatorio_id === null)) return [];
  const chiusi = new Set(chiusure.map((c) => c.ambulatorio_id));

  const ambulatori = (ambulatorioId
    ? [trovaAmbulatorio(ambulatorioId)].filter(Boolean)
    : listaAmbulatori()
  ).filter((a) => !chiusi.has(a.id));

  const occupati = new Set(
    db.prepare(
      `SELECT ambulatorio_id, ora_inizio FROM prenotazioni
        WHERE data = ? AND stato = 'confermata'`
    ).all(dataStr).map((p) => `${p.ambulatorio_id}|${p.ora_inizio}`)
  );

  const risultato = [];
  for (const amb of ambulatori) {
    const orario = db.prepare(
      'SELECT ora_inizio, ora_fine FROM orari WHERE ambulatorio_id = ? AND giorno = ?'
    ).get(amb.id, giorno);
    if (!orario?.ora_inizio) continue;

    const fine = minutiDaOra(orario.ora_fine);
    for (let t = minutiDaOra(orario.ora_inizio); t + DURATA_SLOT_MINUTI <= fine; t += DURATA_SLOT_MINUTI) {
      const ora = oraDaMinuti(t);
      risultato.push({
        ambulatorio_id: amb.id,
        ambulatorio_nome: amb.nome,
        ambulatorio_indirizzo: amb.indirizzo,
        data: dataStr,
        ora_inizio: ora,
        ora_fine: oraDaMinuti(t + DURATA_SLOT_MINUTI),
        // Uno slot gia' iniziato oggi non e' piu' prenotabile.
        disponibile: !occupati.has(`${amb.id}|${ora}`) && t > adesso
      });
    }
  }
  return risultato;
}

/** Giorni con almeno uno slot libero, per colorare il calendario. */
export function giorniConDisponibilita(dal, al, ambulatorioId = null) {
  const giorni = [];
  for (let d = dal; d <= al; d = aggiungiGiorni(d, 1)) {
    giorni.push({
      data: d,
      liberi: slotDisponibili(d, ambulatorioId).filter((s) => s.disponibile).length
    });
  }
  return giorni;
}
