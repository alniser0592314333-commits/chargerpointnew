#!/usr/bin/env bash
set -euo pipefail
export PGPASSWORD="${PGPASSWORD:-postgres}"
PGHOST="${PGHOST:-localhost}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-change_log_order_test}"
psql_cmd=(psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 -q)

# A holds the canonical write lock while its change remains invisible.
("${psql_cmd[@]}" <<'SQL'
BEGIN;
INSERT INTO public.orders(id, name) VALUES ('00000000-0000-0000-0000-000000000001', 'A');
SELECT pg_sleep(3);
COMMIT;
SQL
) >/tmp/change-log-writer-a.log 2>&1 &
pid_a=$!

# Wait until A is inside its deliberate sleep, proving it already holds the lock.
writer_a_active=0
for _ in $(seq 1 30); do
  writer_a_active=$("${psql_cmd[@]}" -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='active' AND query LIKE '%pg_sleep(3)%'")
  if [[ "$writer_a_active" -ge 1 ]]; then break; fi
  sleep 0.1
done
if [[ "$writer_a_active" -lt 1 ]]; then
  cat /tmp/change-log-writer-a.log || true
  echo "Writer A did not reach its lock-holding sleep" >&2
  kill "$pid_a" 2>/dev/null || true
  exit 1
fi
("${psql_cmd[@]}" <<'SQL'
BEGIN;
INSERT INTO public.orders(id, name) VALUES ('00000000-0000-0000-0000-000000000002', 'B');
COMMIT;
SQL
) >/tmp/change-log-writer-b.log 2>&1 &
pid_b=$!

# Confirm B is actually waiting on a PostgreSQL lock, rather than merely not scheduled.
waiting=0
for _ in $(seq 1 30); do
  waiting=$("${psql_cmd[@]}" -Atc "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%INSERT INTO public.orders%'")
  if [[ "$waiting" -ge 1 ]]; then break; fi
  sleep 0.1
done
if [[ "$waiting" -lt 1 ]]; then
  cat /tmp/change-log-writer-a.log /tmp/change-log-writer-b.log || true
  echo "Writer B did not wait on the transaction-scoped change-log lock" >&2
  kill "$pid_a" "$pid_b" 2>/dev/null || true
  exit 1
fi

visible=$("${psql_cmd[@]}" -Atc "SELECT count(*) FROM public.change_log")
if [[ "$visible" -ne 0 ]]; then
  echo "A later writer became visible while the earlier sequence transaction was uncommitted" >&2
  kill "$pid_a" "$pid_b" 2>/dev/null || true
  exit 1
fi

wait "$pid_a"
wait "$pid_b"

ordered=$("${psql_cmd[@]}" -Atc "SELECT min(sequence_id) FILTER (WHERE payload->>'name'='A') < min(sequence_id) FILTER (WHERE payload->>'name'='B') FROM public.change_log")
if [[ "$ordered" != "t" ]]; then
  echo "Change-log sequence order did not follow serialized transaction order" >&2
  exit 1
fi

feed_generation=$("${psql_cmd[@]}" -Atc "SELECT public.pull_canonical_changes(0, 500)->>'serverResetGeneration'")
feed_count=$("${psql_cmd[@]}" -Atc "SELECT jsonb_array_length(public.pull_canonical_changes(0, 500)->'changes')")
if [[ "$feed_generation" != "1" || "$feed_count" != "2" ]]; then
  echo "Combined delta RPC did not return generation and committed changes" >&2
  exit 1
fi

# The first-device bootstrap snapshot must include both canonical rows and a
# matching generation/high-water fence in the same returned JSON object.
bootstrap_contract=$("${psql_cmd[@]}" -Atc "SELECT (s.snapshot->>'server_reset_generation') || '|' || (s.snapshot->>'max_change_sequence') || '|' || jsonb_array_length(s.snapshot->'orders') FROM (SELECT public.capture_sync_bootstrap_snapshot() AS snapshot) s")
if [[ "$bootstrap_contract" != "1|2|2" ]]; then
  echo "Atomic bootstrap snapshot contract failed: $bootstrap_contract" >&2
  exit 1
fi

psql_check=$("${psql_cmd[@]}" -Atc "SELECT
  has_function_privilege('authenticated', 'public.execute_canonical_sync_command(uuid,text,jsonb,text,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.execute_canonical_sync_command_unlocked(uuid,text,jsonb,text,text,uuid)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.execute_canonical_sync_command_unlocked(uuid,text,jsonb,text,text,uuid)', 'EXECUTE')
  AND has_function_privilege('service_role', 'public.execute_sync_command_impl(uuid,text,text,uuid,jsonb,integer)', 'EXECUTE')
  AND NOT has_function_privilege('service_role', 'public.execute_sync_command_impl_unlocked(uuid,text,text,uuid,jsonb,integer)', 'EXECUTE')")
if [[ "$psql_check" != "t" ]]; then
  echo "RPC entry-point lock wrappers or internal implementation privileges are incorrect" >&2
  exit 1
fi

echo "PASS: commit ordering, RPC lock entry points, delta RPC, and atomic bootstrap snapshot checkpoint are valid."
