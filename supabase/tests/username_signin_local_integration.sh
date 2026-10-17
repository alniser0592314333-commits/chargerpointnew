#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKDIR="${RUNNER_TEMP:-/tmp}/chargerpointnew-username-signin-integration"
mkdir -p "$WORKDIR/supabase/migrations" "$WORKDIR/supabase/functions/sign-in-by-username"

cleanup() {
  (cd "$WORKDIR" && supabase stop --no-backup >/dev/null 2>&1) || true
}
trap cleanup EXIT

cp "$ROOT/supabase/migrations/20261017300000_username_signin_rate_limit.sql" "$WORKDIR/supabase/migrations/"
cp "$ROOT/supabase/functions/sign-in-by-username/index.ts" "$WORKDIR/supabase/functions/sign-in-by-username/"
cp "$ROOT/supabase/functions/sign-in-by-username/handler.ts" "$WORKDIR/supabase/functions/sign-in-by-username/"
cp "$ROOT/supabase/functions/sign-in-by-username/requestValidation.ts" "$WORKDIR/supabase/functions/sign-in-by-username/"

cat > "$WORKDIR/supabase/config.toml" <<'TOML'
project_id = "chargerpointnew_username_auth_test"

[api]
enabled = true
port = 54321
schemas = ["public", "graphql_public"]
extra_search_path = ["public", "extensions"]
max_rows = 1000

[db]
port = 54322
major_version = 17

[auth]
enabled = true
site_url = "http://127.0.0.1:3000"
additional_redirect_urls = ["http://127.0.0.1:3000"]
jwt_expiry = 3600
security_sb_forwarded_for_enabled = true

[auth.email]
enable_signup = true
double_confirm_changes = true
enable_confirmations = false

[functions.sign-in-by-username]
verify_jwt = false
TOML

cat > "$WORKDIR/supabase/migrations/20261017299999_create_test_admins.sql" <<'SQL'
CREATE TABLE public.admins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL UNIQUE,
  username text NOT NULL,
  email text NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);
ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;
SQL

cd "$WORKDIR"
supabase start
supabase db reset --yes

STATUS_ENV="$(supabase status -o env)"
value_from_status() {
  printf '%s\n' "$STATUS_ENV" | sed -n "s/^$1=//p" | head -n 1 | tr -d '"'
}
API_URL="$(value_from_status API_URL)"
DB_URL="$(value_from_status DB_URL)"
ANON_KEY="$(value_from_status ANON_KEY)"
if [[ -z "$ANON_KEY" ]]; then ANON_KEY="$(value_from_status PUBLISHABLE_KEY)"; fi
SECRET_KEY="$(supabase status 2>/dev/null | grep -oE 'sb_secret_[A-Za-z0-9_-]+' | head -n 1 || true)"

if [[ -z "$API_URL" || -z "$DB_URL" || -z "$ANON_KEY" || -z "$SECRET_KEY" ]]; then
  echo "Could not obtain local Supabase API/database/modern key values."
  supabase status || true
  exit 1
fi

cat > "$WORKDIR/supabase/functions/.env" <<ENV
AUTH_SUPABASE_SECRET_KEY=$SECRET_KEY
USERNAME_SIGNIN_RATE_LIMIT_SECRET=$(openssl rand -hex 32)
AUTH_IP_FORWARDING_ENABLED=true
ENV

curl -fsS -X POST "$API_URL/auth/v1/signup" \
  -H "apikey: $ANON_KEY" \
  -H "Content-Type: application/json" \
  --data '{"email":"integration-admin@example.test","password":"Integration!Pass12345"}' \
  > "$WORKDIR/signup.json"
USER_ID="$(jq -r '.id // .user.id // empty' "$WORKDIR/signup.json")"
if [[ -z "$USER_ID" ]]; then
  echo "Local Auth signup did not return a user ID."
  cat "$WORKDIR/signup.json"
  exit 1
fi

psql "$DB_URL" -v ON_ERROR_STOP=1 -c \
  "INSERT INTO public.admins (auth_user_id, username, email, is_active) VALUES ('$USER_ID', 'integration-admin', 'integration-admin@example.test', true);"

supabase functions serve sign-in-by-username --no-verify-jwt --env-file "$WORKDIR/supabase/functions/.env" > "$WORKDIR/function.log" 2>&1 &
FUNCTION_PID=$!
for _ in $(seq 1 60); do
  CODE="$(curl -sS -o /dev/null -w '%{http_code}' -H "apikey: $ANON_KEY" "$API_URL/functions/v1/sign-in-by-username" || true)"
  if [[ "$CODE" == "405" ]]; then break; fi
  if ! kill -0 "$FUNCTION_PID" 2>/dev/null; then
    echo "Local Edge Function process exited before becoming ready."
    cat "$WORKDIR/function.log"
    exit 1
  fi
  sleep 2
done
if [[ "${CODE:-}" != "405" ]]; then
  echo "Local Edge Function did not become ready (last HTTP status: ${CODE:-none})."
  cat "$WORKDIR/function.log"
  exit 1
fi

post_signin() {
  local username="$1"
  local password="$2"
  local outfile="$3"
  curl -sS -o "$outfile" -w '%{http_code}' -X POST "$API_URL/functions/v1/sign-in-by-username" \
    -H "apikey: $ANON_KEY" \
    -H "Content-Type: application/json" \
    -H "cf-connecting-ip: 203.0.113.8" \
    -H "x-forwarded-for: 198.51.100.99" \
    --data "$(jq -cn --arg username "$username" --arg password "$password" '{username:$username,password:$password}')"
}

CODE="$(post_signin integration-admin 'Integration!Pass12345' "$WORKDIR/success.json")"
if [[ "$CODE" != "200" ]] || [[ "$(jq -r '.session.access_token // empty' "$WORKDIR/success.json")" == "" ]]; then
  echo "Real local Supabase Auth username login failed (HTTP $CODE)."
  cat "$WORKDIR/success.json"
  cat "$WORKDIR/function.log"
  exit 1
fi

CODE="$(post_signin integration-admin 'wrong-password' "$WORKDIR/wrong-password.json")"
if [[ "$CODE" != "401" ]] || [[ "$(jq -r '.error // empty' "$WORKDIR/wrong-password.json")" != "Invalid login credentials" ]]; then
  echo "Wrong-password response contract failed (HTTP $CODE)."
  cat "$WORKDIR/wrong-password.json"
  exit 1
fi

CODE="$(post_signin missing-user 'wrong-password' "$WORKDIR/unknown-user.json")"
if [[ "$CODE" != "401" ]] || [[ "$(jq -r '.error // empty' "$WORKDIR/unknown-user.json")" != "Invalid login credentials" ]]; then
  echo "Unknown-user response contract failed (HTTP $CODE)."
  cat "$WORKDIR/unknown-user.json"
  exit 1
fi
if grep -q 'integration-admin@example.test' "$WORKDIR/wrong-password.json" "$WORKDIR/unknown-user.json"; then
  echo "Credential failure response disclosed the account email."
  exit 1
fi

# The successful attempt and one bad-password attempt already consumed two pair
# attempts. Three more remain generic failures; the sixth attempt must be blocked
# by the actual database-backed limiter before Auth is called.
for expected in 401 401 401 429; do
  CODE="$(post_signin integration-admin 'wrong-password' "$WORKDIR/rate-limit.json")"
  if [[ "$CODE" != "$expected" ]]; then
    echo "Expected rate-limit HTTP $expected but received $CODE."
    cat "$WORKDIR/rate-limit.json"
    cat "$WORKDIR/function.log"
    exit 1
  fi
done

echo "Local Supabase integration passed: Auth success, generic failures, email non-disclosure, and DB-backed rate limiting."
