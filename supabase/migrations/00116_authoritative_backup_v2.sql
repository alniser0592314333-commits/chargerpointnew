/*
 * Authoritative Backup V2
 *
 * Fixes backup consistency/completeness gaps in the previous backup path:
 * - captures all core business tables in ONE PostgreSQL transaction/snapshot
 * - includes qr_tokens and system_settings (previous checkpoint omitted them)
 * - returns the exact captured payload to the authenticated caller
 * - stores a content hash of the actual snapshot, not only record counts
 * - keeps the checkpoint server-side for disaster recovery
 *
 * This migration does NOT back up auth credentials, admin BINs, sessions,
 * service-role secrets, or other authentication secrets.
 */

CREATE OR REPLACE FUNCTION public.create_authoritative_backup_checkpoint_v2(
    p_entered_bin TEXT,
    p_notes TEXT DEFAULT 'MANUAL_V2'
)
RETURNS JSONB
SECURITY DEFINER
SET search_path = public, pg_temp
LANGUAGE plpgsql
AS $$
DECLARE
    v_bin_verified BOOLEAN := FALSE;
    v_chk_id UUID := gen_random_uuid();
    v_seq BIGINT;
    v_snapshot JSONB;
    v_manifest JSONB;
    v_integrity_hash TEXT;
    v_max_seq BIGINT;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required for authoritative backup';
    END IF;

    SELECT public.verify_admin_bin(p_entered_bin) INTO v_bin_verified;
    IF v_bin_verified IS NOT TRUE THEN
        RAISE EXCEPTION 'Security Authorization Failed: Invalid BIN';
    END IF;

    SELECT COALESCE(MAX(sequence_id), 0)
      INTO v_max_seq
      FROM public.change_log;

    /*
     * Every SELECT is executed in this single function transaction, so the
     * returned collections represent one database-consistent point in time.
     */
    v_snapshot := jsonb_build_object(
        'systemSettings', COALESCE((SELECT jsonb_agg(row_to_json(s) ORDER BY s.key) FROM public.system_settings s), '[]'::jsonb),
        'customers', COALESCE((SELECT jsonb_agg(row_to_json(c) ORDER BY c.id) FROM public.customers c), '[]'::jsonb),
        'deviceTypes', COALESCE((SELECT jsonb_agg(row_to_json(d) ORDER BY d.id) FROM public.device_types d), '[]'::jsonb),
        'businessDays', COALESCE((SELECT jsonb_agg(row_to_json(b) ORDER BY b.id) FROM public.business_days b), '[]'::jsonb),
        'qrTokens', COALESCE((SELECT jsonb_agg(row_to_json(q) ORDER BY q.id) FROM public.qr_tokens q), '[]'::jsonb),
        'orders', COALESCE((SELECT jsonb_agg(row_to_json(o) ORDER BY o.id) FROM public.orders o), '[]'::jsonb),
        'orderItems', COALESCE((SELECT jsonb_agg(row_to_json(oi) ORDER BY oi.id) FROM public.order_items oi), '[]'::jsonb),
        'payments', COALESCE((SELECT jsonb_agg(row_to_json(p) ORDER BY p.id) FROM public.payments p), '[]'::jsonb),
        'paymentAllocations', COALESCE((SELECT jsonb_agg(row_to_json(pa) ORDER BY pa.id) FROM public.payment_allocations pa), '[]'::jsonb),
        'financialLedger', COALESCE((SELECT jsonb_agg(row_to_json(fl) ORDER BY fl.id) FROM public.financial_ledger fl), '[]'::jsonb),
        'goals', COALESCE((SELECT jsonb_agg(row_to_json(g) ORDER BY g.id) FROM public.goals g), '[]'::jsonb),
        'goalRequests', COALESCE((SELECT jsonb_agg(row_to_json(gr) ORDER BY gr.id) FROM public.goal_requests gr), '[]'::jsonb)
    );

    v_integrity_hash := md5(v_snapshot::text);

    v_manifest := jsonb_build_object(
        'checkpointId', v_chk_id,
        'schemaVersion', 2,
        'formatVersion', '2.0',
        'authoritativeMaxSequence', v_max_seq,
        'createdAt', NOW(),
        'integrityHashAlgorithm', 'MD5(JSONB canonical text)',
        'integrityHash', v_integrity_hash,
        'counts', jsonb_build_object(
            'systemSettings', jsonb_array_length(v_snapshot->'systemSettings'),
            'customers', jsonb_array_length(v_snapshot->'customers'),
            'deviceTypes', jsonb_array_length(v_snapshot->'deviceTypes'),
            'businessDays', jsonb_array_length(v_snapshot->'businessDays'),
            'qrTokens', jsonb_array_length(v_snapshot->'qrTokens'),
            'orders', jsonb_array_length(v_snapshot->'orders'),
            'orderItems', jsonb_array_length(v_snapshot->'orderItems'),
            'payments', jsonb_array_length(v_snapshot->'payments'),
            'paymentAllocations', jsonb_array_length(v_snapshot->'paymentAllocations'),
            'financialLedger', jsonb_array_length(v_snapshot->'financialLedger'),
            'goals', jsonb_array_length(v_snapshot->'goals'),
            'goalRequests', jsonb_array_length(v_snapshot->'goalRequests')
        ),
        'financialIntegrity', jsonb_build_object(
            'totalLedgerSumMinor', COALESCE((SELECT SUM(amount_minor) FROM public.financial_ledger), 0)
        )
    );

    INSERT INTO public.backup_checkpoints (
        checkpoint_id, checkpoint_type, manifest, integrity_hash, snapshot_data, created_at
    )
    VALUES (
        v_chk_id, COALESCE(p_notes, 'MANUAL_V2'), v_manifest, v_integrity_hash, v_snapshot, NOW()
    )
    RETURNING checkpoint_sequence INTO v_seq;

    RETURN jsonb_build_object(
        'success', TRUE,
        'checkpointId', v_chk_id,
        'checkpointSequence', v_seq,
        'integrityHash', v_integrity_hash,
        'manifest', v_manifest,
        'snapshotData', v_snapshot
    );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.create_authoritative_backup_checkpoint_v2(TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.create_authoritative_backup_checkpoint_v2(TEXT, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_authoritative_backup_checkpoint_v2(TEXT, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';
