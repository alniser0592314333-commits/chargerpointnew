import fs from 'fs';

const sqlPath = 'temp_fn_def.sql';
let sql = fs.readFileSync(sqlPath, 'utf8');

// 1. Add variable declarations
const declIdx = sql.indexOf('DECLARE');
const goalVars = `
    v_active_goal RECORD;
    v_goal_bonus_ledger_id UUID;
    v_goal_uuid UUID;
    v_req_uuid UUID;
`;
sql = sql.slice(0, declIdx + 7) + goalVars + sql.slice(declIdx + 7);

// 2. In DELIVER_ORDER_ITEM, after financial recognition, advance active goal progress
const targetInDeliver = "v_result := jsonb_build_object(\n                    'orderItemId', v_item_uuid,";
const goalProgressCode = `
                -- 9. Authoritative Goal Progress Integration
                SELECT * INTO v_active_goal
                FROM public.goals
                WHERE customer_id = v_rec_item.customer_id
                  AND status = 'ACTIVE'
                  AND expires_at > NOW()
                FOR UPDATE;

                IF v_active_goal.id IS NOT NULL THEN
                    v_active_goal.current_progress := v_active_goal.current_progress + 1;
                    IF v_active_goal.current_progress >= v_active_goal.target_quantity THEN
                        -- Goal Completed!
                        IF v_active_goal.bonus_amount_minor > 0 THEN
                            INSERT INTO public.financial_ledger (
                                id, customer_id, event_type, amount_minor, metadata, created_at
                            )
                            VALUES (
                                gen_random_uuid(),
                                v_rec_item.customer_id,
                                'BONUS',
                                v_active_goal.bonus_amount_minor,
                                jsonb_build_object('goalId', v_active_goal.id, 'type', 'GOAL_COMPLETION_BONUS'),
                                NOW()
                            )
                            RETURNING id INTO v_goal_bonus_ledger_id;

                            PERFORM public.record_canonical_change('financial_ledger', v_goal_bonus_ledger_id, 'INSERT', jsonb_build_object(
                                'event_type', 'BONUS',
                                'amount_minor', v_active_goal.bonus_amount_minor,
                                'customer_id', v_rec_item.customer_id
                            ), 1);
                        END IF;

                        UPDATE public.goals
                        SET current_progress = v_active_goal.current_progress,
                            status = 'COMPLETED',
                            completed_at = NOW(),
                            bonus_ledger_id = v_goal_bonus_ledger_id,
                            updated_at = NOW(),
                            version = version + 1
                        WHERE id = v_active_goal.id;

                        PERFORM public.record_canonical_change('goals', v_active_goal.id, 'UPDATE', jsonb_build_object(
                            'id', v_active_goal.id,
                            'current_progress', v_active_goal.current_progress,
                            'status', 'COMPLETED',
                            'completed_at', NOW(),
                            'bonus_ledger_id', v_goal_bonus_ledger_id
                        ), v_active_goal.version + 1);
                    ELSE
                        UPDATE public.goals
                        SET current_progress = v_active_goal.current_progress,
                            updated_at = NOW(),
                            version = version + 1
                        WHERE id = v_active_goal.id;

                        PERFORM public.record_canonical_change('goals', v_active_goal.id, 'UPDATE', jsonb_build_object(
                            'id', v_active_goal.id,
                            'current_progress', v_active_goal.current_progress
                        ), v_active_goal.version + 1);
                    END IF;
                END IF;

                `;

sql = sql.replace(targetInDeliver, goalProgressCode + targetInDeliver);

// 3. Add Goal command cases
const goalCommands = `
        -- ----------------------------------------------------
        -- I. GOAL COMMANDS
        -- ----------------------------------------------------
        WHEN 'CREATE_GOAL' THEN
            v_goal_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (p_payload->>'customerId')::UUID;

            IF EXISTS (SELECT 1 FROM public.goals WHERE customer_id = v_customer_uuid AND status = 'ACTIVE') THEN
                RAISE EXCEPTION 'Customer already has an active goal. Only one active goal allowed.' USING ERRCODE = '23505';
            END IF;

            INSERT INTO public.goals (
                id, customer_id, target_quantity, current_progress, bonus_amount_minor, duration_days,
                status, started_at, expires_at, version, created_at, updated_at
            )
            VALUES (
                v_goal_uuid,
                v_customer_uuid,
                (p_payload->>'targetQuantity')::INT,
                0,
                COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, 0),
                COALESCE((p_payload->>'durationDays')::INT, 7),
                'ACTIVE',
                NOW(),
                NOW() + (COALESCE((p_payload->>'durationDays')::INT, 7) || ' days')::INTERVAL,
                1,
                NOW(),
                NOW()
            );

            PERFORM public.record_canonical_change('goals', v_goal_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('goalId', v_goal_uuid, 'status', 'ACTIVE');

        WHEN 'EDIT_GOAL' THEN
            v_goal_uuid := (p_payload->>'goalId')::UUID;
            SELECT * INTO v_active_goal FROM public.goals WHERE id = v_goal_uuid FOR UPDATE;
            IF v_active_goal.id IS NULL THEN
                RAISE EXCEPTION 'Goal not found: %', v_goal_uuid USING ERRCODE = '23503';
            END IF;
            IF v_active_goal.status != 'ACTIVE' THEN
                RAISE EXCEPTION 'Cannot edit non-active goal: %', v_active_goal.status;
            END IF;

            IF p_payload ? 'targetQuantity' AND (p_payload->>'targetQuantity')::INT <= v_active_goal.current_progress THEN
                IF v_active_goal.bonus_amount_minor > 0 THEN
                    INSERT INTO public.financial_ledger (id, customer_id, event_type, amount_minor, metadata, created_at)
                    VALUES (
                        gen_random_uuid(),
                        v_active_goal.customer_id,
                        'BONUS',
                        v_active_goal.bonus_amount_minor,
                        jsonb_build_object('goalId', v_active_goal.id, 'type', 'GOAL_COMPLETION_BONUS'),
                        NOW()
                    )
                    RETURNING id INTO v_goal_bonus_ledger_id;

                    PERFORM public.record_canonical_change('financial_ledger', v_goal_bonus_ledger_id, 'INSERT', jsonb_build_object(
                        'event_type', 'BONUS',
                        'amount_minor', v_active_goal.bonus_amount_minor,
                        'customer_id', v_active_goal.customer_id
                    ), 1);
                END IF;

                UPDATE public.goals
                SET target_quantity = (p_payload->>'targetQuantity')::INT,
                    status = 'COMPLETED',
                    completed_at = NOW(),
                    bonus_ledger_id = v_goal_bonus_ledger_id,
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_goal_uuid;

                v_result := jsonb_build_object('goalId', v_goal_uuid, 'status', 'COMPLETED');
            ELSE
                UPDATE public.goals
                SET target_quantity = COALESCE((p_payload->>'targetQuantity')::INT, target_quantity),
                    bonus_amount_minor = COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, bonus_amount_minor),
                    duration_days = COALESCE((p_payload->>'durationDays')::INT, duration_days),
                    expires_at = CASE WHEN p_payload ? 'durationDays' THEN started_at + ((p_payload->>'durationDays')::INT || ' days')::INTERVAL ELSE expires_at END,
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_goal_uuid;

                v_result := jsonb_build_object('goalId', v_goal_uuid, 'status', 'ACTIVE');
            END IF;

            PERFORM public.record_canonical_change('goals', v_goal_uuid, 'UPDATE', p_payload, v_active_goal.version + 1);

        WHEN 'REQUEST_GOAL' THEN
            v_req_uuid := COALESCE((p_payload->>'id')::UUID, p_command_id);
            v_customer_uuid := (p_payload->>'customerId')::UUID;

            INSERT INTO public.goal_requests (
                id, customer_id, requested_target, status, version, created_at, updated_at
            )
            VALUES (
                v_req_uuid,
                v_customer_uuid,
                (p_payload->>'requestedTarget')::INT,
                'PENDING',
                1,
                NOW(),
                NOW()
            );

            PERFORM public.record_canonical_change('goal_requests', v_req_uuid, 'INSERT', p_payload, 1);
            v_result := jsonb_build_object('requestId', v_req_uuid, 'status', 'PENDING');

        WHEN 'REVIEW_GOAL_REQUEST' THEN
            v_req_uuid := (p_payload->>'requestId')::UUID;
            IF (p_payload->>'decision') = 'APPROVE' THEN
                v_goal_uuid := gen_random_uuid();
                INSERT INTO public.goals (
                    id, customer_id, target_quantity, current_progress, bonus_amount_minor, duration_days,
                    status, started_at, expires_at, version, created_at, updated_at
                )
                VALUES (
                    v_goal_uuid,
                    (p_payload->>'customerId')::UUID,
                    (p_payload->>'targetQuantity')::INT,
                    0,
                    COALESCE((p_payload->>'bonusAmountMinor')::BIGINT, 0),
                    COALESCE((p_payload->>'durationDays')::INT, 7),
                    'ACTIVE',
                    NOW(),
                    NOW() + (COALESCE((p_payload->>'durationDays')::INT, 7) || ' days')::INTERVAL,
                    1,
                    NOW(),
                    NOW()
                );

                UPDATE public.goal_requests
                SET status = 'APPROVED',
                    reviewed_by = v_actor_id,
                    reviewed_at = NOW(),
                    resulting_goal_id = v_goal_uuid,
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_req_uuid;

                PERFORM public.record_canonical_change('goals', v_goal_uuid, 'INSERT', jsonb_build_object('id', v_goal_uuid), 1);
                PERFORM public.record_canonical_change('goal_requests', v_req_uuid, 'UPDATE', jsonb_build_object('status', 'APPROVED', 'resultingGoalId', v_goal_uuid), 2);

                v_result := jsonb_build_object('requestId', v_req_uuid, 'status', 'APPROVED', 'goalId', v_goal_uuid);
            ELSE
                UPDATE public.goal_requests
                SET status = 'REJECTED',
                    reviewed_by = v_actor_id,
                    reviewed_at = NOW(),
                    rejection_reason = p_payload->>'rejectionReason',
                    updated_at = NOW(),
                    version = version + 1
                WHERE id = v_req_uuid;

                PERFORM public.record_canonical_change('goal_requests', v_req_uuid, 'UPDATE', jsonb_build_object('status', 'REJECTED'), 2);

                v_result := jsonb_build_object('requestId', v_req_uuid, 'status', 'REJECTED');
            END IF;
`;

const elseIdx = sql.lastIndexOf("ELSE\n            RAISE EXCEPTION 'Unknown Canonical Command Type");
sql = sql.slice(0, elseIdx) + goalCommands + sql.slice(elseIdx);

fs.writeFileSync('updated_command_fn.sql', sql);
console.log('Successfully generated updated_command_fn.sql! Size:', sql.length);
