#!/bin/bash
#
# Avvia una copia del sito con un database usa e getta, per provare le cose
# a mano senza toccare le prenotazioni vere e senza spedire email ai pazienti.
#
#   ./strumenti/prova-a-mano.sh
#
# Accesso al pannello:  prova@example.com  /  prova-password-1234

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"

export DB_FILE="data/banco-prova.sqlite"
rm -f "$DB_FILE" "$DB_FILE-wal" "$DB_FILE-shm"

# Servizi esterni spenti: niente email ai pazienti.
export EMAIL_USER="" EMAIL_PASS=""

export ADMIN_EMAIL="prova@example.com"
export ADMIN_PASSWORD="prova-password-1234"
export SEGRETARIA_EMAIL="" SEGRETARIA_PASSWORD=""

echo "Banco di prova — accedi con prova@example.com / prova-password-1234"
exec node server.js
