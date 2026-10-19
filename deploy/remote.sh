#!/usr/bin/env bash
# New, dedicated Ubuntu servers only. Never imports an existing kitchen installation.
set -Eeuo pipefail
umask 077
release_id=${1:?release id required}
[[ "$release_id" =~ ^[a-f0-9-]{36}$ ]] || { echo 'Invalid release ID'; exit 1; }
stage="/tmp/our-kitchen-$release_id"
[[ $(id -u) == 0 && -d "$stage" && ! -L "$stage" ]] || { echo 'Root or passwordless sudo is required'; exit 1; }
base=/opt/our-kitchen
config=/etc/our-kitchen
data=/var/lib/our-kitchen
node_version=24.21.0
caddy_version=2.11.7
. /etc/os-release
[[ "$ID" == ubuntu && ( "$VERSION_ID" == 22.04 || "$VERSION_ID" == 24.04 ) ]] || { echo 'Supported: Ubuntu 22.04/24.04'; exit 1; }
case $(uname -m) in x86_64) node_arch=x64; caddy_arch=amd64;; aarch64) node_arch=arm64; caddy_arch=arm64;; *) echo 'Supported CPU: x64/ARM64'; exit 1;; esac
command -v systemctl >/dev/null
command -v python3 >/dev/null
if [[ -e "$config/managed" ]]; then
  [[ ! -L "$config" && $(cat "$config/managed") == 'our-kitchen-v1' ]] || { echo 'Unknown installation'; exit 1; }
else
  for target in "$base" "$config" "$data" /etc/systemd/system/our-kitchen.service /etc/systemd/system/our-kitchen-caddy.service; do
    [[ ! -e "$target" && ! -L "$target" ]] || { echo 'Existing paths found; refusing to take over another installation'; exit 1; }
  done
fi
[[ $(df -Pk /opt | awk 'NR==2 {print $4}') -ge 2097152 ]] || { echo 'At least 2 GiB free space required'; exit 1; }
# An occupied port is allowed only when owned by this installation's managed services.
export KITCHEN_APP_PID=$(systemctl show -p MainPID --value our-kitchen.service 2>/dev/null || echo 0)
export KITCHEN_CADDY_PID=$(systemctl show -p MainPID --value our-kitchen-caddy.service 2>/dev/null || echo 0)
python3 - <<'PY'
import os,re,subprocess
allowed={int(v) for v in [os.environ['KITCHEN_APP_PID'],os.environ['KITCHEN_CADDY_PID']] if v.isdigit() and int(v)>0}
rows=subprocess.check_output(['ss','-H','-ltnp','( sport = :80 or sport = :443 or sport = :3001 )'],text=True)
for row in rows.splitlines():
    owners={int(v) for v in re.findall(r'pid=(\d+)',row)}
    if not owners or not owners <= allowed:
        raise SystemExit('Ports 80/443/3001 are occupied by another service; nothing was stopped')
PY
python3 - "$stage/site.json" "$stage" <<'PY'
import json,sys,ipaddress,re,pathlib
site=json.load(open(sys.argv[1]));host=site.get('host','');email=site.get('email','')
try:
    ip=ipaddress.ip_address(host)
    if not ip.is_global: raise SystemExit('Public IP required')
except ValueError:
    if not re.fullmatch(r'(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}',host): raise SystemExit('Invalid website host')
if not re.fullmatch(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}',email) or site.get('terms') is not True: raise SystemExit('Certificate email and explicit terms agreement required')
pathlib.Path(sys.argv[2]+'/host').write_text(host)
pathlib.Path(sys.argv[2]+'/email').write_text(email)
PY
host=$(cat "$stage/host"); email=$(cat "$stage/email")
exec 9>"$stage/install.lock"
flock -n 9 || { echo 'Installation already running'; exit 1; }
# A global installation lock prevents concurrent uploads from switching releases.
install -d -m 0755 "$base"
exec 8>"$base/deploy.lock"
flock -n 8 || { echo 'Another deployment is running'; exit 1; }
install -d -m 0700 "$config"
printf '%s\n' our-kitchen-v1 > "$config/managed"
install -d -m 0700 "$base/releases"
release="$base/releases/$release_id"
[[ ! -e "$release" ]] || { echo 'Release already exists'; exit 1; }
mkdir "$release"
# Validate the archive before extraction (no links, traversal, or private data).
python3 - "$stage/source.tar.gz" <<'PY'
import sys,tarfile,pathlib
roots={'package.json','package-lock.json','index.html','vite.config.js','src','server','public','scripts','deploy','tests','seed-assets','third_party','.env.example','.gitignore','.dockerignore','DESIGN.md','README.md','LICENSE','Dockerfile','compose.yaml','start.bat','deploy.bat'}
with tarfile.open(sys.argv[1]) as archive:
    for member in archive.getmembers():
        p=pathlib.PurePosixPath(member.name)
        if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0] not in roots or not (member.isfile() or member.isdir()):
            raise SystemExit('Unsafe source archive')
        if any(x in {'.local','.git','node_modules','data','data-demo','uploads'} or (x.startswith('.env') and x!='.env.example') for x in p.parts):
            raise SystemExit('Private path in source archive')
    archive.extractall(sys.argv[1].rsplit('/',1)[0]+'/validated')
PY
cp -a "$stage/validated/." "$release/"
echo '[1/6] Installing system dependencies...'
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl xz-utils python3-venv build-essential git
install -d -m 0755 "$base/runtime"
node_home="$base/runtime/node-v$node_version-linux-$node_arch"
if [[ ! -x "$node_home/bin/node" ]]; then
  file="node-v$node_version-linux-$node_arch.tar.xz"
  curl --fail --location --retry 2 "https://nodejs.org/dist/v$node_version/$file" -o "$stage/$file"
  curl --fail --location --retry 2 "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$stage/node-checksums"
  (cd "$stage"; grep -E "^[a-f0-9]{64}  $file$" node-checksums | sha256sum --check --strict -)
  tar -xJf "$stage/$file" -C "$base/runtime" --no-same-owner
fi
export PATH="$node_home/bin:$PATH"
[[ $(node -p 'process.versions.node.split(".")[0]') == 24 ]]
if [[ ! -x "$base/runtime/caddy-$caddy_version" ]]; then
  file="caddy_${caddy_version}_linux_${caddy_arch}.tar.gz"
  curl --fail --location --retry 2 "https://github.com/caddyserver/caddy/releases/download/v$caddy_version/$file" -o "$stage/$file"
  curl --fail --location --retry 2 "https://github.com/caddyserver/caddy/releases/download/v$caddy_version/caddy_${caddy_version}_checksums.txt" -o "$stage/caddy-checksums"
  (cd "$stage"; grep -E "^[a-f0-9]{64}  $file$" caddy-checksums | sha256sum --check --strict -)
  mkdir "$stage/caddy"; tar -xzf "$stage/$file" -C "$stage/caddy" --no-same-owner caddy
  install -m 0755 "$stage/caddy/caddy" "$base/runtime/caddy-$caddy_version"
fi
caddy="$base/runtime/caddy-$caddy_version"
# Validate private files with the application validator, without logging values.
node --input-type=module - "$stage/app.env" "$release" <<'JS'
import {readFile} from 'node:fs/promises'; import {parseEnv} from 'node:util'; import {pathToFileURL} from 'node:url';
const env=parseEnv(await readFile(process.argv[2],'utf8'));
const {loadConfig}=await import(pathToFileURL(process.argv[3]+'/server/config.js'));
const config=await loadConfig(env);
if(!config.production||config.host!=='127.0.0.1'||config.port!==3001||env.DATA_DIR!=='/var/lib/our-kitchen') throw new Error('Invalid remote configuration');
JS
# Application origin and certificate site must match.
node --input-type=module - "$stage/app.env" "$host" <<'JS'
import {readFile} from 'node:fs/promises';import {parseEnv} from 'node:util';
const env=parseEnv(await readFile(process.argv[2],'utf8'));if(new URL(env.PUBLIC_ORIGIN).hostname.replace(/^\[|\]$/g,'')!==process.argv[3])throw new Error('Site origin mismatch');
JS
echo '[2/6] Building and testing release...'
cd "$release"
npm ci --no-audit --no-fund
npm test
npm run build
npm prune --omit=dev --no-audit --no-fund
getent passwd our-kitchen >/dev/null || useradd --system --home-dir "$data" --shell /usr/sbin/nologin our-kitchen
getent passwd our-kitchen-caddy >/dev/null || useradd --system --home-dir /var/lib/our-kitchen-caddy --shell /usr/sbin/nologin our-kitchen-caddy
install -d -o our-kitchen -g our-kitchen -m 0700 "$data"
install -d -o our-kitchen-caddy -g our-kitchen-caddy -m 0750 /var/lib/our-kitchen-caddy
install -d -m 0755 /var/lib/our-kitchen-acme
# Release code is readable by the app and contains no credentials or uploaded data.
chmod 0755 "$base" "$base/releases"
chmod -R go+rX "$release" "$base/runtime"
previous=$(readlink -f "$base/current" || true)
for file in app.env site.json Caddyfile caddy.json; do [[ ! -f "$config/$file" ]] || cp -p "$config/$file" "$stage/previous-$file"; done
for unit in our-kitchen.service our-kitchen-caddy.service our-kitchen-renew.service our-kitchen-renew.timer; do [[ ! -f "/etc/systemd/system/$unit" ]] || cp -p "/etc/systemd/system/$unit" "$stage/previous-$unit"; done
previous_timer=$(systemctl is-enabled our-kitchen-renew.timer 2>/dev/null || true)
for file in fullchain.pem privkey.pem; do [[ ! -f "/var/lib/our-kitchen-caddy/tls/$file" ]] || install -m 0600 "/var/lib/our-kitchen-caddy/tls/$file" "$stage/previous-$file"; done
switched=0
rollback() {
  code=$?; trap - ERR
  if [[ "$switched" == 1 ]]; then
    if [[ -n "$previous" ]]; then
      ln -s "$previous" "$base/rollback-$release_id"; mv -Tf "$base/rollback-$release_id" "$base/current"
      for file in app.env site.json Caddyfile caddy.json; do [[ ! -f "$stage/previous-$file" ]] || cp -p "$stage/previous-$file" "$config/$file"; done
      for unit in our-kitchen.service our-kitchen-caddy.service our-kitchen-renew.service our-kitchen-renew.timer; do [[ ! -f "$stage/previous-$unit" ]] || cp -p "$stage/previous-$unit" "/etc/systemd/system/$unit"; done
      for file in fullchain.pem privkey.pem; do [[ ! -f "$stage/previous-$file" ]] || install -o root -g our-kitchen-caddy -m 0640 "$stage/previous-$file" "/var/lib/our-kitchen-caddy/tls/$file"; done
      systemctl daemon-reload
      if [[ "$previous_timer" == enabled ]]; then systemctl enable --now our-kitchen-renew.timer || true; else systemctl disable --now our-kitchen-renew.timer 2>/dev/null || true; fi
      systemctl restart our-kitchen.service our-kitchen-caddy.service || true
      echo 'Update failed; previous code and configuration restored.'
    else
      systemctl disable --now our-kitchen.service our-kitchen-caddy.service our-kitchen-renew.timer 2>/dev/null || true
      echo 'First installation failed; data retained. Check DNS, security group and logs, then retry.'
    fi
  fi
  exit "$code"
}
trap rollback ERR
install -m 0600 "$stage/app.env" "$config/app.env"
install -m 0600 "$stage/site.json" "$config/site.json"
ln -s "$release" "$base/next-$release_id"; mv -Tf "$base/next-$release_id" "$base/current"
switched=1
# Root reads environment files; services run as dedicated unprivileged users.
cat > /etc/systemd/system/our-kitchen.service <<EOF
[Unit]
Description=Our Kitchen
After=network-online.target
[Service]
User=our-kitchen
Group=our-kitchen
WorkingDirectory=$base/current
EnvironmentFile=$config/app.env
ExecStart=$node_home/bin/node $base/current/server/index.js
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$data
UMask=0077
[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/our-kitchen-caddy.service <<EOF
[Unit]
Description=Our Kitchen HTTPS
After=network-online.target
[Service]
User=our-kitchen-caddy
Group=our-kitchen-caddy
Environment=HOME=/var/lib/our-kitchen-caddy
ExecStart=$caddy run --config $config/caddy.json
ExecReload=$caddy reload --config $config/caddy.json --force
Restart=on-failure
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/our-kitchen-caddy
UMask=0027
[Install]
WantedBy=multi-user.target
EOF
# Proxy must be able to read its non-secret configuration, but not app.env/site.json.
chmod 0755 "$config"
printf 'http://%s {\n @challenge path /.well-known/acme-challenge/*\n handle @challenge {\n root * /var/lib/our-kitchen-acme\n file_server\n }\n handle {\n respond "Our Kitchen HTTPS setup" 503\n }\n}\n' "$([[ "$host" == *:* ]] && printf '[%s]' "$host" || printf '%s' "$host")" > "$config/Caddyfile"
"$caddy" adapt --config "$config/Caddyfile" --adapter caddyfile > "$config/caddy.json"
chmod 0644 "$config/Caddyfile" "$config/caddy.json"
systemctl daemon-reload
systemctl enable --now our-kitchen.service our-kitchen-caddy.service
systemctl restart our-kitchen-caddy.service
echo '[3/6] Requesting HTTPS certificate (ensure public ports 80 and 443 are open)...'
cert_args=(--config-dir "$config/certificates" --work-dir "$base/certbot-work" --logs-dir "$base/certbot-logs")
site="$([[ "$host" == *:* ]] && printf '[%s]' "$host" || printf '%s' "$host")"
cert_name="our-kitchen-$(printf '%s' "$host" | sha256sum | cut -c1-12)"
is_ip=0
if python3 -c 'import ipaddress,sys;ipaddress.ip_address(sys.argv[1])' "$host" 2>/dev/null; then
  is_ip=1
  if [[ ! -x "$base/runtime/certbot/bin/certbot" ]]; then
    python3 -m venv "$base/runtime/certbot"
    "$base/runtime/certbot/bin/pip" install --disable-pip-version-check 'certbot==5.8.0'
  fi
  certbot="$base/runtime/certbot/bin/certbot"
  "$certbot" certonly "${cert_args[@]}" --non-interactive --agree-tos --email "$email" --webroot -w /var/lib/our-kitchen-acme --cert-name "$cert_name" --preferred-profile shortlived --ip-address "$host" --keep-until-expiring
  install -m 0755 "$release/deploy/renew.sh" "$base/renew.sh"
  "$base/renew.sh" --install-only
site="$([[ "$host" == *:* ]] && printf '[%s]' "$host" || printf '%s' "$host")"
cat > "$config/Caddyfile" <<EOF
{
 admin 127.0.0.1:2019
 auto_https off
}
http://$site {
 @challenge path /.well-known/acme-challenge/*
 handle @challenge {
  root * /var/lib/our-kitchen-acme
  file_server
 }
 handle {
  redir https://$site{uri} permanent
 }
}
https://$site {
 tls /var/lib/our-kitchen-caddy/tls/fullchain.pem /var/lib/our-kitchen-caddy/tls/privkey.pem
 request_body {
  max_size 6MB
 }
 reverse_proxy 127.0.0.1:3001 {
  header_up -X-Forwarded-For
  header_up -X-Real-IP
  header_up -Forwarded
 }
}
EOF
else
  # Domain certificates and renewals are managed by Caddy automatically.
  cat > "$config/Caddyfile" <<EOF
{
 admin 127.0.0.1:2019
 email $email
}
$host {
 request_body {
  max_size 6MB
 }
 reverse_proxy 127.0.0.1:3001 {
  header_up -X-Forwarded-For
  header_up -X-Real-IP
  header_up -Forwarded
 }
}
EOF
fi
"$caddy" adapt --config "$config/Caddyfile" --adapter caddyfile > "$config/caddy.json"
python3 "$release/deploy/ip-config.py" "$config/caddy.json" "$host"
chmod 0644 "$config/caddy.json"
"$caddy" validate --config "$config/caddy.json"
systemctl restart our-kitchen.service our-kitchen-caddy.service
if [[ "$is_ip" == 1 ]]; then
cat > /etc/systemd/system/our-kitchen-renew.service <<EOF
[Unit]
Description=Renew Our Kitchen HTTPS certificate
After=network-online.target our-kitchen-caddy.service
[Service]
Type=oneshot
ExecStart=$base/renew.sh
UMask=0077
EOF
cat > /etc/systemd/system/our-kitchen-renew.timer <<EOF
[Unit]
Description=Check Our Kitchen certificate twice a day
[Timer]
OnBootSec=15min
OnUnitActiveSec=12h
RandomizedDelaySec=30min
[Install]
WantedBy=timers.target
EOF
echo '[4/6] Verifying renewal and managed services...'
systemctl daemon-reload
systemctl enable --now our-kitchen-renew.timer
"$certbot" renew "${cert_args[@]}" --dry-run --run-deploy-hooks --deploy-hook "$base/renew.sh --install-only"
else
  echo '[4/6] Domain certificate renewal is managed by Caddy.'
  systemctl disable --now our-kitchen-renew.timer 2>/dev/null || true
fi
echo '[5/6] Checking application readiness...'
healthy=0
for attempt in {1..30}; do
 if curl --fail --silent http://127.0.0.1:3001/order/ | grep -q '/order/assets/'; then healthy=1; break; fi
 sleep 1
done
[[ "$healthy" == 1 ]]
[[ $(curl --silent -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/order/api/menu) == 401 ]]
curl --fail --silent --output /dev/null "https://$site/order/"
systemctl is-active --quiet our-kitchen.service our-kitchen-caddy.service
if [[ "$is_ip" == 1 ]]; then systemctl is-enabled --quiet our-kitchen-renew.timer; fi
trap - ERR
echo '[6/6] Our Kitchen is ready. Application data and previous releases were preserved.'
