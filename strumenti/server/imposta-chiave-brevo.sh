#!/usr/bin/env bash
#
# Imposta (o aggiorna) BREVO_API_KEY nel .env del server e riavvia il
# servizio, cosi' la chiave e' subito attiva. La chiave stessa non sta mai
# in questo file: arriva come argomento, al momento di lanciarlo.
#
#   bash /opt/studiomedico/strumenti/server/imposta-chiave-brevo.sh 'xkeysib-...'
#
set -euo pipefail

CHIAVE="${1:-}"
APP_DIR="/opt/studiomedico"
ENV_FILE="$APP_DIR/.env"

[ "$(id -u)" = "0" ] || { echo "Esegui come root (sudo)."; exit 1; }
[ -n "$CHIAVE" ] || { echo "Uso: $0 <chiave-api-brevo>"; exit 1; }

if grep -q '^BREVO_API_KEY=' "$ENV_FILE"; then
  sed -i "s|^BREVO_API_KEY=.*|BREVO_API_KEY=$CHIAVE|" "$ENV_FILE"
else
  echo "BREVO_API_KEY=$CHIAVE" >> "$ENV_FILE"
fi

systemctl restart studiomedico
echo "Chiave di Brevo impostata e servizio riavviato."
