#!/bin/sh
set -eu
export KC_BOOTSTRAP_ADMIN_PASSWORD="$(cat /run/secrets/keycloak_admin_password)"
export DEV_USER_PASSWORD="$(cat /run/secrets/keycloak_dev_user_password)"
exec /opt/keycloak/bin/kc.sh "$@"
