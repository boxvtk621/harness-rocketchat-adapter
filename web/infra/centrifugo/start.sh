#!/bin/sh
# Docker config mounts require POSIX line endings.
set -eu
client_secret="$(cat /run/secrets/centrifugo_client_secret)"
api_key="$(cat /run/secrets/centrifugo_api_key)"
cat > /tmp/config.json <<EOF
{
  "token_hmac_secret_key": "$client_secret",
  "api_key": "$api_key",
  "allowed_origins": ["${WEB_ORIGIN:-http://localhost:18100}"],
  "allow_subscribe_for_client": true,
  "health": true,
  "log_level": "info"
}
EOF
exec centrifugo -c /tmp/config.json
