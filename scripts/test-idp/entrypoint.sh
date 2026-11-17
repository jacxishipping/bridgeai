#!/bin/sh
# Render requires binding $PORT (default 10000); Dex's config has a static
# port, so render the template at startup. The client secret and the test
# user's bcrypt hash come from the service environment (never committed).
# The issuer URL is unaffected (Render routes :443 to $PORT).
set -e
PORT="${PORT:-5556}"
if [ -z "$DEX_CLIENT_SECRET" ] || [ -z "$DEX_TEST_PASSWORD_HASH" ]; then
  echo "FATAL: DEX_CLIENT_SECRET and DEX_TEST_PASSWORD_HASH must be set" >&2
  exit 1
fi
# Escape sed-replacement metacharacters (&, \ and the | delimiter) in
# the secret values: a secret containing them would otherwise corrupt
# the rendered config (6B audit). The | delimiter keeps / safe (bcrypt
# hashes contain it).
esc_secret=$(printf '%s' "$DEX_CLIENT_SECRET" | sed 's/[&\\|]/\\&/g')
esc_hash=$(printf '%s' "$DEX_TEST_PASSWORD_HASH" | sed 's/[&\\|]/\\&/g')
sed -e "s|__DEX_PORT__|${PORT}|g" \
    -e "s|__CLIENT_SECRET__|${esc_secret}|g" \
    -e "s|__PASSWORD_HASH__|${esc_hash}|g" \
    /etc/dex/config.yaml > /tmp/dex-config.yaml
exec dex serve /tmp/dex-config.yaml
