#!/usr/bin/env bash
set -euo pipefail

DB_ARGS=(-h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -Atq)
ACTOR="10000000-0000-4000-8000-000000000001"
SESSION="20000000-0000-4000-8000-000000000001"

# Avoid running across a UTC hourly boundary, which would legitimately split
# concurrent requests between two independent windows.
while true; do
  minute="$(psql "${DB_ARGS[@]}" -c "SELECT extract(minute FROM clock_timestamp())::integer;")"
  if [[ "${minute}" -ge 2 && "${minute}" -le 57 ]]; then
    break
  fi
  sleep 2
done

run_bucket() {
  local period="$1"
  local quota_type="$2"
  local tmp
  local -a pids=()
  tmp="$(mktemp -d)"

  psql "${DB_ARGS[@]}" -c "DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='${ACTOR}' AND quota_type='${quota_type}';" >/dev/null

  for i in $(seq 1 40); do
    psql "${DB_ARGS[@]}" -c "SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; SET request.jwt.claim.sub='${ACTOR}'; SET request.jwt.claim.session_id='${SESSION}'; SELECT (public.sarah_ai_consume_my_quota('${period}')->>'allowed');" > "${tmp}/${i}.out" &
    pids+=("$!")
  done

  for pid in "${pids[@]}"; do
    wait "$pid"
  done

  local allowed denied count
  allowed="$(grep -hE '^(true|false)$' "${tmp}"/*.out | grep -c '^true$' || true)"
  denied="$(grep -hE '^(true|false)$' "${tmp}"/*.out | grep -c '^false$' || true)"
  allowed="${allowed:-0}"
  denied="${denied:-0}"
  count="$(psql "${DB_ARGS[@]}" -c "SELECT request_count FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='${ACTOR}' AND quota_type='${quota_type}' AND window_seconds=3600 ORDER BY window_started_at DESC LIMIT 1;")"

  rm -rf "${tmp}"

  if [[ "${allowed}" -ne 20 || "${denied}" -ne 20 || "${count}" -ne 40 ]]; then
    echo "Concurrent ${period} quota failed: allowed=${allowed}, denied=${denied}, count=${count}"
    exit 1
  fi
  echo "Concurrent ${period} quota passed: exactly 20/40 allowed."
}

run_bucket "hour" "chat"
run_bucket "tool_hour" "tool"
psql "${DB_ARGS[@]}" -c "DELETE FROM public.sarah_ai_usage_windows WHERE actor_auth_user_id='${ACTOR}' AND quota_type IN ('chat','tool');" >/dev/null
