#!/usr/bin/env bash
#
# Aggiorna il sito all'ultima versione. Da eseguire sul server, come root:
#
#   bash /opt/studiomedico/strumenti/server/deploy.sh
#
# Scarica il codice nuovo, reinstalla le dipendenze se sono cambiate, riavvia
# il servizio (le migrazioni del database partono da sole all'avvio) e verifica
# che il sito risponda. Se qualcosa va storto, torna alla versione precedente.
#
set -euo pipefail

APP_USER="studiomedico"
APP_DIR="/opt/studiomedico"
BRANCH="${BRANCH:-main}"

[ "$(id -u)" = "0" ] || { echo "Esegui come root (sudo)."; exit 1; }

cd "$APP_DIR"
# Il codice e' di root: fetch/reset/npm girano come root (utente "di deploy",
# diverso da quello che poi esegue il servizio).
PRIMA="$(git rev-parse HEAD)"
echo ">> Versione attuale: ${PRIMA:0:12}"

git fetch --quiet origin "$BRANCH"
DOPO="$(git rev-parse "origin/$BRANCH")"
if [ "$PRIMA" = "$DOPO" ]; then
  echo ">> Gia' aggiornato, niente da fare."
  exit 0
fi

echo ">> Copia di sicurezza del database prima dell'aggiornamento"
DB="$APP_DIR/data/medstudent.sqlite"
if [ -f "$DB" ]; then
  SNAP="$APP_DIR/data/pre-deploy-$(date +%Y%m%d-%H%M%S).sqlite"
  if command -v sqlite3 >/dev/null; then sqlite3 "$DB" ".backup '$SNAP'"; else cp "$DB" "$SNAP"; fi
  chown "$APP_USER:$APP_USER" "$SNAP"
  # Tiene solo le ultime 3 copie pre-deploy.
  ls -1t "$APP_DIR"/data/pre-deploy-*.sqlite 2>/dev/null | tail -n +4 | xargs -r rm -f
  echo "   -> $SNAP"
fi

echo ">> Aggiorno a ${DOPO:0:12}"
git reset --hard "origin/$BRANCH"
chown -R root:root "$APP_DIR/src" "$APP_DIR/public" "$APP_DIR/server.js" "$APP_DIR/strumenti" 2>/dev/null || true

if ! git diff --quiet "$PRIMA" "$DOPO" -- package-lock.json package.json; then
  echo ">> le dipendenze sono cambiate: reinstallo"
  npm ci --omit=dev
fi

echo ">> Riavvio il servizio"
systemctl restart studiomedico

echo ">> Verifica"
for i in $(seq 1 15); do
  sleep 2
  if curl -fs -m 3 http://127.0.0.1:3000/salute >/dev/null; then
    echo ">> OK: il sito risponde. Aggiornamento completato (${DOPO:0:12})."
    exit 0
  fi
done

echo "!! Il sito non risponde dopo l'aggiornamento. Torno indietro a ${PRIMA:0:12}."
git reset --hard "$PRIMA"
npm ci --omit=dev
systemctl restart studiomedico
echo "!! Rollback del CODICE fatto. Se il problema era una migrazione del"
echo "!! database, ripristina anche il DB dall'ultima copia:"
echo "!!   ls -1t $APP_DIR/data/pre-deploy-*.sqlite | head -1"
echo "!!   systemctl stop studiomedico && cp <quella> $APP_DIR/data/medstudent.sqlite && systemctl start studiomedico"
echo "!! Log:  journalctl -u studiomedico -n 50"
exit 1
