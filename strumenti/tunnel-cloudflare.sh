#!/bin/bash
#
# Porta il sito su internet passando da Cloudflare, senza aprire porte sul router.
#
#   ./strumenti/tunnel-cloudflare.sh installa studio.tuodominio.it
#   ./strumenti/tunnel-cloudflare.sh stato
#   ./strumenti/tunnel-cloudflare.sh riavvia
#   ./strumenti/tunnel-cloudflare.sh rimuovi
#
# Come funziona: un programmino (cloudflared) apre da solo una connessione
# verso Cloudflare e la tiene aperta. Le richieste dei pazienti arrivano a
# Cloudflare e scendono da quella connessione fino al Mac. Il router non
# c'entra: non c'e' nessuna porta da aprire, e non serve un IP fisso.
#
# Il lucchetto HTTPS lo mette Cloudflare. Il sito continua a parlare in chiaro
# sul suo localhost:3000, che e' dentro il Mac e non attraversa nessuna rete.
#
# ATTENZIONE: questo script mette il sito online per i pazienti. Non protegge
# da solo il pannello: quello si chiude con Cloudflare Access, dal pannello di
# controllo di Cloudflare. Le istruzioni sono in fondo, le stampa anche
# "stato". Senza Access, /admin.html e' raggiungibile da chiunque.

set -euo pipefail

NOME_TUNNEL="studio-medico"
ETICHETTA="com.studiomedico.tunnel"
CARTELLA="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
PLIST="$HOME/Library/LaunchAgents/$ETICHETTA.plist"
BERSAGLIO="gui/$(id -u)/$ETICHETTA"
CONF="$HOME/.cloudflared/config-studio.yml"
NOME_HOST_FILE="$HOME/.cloudflared/.studio-hostname"

servono_strumenti() {
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "cloudflared non e' installato. Installalo con:"
    echo
    echo "    brew install cloudflared"
    echo
    exit 1
  fi
}

installa() {
  local host="${1:-}"
  if [ -z "$host" ]; then
    echo "Serve l'indirizzo pubblico che vuoi usare. Esempio:"
    echo
    echo "    ./strumenti/tunnel-cloudflare.sh installa studio.tuodominio.it"
    echo
    echo "Il dominio deve gia' essere dentro Cloudflare (nameserver di Cloudflare)."
    exit 1
  fi

  servono_strumenti
  mkdir -p "$HOME/.cloudflared" "$CARTELLA/logs"

  # Primo collegamento all'account: apre il browser e chiede di scegliere il
  # dominio. Si fa una volta sola, il permesso resta in cert.pem.
  if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
    echo "Ora si apre il browser: accedi a Cloudflare e scegli il tuo dominio."
    cloudflared tunnel login
  fi

  # Il tunnel si crea una volta sola. Se esiste gia' si riusa: crearne un
  # secondo con lo stesso nome non si puo', e non servirebbe a niente.
  if ! cloudflared tunnel list --name "$NOME_TUNNEL" 2>/dev/null | grep -q "$NOME_TUNNEL"; then
    cloudflared tunnel create "$NOME_TUNNEL"
  fi

  local uuid credenziali
  uuid="$(cloudflared tunnel list --name "$NOME_TUNNEL" --output json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const t=JSON.parse(s)[0];if(!t){console.error("tunnel non trovato");process.exit(1)}process.stdout.write(t.id)})')"
  credenziali="$HOME/.cloudflared/$uuid.json"

  [ -f "$credenziali" ] || { echo "Manca il file credenziali $credenziali. Rifai la creazione del tunnel."; exit 1; }

  # Tutto quello che arriva a quell'indirizzo va al sito; qualunque altro nome
  # riceve un 404 secco, cosi' il tunnel non diventa una porta per altro.
  cat > "$CONF" <<CONFFINE
tunnel: $uuid
credentials-file: $credenziali

ingress:
  - hostname: $host
    service: http://localhost:3000
  - service: http_status:404
CONFFINE

  cloudflared tunnel --config "$CONF" ingress validate
  echo "$host" > "$NOME_HOST_FILE"

  # Nome pubblico -> tunnel. Cloudflare scrive da sola il record DNS.
  cloudflared tunnel route dns --overwrite-dns "$NOME_TUNNEL" "$host"

  # Come per il sito: servizio del solo utente, nessuna password di amministratore.
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
    <string>$(command -v cloudflared)</string>
    <string>tunnel</string>
    <string>--config</string>
    <string>$CONF</string>
    <string>run</string>
    <string>$NOME_TUNNEL</string>
  </array>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>$CARTELLA/logs/tunnel.log</string>
  <key>StandardErrorPath</key>
  <string>$CARTELLA/logs/tunnel-errori.log</string>
</dict>
</plist>
PLISTFINE

  plutil -lint "$PLIST" >/dev/null

  for tentativo in 1 2 3; do
    if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then break; fi
    [ "$tentativo" = 3 ] && { echo "Non sono riuscito ad avviare il tunnel. Riprova fra qualche secondo."; exit 1; }
    sleep 3
  done
  sleep 5

  echo
  echo "Tunnel attivo. Il sito risponde su https://$host"
  echo
  echo "Adesso mancano due cose, in quest'ordine:"
  echo
  echo "  1) In $CARTELLA/.env metti:"
  echo "         SITO_HTTPS=true"
  echo "         SITO_URL=https://$host"
  echo "         PROXY_DAVANTI=1"
  echo "     poi:  ./strumenti/avvio-automatico.sh riavvia"
  echo
  echo "  2) Chiudi il pannello con Cloudflare Access — vedi 'stato' per i percorsi."
  echo
  stato
}

stato() {
  local host="sconosciuto"
  [ -f "$NOME_HOST_FILE" ] && host="$(cat "$NOME_HOST_FILE")"

  if launchctl print "$BERSAGLIO" >/dev/null 2>&1; then
    local pid
    pid="$(launchctl print "$BERSAGLIO" | awk '/^\tpid =/{print $3}')"
    if [ -n "$pid" ]; then echo "Tunnel acceso (processo $pid)."; else echo "Tunnel registrato ma fermo — guarda logs/tunnel-errori.log"; fi
  else
    echo "Tunnel non installato."
  fi

  if [ "$host" != "sconosciuto" ]; then
    echo -n "Risposta da internet: "
    curl -s -o /dev/null -w "HTTP %{http_code}\n" --max-time 10 "https://$host/salute" || echo "nessuna risposta"
  fi

  cat <<ACCESSO

  --- Cloudflare Access: i tre percorsi da chiudere -----------------------

  Sul pannello Cloudflare: Zero Trust > Access > Applications > Add > Self-hosted.
  Crea UNA applicazione con dominio $host e questi percorsi (Add path):

      admin.html        la pagina del pannello
      api/admin         tutti i dati riservati
      api/auth          il login stesso

  Policy: Allow, con regola "Emails" e dentro gli indirizzi tuoi e dei
  collaboratori, uno per riga. Metodo di accesso: One-time PIN va bene,
  Google e' piu' comodo se hanno tutti Gmail.

  Il sito dei pazienti NON va protetto: resta fuori da Access, aperto a tutti.
  Il login dei pazienti non esiste, quindi chiudere api/auth non li tocca.

  Prova che ha funzionato: apri https://$host/admin.html da una finestra
  anonima. Devi vedere la schermata di Cloudflare, non quella del pannello.

ACCESSO
}

case "${1:-}" in
  installa)    installa "${2:-}" ;;
  stato)       stato ;;
  riavvia)     launchctl kickstart -k "$BERSAGLIO"; sleep 5; stato ;;
  rimuovi)     launchctl bootout "$BERSAGLIO" 2>/dev/null || true
               rm -f "$PLIST"
               echo "Tunnel spento e tolto dall'avvio automatico."
               echo "Il tunnel su Cloudflare esiste ancora: per cancellarlo del tutto"
               echo "    cloudflared tunnel delete $NOME_TUNNEL" ;;
  *)           echo "Usa: installa <indirizzo> | stato | riavvia | rimuovi"; exit 1 ;;
esac
