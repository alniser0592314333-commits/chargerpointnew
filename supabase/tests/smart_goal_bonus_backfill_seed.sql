-- Seed isolated historical data before the bonus-allocation migration is applied.
-- This fixture is test-only and never runs against a connected/live database.
INSERT INTO public.customers(id, status, is_active)
VALUES ('abababab-abab-4bab-8bab-abababababab', 'ACTIVE', TRUE);

INSERT INTO public.orders(id, customer_id, day_id, display_number, internal_sequence, status) VALUES
 ('a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1', 'abababab-abab-4bab-8bab-abababababab', NULL, 1, 1, 'delivered'),
 ('b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2', 'abababab-abab-4bab-8bab-abababababab', NULL, 2, 2, 'delivered');

INSERT INTO public.order_items(
  id, order_id, item_sequence, final_charge_snapshot_minor, payment_status,
  status, operational_status, financial_status, delivered_at, financially_recognized_at
) VALUES
 ('c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3', 'a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a1a1', 1, 15, 'UNPAID',
  'delivered', 'DELIVERED', 'RECOGNIZED', now() - interval '3 days', now() - interval '3 days'),
 ('d4d4d4d4-d4d4-44d4-84d4-d4d4d4d4d4d4', 'b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b2b2', 1, 10, 'UNPAID',
  'delivered', 'DELIVERED', 'RECOGNIZED', now() - interval '12 hours', now() - interval '12 hours');

INSERT INTO public.goals(
  id, customer_id, target_quantity, current_progress, bonus_amount_minor,
  duration_days, status, started_at, expires_at, completed_at, bonus_ledger_id
) VALUES (
  'dededede-dede-4ded-8ded-dededededede',
  'abababab-abab-4bab-8bab-abababababab',
  1, 1, 20, 3, 'COMPLETED', now() - interval '5 days',
  (now() - interval '5 days') + interval '3 days', now() - interval '2 days',
  'efefefef-efef-4fef-8fef-efefefefefef'
);

INSERT INTO public.financial_ledger(
  id, event_type, amount_minor, customer_id, reference_id, metadata, created_at
) VALUES (
  'efefefef-efef-4fef-8fef-efefefefefef', 'BONUS', 20,
  'abababab-abab-4bab-8bab-abababababab', 'dededede-dede-4ded-8ded-dededededede',
  jsonb_build_object('goalId', 'dededede-dede-4ded-8ded-dededededede', 'reason', 'GOAL_COMPLETED'),
  now() - interval '2 days'
);
