"""Select the IP certificate for clients that omit an IP literal in TLS SNI."""
import ipaddress
import json
from pathlib import Path
import sys
file = Path(sys.argv[1])
try:
    host = str(ipaddress.ip_address(sys.argv[2]))
except ValueError:
    sys.exit(0)
configuration = json.loads(file.read_text())
for server in configuration['apps']['http']['servers'].values():
    policies = server.get('tls_connection_policies')
    if policies:
        policy = policies[0]
        policy.pop('match', None)
        policy['default_sni'] = host
        server['tls_connection_policies'] = [policy]
file.write_text(json.dumps(configuration, indent=2) + '\n')
