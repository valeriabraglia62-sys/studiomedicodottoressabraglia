#!/usr/bin/env bash
#
# Svuota i dati di prova dall'archivio, tenendo tutto il resto in piedi.
# Da eseguire sul server, come root:
#
#   bash /opt/studiomedico/strumenti/server/pulisci-dati-prova.sh SVUOTA
#
# Serve una volta sola, alla fine delle prove: si e' provato il sito con
# pazienti e prenotazioni finti, e quello che resta dentro non e' l'archivio
# dello studio ma il residuo delle prove.
#
# COSA TOGLIE:  pazienti e tutto quello che li riguarda (prenotazioni,
#               richieste di medicinali, medicinali abituali, allegati, lista
#               d'attesa), le sessioni aperte, le chat del chatbot, la coda
#               delle email.
# COSA TIENE:   gli accessi al pannello (medico e segreteria), gli ambulatori,
#               gli orari, le chiusure/ferie, le impostazioni.
#
# Non e' distruttivo alla cieca: prima chiede la parola SVUOTA come argomento,
# e mette da parte una copia dell'archivio in data/prima-pulizia-<data>.sqlite.
# Se domani salta fuori che dentro c'era qualcosa di vero, si rimette quella
# copia al suo posto e si riparte da dov'era.
#
set -euo pipefail

APP_USER="studiomedico"
APP_DIR="/opt/studiomedico"
DB="$APP_DIR/data/medstudent.sqlite"

[ "$(id -u)" = "0" ] || { echo "Esegui come root (sudo)."; exit 1; }

if [ "${1:-}" != "SVUOTA" ]; then
  echo "Questo comando svuota i dati di prova dall'archivio di produzione."
  echo "Tiene: accessi al pannello, ambulatori, orari, chiusure, impostazioni."
  echo "Toglie: pazienti, prenotazioni, richieste, allegati, lista d'attesa,"
  echo "        sessioni, chat, coda email."
  echo
  echo "Per procedere davvero, rilancia aggiungendo la parola SVUOTA:"
  echo "  bash $0 SVUOTA"
  exit 1
fi

[ -f "$DB" ] || { echo "Non trovo l'archivio in $DB. Non faccio niente."; exit 1; }

echo ">> Cosa c'e' dentro adesso"
node "$APP_DIR/strumenti/conta-archivio.cjs" || true

echo ">> Fermo il servizio"
systemctl stop studiomedico

SNAP="$APP_DIR/data/prima-pulizia-$(date +%Y%m%d-%H%M%S).sqlite"
echo ">> Copia di sicurezza -> $SNAP"
if command -v sqlite3 >/dev/null; then sqlite3 "$DB" ".backup '$SNAP'"; else cp "$DB" "$SNAP"; fi
chown "$APP_USER:$APP_USER" "$SNAP"

echo ">> Pulizia"
SCRIPT="/tmp/pulisci-dati-prova-$$.cjs"
cat > "$SCRIPT" <<'EOF'
const Database = require('/opt/studiomedico/node_modules/better-sqlite3');
const db = new Database('/opt/studiomedico/data/medstudent.sqlite');
db.pragma('foreign_keys = OFF');
const has = (t) => db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
).get(t);
const SVUOTA = [
  'allegati', 'richieste_medicine', 'medicine_abituali', 'lista_attesa',
  'prenotazioni', 'sessioni', 'chat_messaggi', 'chat_sessioni',
  'outbox', 'email_processate', 'pazienti'
];
db.transaction(() => {
  for (const t of SVUOTA) if (has(t)) db.prepare('DELETE FROM ' + t).run();
  db.prepare("DELETE FROM utenti WHERE ruolo = 'paziente'").run();
  // Gli id ripartono da 1, tranne gli ambulatori che restano com'erano.
  if (has('sqlite_sequence')) {
    db.prepare("DELETE FROM sqlite_sequence WHERE name NOT IN ('ambulatori')").run();
  }
})();
db.pragma('foreign_keys = ON');
db.exec('VACUUM');
const utenti = db.prepare('SELECT email, ruolo FROM utenti ORDER BY id').all();
console.log('   accessi rimasti:', JSON.stringify(utenti));
db.close();
EOF
chmod a+r "$SCRIPT"
sudo -u "$APP_USER" node "$SCRIPT"
rm -f "$SCRIPT"

echo ">> Riavvio il servizio"
systemctl start studiomedico

echo ">> Verifica"
for i in $(seq 1 15); do
  sleep 2
  if curl -fs -m 3 http://127.0.0.1:3000/salute >/dev/null; then
    echo ">> OK: il sito risponde."
    echo ">> Cosa c'e' dentro adesso"
    node "$APP_DIR/strumenti/conta-archivio.cjs" || true
    echo
    echo ">> La copia di prima e' in: $SNAP"
    echo ">> Non cancellarla finche' non sei sicuro che non serviva."
    exit 0
  fi
done

echo "!! Il sito non risponde dopo la pulizia. Controlla:  journalctl -u studiomedico -n 50"
echo "!! Per tornare com'era:"
echo "!!   systemctl stop studiomedico"
echo "!!   cp '$SNAP' '$DB'"
echo "!!   chown $APP_USER:$APP_USER '$DB'"
echo "!!   systemctl start studiomedico"
exit 1
