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

cd "$APP_DIR"
PRIMA="$(git rev-parse HEAD)"
echo ">> Versione attuale: ${PRIMA:0:12}"

sudo -u "$APP_USER" git fetch --quiet origin "$BRANCH"
DOPO="$(git rev-parse "origin/$BRANCH")"
if [ "$PRIMA" = "$DOPO" ]; then
  echo ">> Gia' aggiornato, niente da fare."
  exit 0
fi

echo ">> Aggiorno a ${DOPO:0:12}"
sudo -u "$APP_USER" git reset --hard "origin/$BRANCH"

if ! git diff --quiet "$PRIMA" "$DOPO" -- package-lock.json; then
  echo ">> package-lock.json e' cambiato: reinstallo le dipendenze"
  sudo -u "$APP_USER" npm ci --omit=dev
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
sudo -u "$APP_USER" git reset --hard "$PRIMA"
sudo -u "$APP_USER" npm ci --omit=dev
systemctl restart studiomedico
echo "!! Rollback fatto. Controlla:  journalctl -u studiomedico -n 50"
exit 1
