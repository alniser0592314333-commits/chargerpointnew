import fs from 'fs';
let def = fs.readFileSync('supabase/temp_fn_def.sql', 'utf8');

// 1. Fix ADD_ORDER_ITEM hardcoded 500
def = def.replace(
  "v_authoritative_charger_fee := COALESCE((p_payload->>'chargerFeeSnapshotMinor')::BIGINT, (p_payload->>'charger_fee_snapshot_minor')::BIGINT, 500);",
  "v_authoritative_charger_fee := COALESCE((p_payload->>'chargerFeeSnapshotMinor')::BIGINT, (p_payload->>'charger_fee_snapshot_minor')::BIGINT, (SELECT COALESCE(value_number, 50) FROM public.system_settings WHERE key = 'default_charger_fee_minor'));"
);

// 2. Fix DELIVER_ORDER_ITEM to use snapshots and immutable recognition
const deliverStartMatch = def.match(/WHEN 'DELIVER_ORDER_ITEM' THEN/);
if (deliverStartMatch) {
    const deliverStart = deliverStartMatch.index;
    const deliverEnd = def.indexOf("WHEN 'CANCEL_ORDER_ITEM'", deliverStart);
    
    const newDeliverBlock = `WHEN 'DELIVER_ORDER_ITEM' THEN
            v_item_uuid := (COALESCE(p_payload->>'itemId', p_payload->>'orderItemId', p_payload->>'id'))::UUID;
            
            SELECT oi.*, o.customer_id, c.status AS cust_status, c.debt_limit_minor, c.charger_fee_exempt
            INTO v_rec_item
            FROM public.order_items oi
            JOIN public.orders o ON oi.order_id = o.id
            JOIN public.customers c ON o.customer_id = c.id
            WHERE oi.id = v_item_uuid;

            IF v_rec_item.id IS NULL THEN
                RAISE EXCEPTION 'Order Item Not Found: ID %', v_item_uuid USING ERRCODE = '23503';
            END IF;

            IF v_rec_item.cust_status = 'DELETED' THEN
                RAISE EXCEPTION 'Customer is soft-deleted/frozen. Cannot deliver item';
            END IF;

            IF v_rec_item.financial_status = 'RECOGNIZED' THEN
                v_result := jsonb_build_object('orderItemId', v_item_uuid, 'status', 'DELIVERED', 'alreadyRecognized', TRUE);
            ELSE
                -- Authoritative Immutability: Use EXISTING snapshots for recognition
                v_authoritative_final_charge := v_rec_item.final_charge_snapshot_minor;
                
                v_current_balance := public.calculate_customer_authoritative_balance(v_rec_item.customer_id);
                v_projected_balance := v_current_balance - v_authoritative_final_charge;

                IF v_rec_item.debt_limit_minor > 0 AND v_projected_balance < (-v_rec_item.debt_limit_minor) THEN
                    RAISE EXCEPTION 'Debt Limit Exceeded: Customer debt limit % exceeded by projected balance %',
                        v_rec_item.debt_limit_minor, v_projected_balance;                END IF;

                UPDATE public.order_items
                SET operational_status = 'DELIVERED',
                    financial_status = 'RECOGNIZED',
                    status = 'delivered',
                    delivered_at = NOW(),
                    financially_recognized_at = NOW(),
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_item_uuid;

                INSERT INTO public.financial_ledger (
                    event_type, amount_minor, order_id, order_item_id, customer_id, actor_admin_id, metadata, created_at
                )
                VALUES (
                    'ORDER_ITEM_CHARGE',
                    -v_authoritative_final_charge,
                    v_rec_item.order_id,
                    v_item_uuid,
                    v_rec_item.customer_id,
                    v_actor_id,
                    jsonb_build_object(
                        'itemSequence', v_rec_item.item_sequence,
                        'basePrice', v_rec_item.base_price_snapshot_minor,
                        'chargerFee', v_rec_item.charger_fee_snapshot_minor,
                        'discount', v_rec_item.discount_snapshot_minor,
                        'deliveredAt', NOW()
                    ),
                    NOW()
                )
                RETURNING id INTO v_entity_uuid;

                -- Update the order status if all items are delivered
                IF NOT EXISTS (
                    SELECT 1 FROM public.order_items 
                    WHERE order_id = v_rec_item.order_id 
                      AND status NOT IN ('delivered', 'cancelled')
                ) THEN
                    UPDATE public.orders SET status = 'delivered', updated_at = NOW(), version = version + 1
                    WHERE id = v_rec_item.order_id;
                END IF;

                PERFORM public.record_canonical_change('order_items', v_item_uuid, 'UPDATE', jsonb_build_object(
                    'financial_status', 'RECOGNIZED',
                    'operational_status', 'DELIVERED',
                    'base_price_snapshot_minor', v_rec_item.base_price_snapshot_minor,
                    'charger_fee_snapshot_minor', v_rec_item.charger_fee_snapshot_minor,
                    'final_charge_snapshot_minor', v_authoritative_final_charge
                ), 1);

                PERFORM public.record_canonical_change('financial_ledger', v_entity_uuid, 'INSERT', jsonb_build_object(
                    'event_type', 'ORDER_ITEM_CHARGE',
                    'amount_minor', v_authoritative_final_charge,
                    'order_item_id', v_item_uuid
                ), 1);

                v_result := jsonb_build_object(
                    'status', 'DELIVERED',
                    'orderItemId', v_item_uuid,
                    'ledgerEntryId', v_entity_uuid,
                    'financialStatus', 'RECOGNIZED',
                    'finalChargeMinor', v_authoritative_final_charge
                );
            END IF;
        `;
    def = def.substring(0, deliverStart) + newDeliverBlock + def.substring(deliverEnd);
}

// 3. Unify event types: Replace all remaining 'CHARGE' with 'ORDER_ITEM_CHARGE'
def = def.replace(/'CHARGE'/g, "'ORDER_ITEM_CHARGE'");

fs.writeFileSync('supabase/updated_command_fn.sql', def);
