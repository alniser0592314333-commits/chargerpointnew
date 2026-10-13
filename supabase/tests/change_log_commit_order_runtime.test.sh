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

# Wait until A's transaction has started and holds the statement-level lock.
sleep 0.5
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

echo "PASS: a later change cannot become visible before an earlier allocated change."
