#!/usr/bin/env bash
#
# Installazione del sito su un server Linux nuovo (VPS Aruba, Ubuntu 24.04).
# Da eseguire UNA SOLA VOLTA, come root, appena creato il server.
#
#   1. crea il VPS (vedi DEPLOY-SERVER.md)
#   2. nel pannello DNS Aruba: record A  @  ->  IP del server
#                              record A  www ->  IP del server
#   3. copia questo file sul server e lancialo:
#        bash setup-server.sh
#
#   Il dominio e l'email del certificato hanno gia' il valore giusto qui sotto;
#   per usarne altri:  DOMINIO=altro.it EMAIL_TLS=tu@mail.it bash setup-server.sh
#
# Dopo, gli aggiornamenti si fanno con  strumenti/server/deploy.sh
#
set -euo pipefail

DOMINIO="${DOMINIO:-studiomedicobragliavaleria.it}"
EMAIL_TLS="${EMAIL_TLS:-auslvaleria@gmail.com}"
REPO="${REPO:-https://github.com/valeriabraglia62-sys/studiomedicodottoressabraglia.git}"
BRANCH="${BRANCH:-main}"
APP_USER="studiomedico"
APP_DIR="/opt/studiomedico"
NODE_MAJOR="22"

echo ">> Aggiorno il sistema e installo gli strumenti di base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg git build-essential python3 ufw \
  unattended-upgrades sqlite3 fail2ban

echo ">> Aggiornamenti di sicurezza automatici"
dpkg-reconfigure -f noninteractive unattended-upgrades || true

echo ">> Firewall: solo SSH, HTTP, HTTPS"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo ">> fail2ban: banna gli IP che martellano SSH"
cat > /etc/fail2ban/jail.local <<'F2B'
[DEFAULT]
backend = systemd
banaction = nftables
banaction_allports = nftables[type=allports]

[sshd]
enabled = true
port = ssh
maxretry = 5
findtime = 3600
bantime = 3600
F2B
systemctl enable --now fail2ban
systemctl restart fail2ban

echo ">> Installo Node.js ${NODE_MAJOR} LTS (repository APT firmato, senza curl|bash)"
if ! command -v node >/dev/null || [ "$(node -v | cut -c2-3)" != "${NODE_MAJOR}" ]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -y
  apt-get install -y nodejs
fi
node -v

echo ">> Installo Caddy (reverse proxy con HTTPS automatico)"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy
fi

echo ">> Creo l'utente di servizio '${APP_USER}' e sistemo il codice"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
if [ ! -d "$APP_DIR/.git" ]; then
  rm -rf "$APP_DIR"
  git clone --branch "$BRANCH" "$REPO" "$APP_DIR"
fi

# Il CODICE resta di root e in sola lettura per il servizio: cosi' una
# compromissione dell'app non puo' riscriverlo. Solo data/ e logs/ sono
# scrivibili dall'utente di servizio. Gli aggiornamenti (deploy.sh) girano
# come root, che e' quindi l'utente "di deploy", separato da quello runtime.
chown -R root:root "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 700 "$APP_DIR/data" "$APP_DIR/data/backup" "$APP_DIR/logs"

echo ">> Installo le dipendenze del progetto"
( cd "$APP_DIR" && npm ci --omit=dev )

echo ">> Preparo il file di configurazione (.env)"
if [ ! -f "$APP_DIR/.env" ]; then
  install -o root -g "$APP_USER" -m 640 "$APP_DIR/.env.server.example" "$APP_DIR/.env"
  SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  BK_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  sed -i \
    -e "s|^SITO_URL=.*|SITO_URL=https://${DOMINIO}|" \
    -e "s|^HOST_AMMESSI=.*|HOST_AMMESSI=${DOMINIO},www.${DOMINIO}|" \
    -e "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" \
    -e "s|^BACKUP_ENCRYPTION_KEY=.*|BACKUP_ENCRYPTION_KEY=${BK_KEY}|" \
    "$APP_DIR/.env"
  echo
  echo "   !!!  ANNOTA QUESTA CHIAVE DI CIFRATURA DEI BACKUP, FUORI DAL SERVER:  !!!"
  echo "        BACKUP_ENCRYPTION_KEY=${BK_KEY}"
  echo "   Senza, un backup cifrato non si recupera piu'."
  echo
  echo "   Ora apri  $APP_DIR/.env  e riempi: EMAIL_USER, EMAIL_PASS, ADMIN_EMAIL,"
  echo "   ADMIN_PASSWORD (solo per il primo avvio), e le chiavi Google se le usi."
  echo "   Poi rilancia:  systemctl restart studiomedico"
fi

echo ">> Installo il servizio systemd"
sed "s|__APP_DIR__|$APP_DIR|g; s|__APP_USER__|$APP_USER|g" \
  "$APP_DIR/strumenti/server/studiomedico.service" > /etc/systemd/system/studiomedico.service
systemctl daemon-reload
systemctl enable --now studiomedico

echo ">> Configuro Caddy per ${DOMINIO}"
sed "s|__DOMINIO__|$DOMINIO|g; s|__EMAIL_TLS__|$EMAIL_TLS|g" \
  "$APP_DIR/strumenti/server/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo ">> Backup offsite (opzionale): installo rclone"
command -v rclone >/dev/null || apt-get install -y rclone
sed "s|__APP_DIR__|$APP_DIR|g; s|__APP_USER__|$APP_USER|g" \
  "$APP_DIR/strumenti/server/backup-remoto.service" > /etc/systemd/system/backup-remoto.service
cp "$APP_DIR/strumenti/server/backup-remoto.timer" /etc/systemd/system/backup-remoto.timer
systemctl daemon-reload

cat <<FINE

============================================================
Installazione completata.

Il sito e' su:  https://${DOMINIO}
(il certificato HTTPS lo prende Caddy da solo in un minuto)

Controlla:
  systemctl status studiomedico
  curl -s http://127.0.0.1:3000/salute
  journalctl -u studiomedico -n 30

DA FARE ADESSO:
  1. Apri  ${APP_DIR}/.env  e riempi EMAIL_USER / EMAIL_PASS / ADMIN_* / Google.
     Poi:  systemctl restart studiomedico
  2. Backup offsite verso OneDrive (consigliato):
       sudo -u ${APP_USER} rclone config     # crea un remote chiamato 'onedrive'
       systemctl enable --now backup-remoto.timer
  3. Entra nel pannello, cambia la password provvisoria, poi svuota
     ADMIN_PASSWORD nel .env e  systemctl restart studiomedico
============================================================
FINE
