-- Runtime contract test for checkpointed authoritative change-log paging.
-- Runs only against the isolated PostgreSQL service in GitHub Actions.
SET request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001';

DO $verify$
DECLARE
  v_first jsonb;
  v_second jsonb;
  v_final jsonb;
  v_ids bigint[];
BEGIN
  v_first := public.capture_authoritative_change_log_page(0, 5, 2);
  IF jsonb_array_length(v_first->'rows') <> 2 THEN
    RAISE EXCEPTION 'First page must contain 2 rows: %', v_first;
  END IF;
  IF (v_first->>'next_after_sequence_id')::bigint <> 2 THEN
    RAISE EXCEPTION 'First page cursor must advance to sequence 2: %', v_first;
  END IF;
  IF (v_first->>'current_count_through_sequence')::bigint <> 5 THEN
    RAISE EXCEPTION 'First page must report all 5 checkpoint rows: %', v_first;
  END IF;

  v_second := public.capture_authoritative_change_log_page(
    (v_first->>'next_after_sequence_id')::bigint, 5, 2
  );
  IF jsonb_array_length(v_second->'rows') <> 2
     OR (v_second->>'next_after_sequence_id')::bigint <> 4 THEN
    RAISE EXCEPTION 'Second page did not advance correctly: %', v_second;
  END IF;

  v_final := public.capture_authoritative_change_log_page(
    (v_second->>'next_after_sequence_id')::bigint, 5, 2
  );
  IF jsonb_array_length(v_final->'rows') <> 1
     OR (v_final->>'next_after_sequence_id')::bigint <> 5 THEN
    RAISE EXCEPTION 'Final page must contain the last row: %', v_final;
  END IF;

  SELECT array_agg((entry->>'sequence_id')::bigint ORDER BY (entry->>'sequence_id')::bigint)
    INTO v_ids
  FROM (
    SELECT jsonb_array_elements(v_first->'rows') AS entry
    UNION ALL SELECT jsonb_array_elements(v_second->'rows')
    UNION ALL SELECT jsonb_array_elements(v_final->'rows')
  ) all_rows;

  IF v_ids IS DISTINCT FROM ARRAY[1,2,3,4,5]::bigint[] THEN
    RAISE EXCEPTION 'Paged history must preserve every row in sequence order: %', v_ids;
  END IF;

  IF (v_final->>'server_reset_generation')::bigint <> 0 THEN
    RAISE EXCEPTION 'Reset generation should match fixture checkpoint: %', v_final;
  END IF;

  -- An empty final checkpoint page still returns the authoritative count and
  -- generation so the client can detect history changes after paging.
  v_final := public.capture_authoritative_change_log_page(5, 5, 1);
  IF jsonb_array_length(v_final->'rows') <> 0
     OR (v_final->>'current_count_through_sequence')::bigint <> 5 THEN
    RAISE EXCEPTION 'Final checkpoint validation failed: %', v_final;
  END IF;
END
$verify$;
