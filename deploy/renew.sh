#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
base=/opt/our-kitchen
config=/etc/our-kitchen
exec 9>"$base/certificate.lock"
flock -n 9 || exit 0
install_certificate() {
  cert_name=$(python3 - "$config/site.json" <<'PY'
import json,hashlib,sys
site=json.load(open(sys.argv[1]));print('our-kitchen-'+hashlib.sha256(site['host'].encode()).hexdigest()[:12])
PY
  )
  install -d -o root -g our-kitchen-caddy -m 0750 /var/lib/our-kitchen-caddy/tls
  install -o root -g our-kitchen-caddy -m 0640 "$config/certificates/live/$cert_name/fullchain.pem" /var/lib/our-kitchen-caddy/tls/fullchain.pem
  install -o root -g our-kitchen-caddy -m 0640 "$config/certificates/live/$cert_name/privkey.pem" /var/lib/our-kitchen-caddy/tls/privkey.pem
}
if [[ ${1:-} == --install-only ]]; then
  install_certificate
  if systemctl is-active --quiet our-kitchen-caddy.service; then systemctl reload our-kitchen-caddy.service; fi
else
  # The hook uses a separate invocation; release the lock before running Certbot.
  flock -u 9
  "$base/runtime/certbot/bin/certbot" renew --quiet --config-dir "$config/certificates" --work-dir "$base/certbot-work" --logs-dir "$base/certbot-logs" --deploy-hook "$base/renew.sh --install-only"
fi
