#!/usr/bin/env bash
#
# Copia i backup CIFRATI del database su OneDrive (o altro cloud), ogni ora.
# Cosi' se il server sparisce, l'archivio no.
#
# Prima di usarlo, una volta sola, come utente studiomedico:
#   sudo -u studiomedico rclone config
#   -> crea un remote chiamato 'onedrive' (tipo: Microsoft OneDrive),
#      collegato all'account organizzativo dello studio.
#
# Poi:  systemctl enable --now backup-remoto.timer
#
set -euo pipefail

SORGENTE="/opt/studiomedico/data/backup"
REMOTO="${RCLONE_REMOTO:-onedrive:StudioMedico-Backup}"

[ -d "$SORGENTE" ] || { echo "Nessuna cartella backup ancora: $SORGENTE"; exit 0; }

# Solo i file .enc: i backup in chiaro non devono uscire dal server.
rclone copy "$SORGENTE" "$REMOTO" \
  --include "*.sqlite.enc" \
  --transfers 2 --checkers 4 --retries 3 \
  --log-level NOTICE

echo "Sincronizzati i backup cifrati verso ${REMOTO}."
