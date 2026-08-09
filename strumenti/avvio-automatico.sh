#!/bin/bash
#
# Fa partire il sito da solo a ogni accensione del Mac.
#
#   ./strumenti/avvio-automatico.sh            installa (o aggiorna)
#   ./strumenti/avvio-automatico.sh stato      dice se sta girando
#   ./strumenti/avvio-automatico.sh riavvia    lo spegne e riaccende
#   ./strumenti/avvio-automatico.sh rimuovi    toglie l'avvio automatico
#
# Non serve la password di amministratore: e' un servizio del solo utente.

set -euo pipefail

ETICHETTA="com.studiomedico.server"
CARTELLA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLIST="$HOME/Library/LaunchAgents/$ETICHETTA.plist"
BERSAGLIO="gui/$(id -u)/$ETICHETTA"

installa() {
  local nodo
  nodo="$(command -v node || true)"
  [ -x "$nodo" ] || { echo "Node.js non trovato. Installalo da https://nodejs.org e riprova."; exit 1; }

  mkdir -p "$HOME/Library/LaunchAgents" "$CARTELLA/logs"

  # Se era gia' installato lo scarico, altrimenti il file nuovo verrebbe ignorato.
  # Lo scarico non e' immediato: se ripartissi subito macOS risponderebbe
  # "Input/output error" e resteremmo senza sito. Quindi aspetto che sparisca.
  if launchctl print "$BERSAGLIO" >/dev/null 2>&1; then
    launchctl bootout "$BERSAGLIO" 2>/dev/null || true
    for _ in $(seq 1 30); do
      launchctl print "$BERSAGLIO" >/dev/null 2>&1 || break
      sleep 1
    done
  fi

  cat > "$PLIST" <<PLISTFINE
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$ETICHETTA</string>

  <key>ProgramArguments</key>
  <array>
    <string>$nodo</string>
    <string>server.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$CARTELLA</string>

  <!-- Parte da solo all'accensione, senza aprire niente. -->
  <key>RunAtLoad</key>
  <true/>

  <!-- Se il server cade per un errore, macOS lo riaccende da solo. -->
  <key>KeepAlive</key>
  <true/>

  <!-- Pausa fra un riavvio e l'altro: evita di riprovare all'infinito
       se il guasto e' serio (per esempio il disco pieno). -->
  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(dirname "$nodo"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>StandardOutPath</key>
  <string>$CARTELLA/logs/server.log</string>
  <key>StandardErrorPath</key>
  <string>$CARTELLA/logs/errori.log</string>
</dict>
</plist>
PLISTFINE

  plutil -lint "$PLIST" >/dev/null

  # Un paio di tentativi: alla prima accensione capita che macOS sia ancora
  # occupato a chiudere il servizio precedente.
  for tentativo in 1 2 3; do
    if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then break; fi
    [ "$tentativo" = 3 ] && { echo "Non sono riuscito a installarlo. Riprova fra qualche secondo."; exit 1; }
    sleep 3
  done
  sleep 3
  echo "Installato. Il sito ripartira' da solo a ogni accensione."
  stato
}

stato() {
  if launchctl print "$BERSAGLIO" >/dev/null 2>&1; then
    local pid
    pid="$(launchctl print "$BERSAGLIO" | awk '/^\tpid =/{print $3}')"
    if [ -n "$pid" ]; then echo "Acceso (processo $pid)."; else echo "Registrato ma fermo — guarda logs/errori.log"; fi
  else
    echo "Avvio automatico non installato."
  fi
  echo -n "Risposta del sito: "
  curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 5 http://localhost:3000/ || echo "nessuna risposta"
  local ip
  ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  [ -n "$ip" ] && echo "Dagli altri computer in studio: http://$ip:3000"
}

case "${1:-installa}" in
  installa|'') installa ;;
  stato)       stato ;;
  riavvia)     launchctl kickstart -k "$BERSAGLIO"; sleep 3; stato ;;
  rimuovi)     launchctl bootout "$BERSAGLIO" 2>/dev/null || true
               rm -f "$PLIST"
               echo "Avvio automatico rimosso. Il sito non ripartira' piu' da solo." ;;
  *)           echo "Usa: installa | stato | riavvia | rimuovi"; exit 1 ;;
esac
