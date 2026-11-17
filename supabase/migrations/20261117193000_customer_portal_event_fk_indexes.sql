-- Cover the event and web-push subscription foreign keys used by admin/customer lifecycle operations.
create index if not exists customer_portal_events_created_by_idx
  on public.customer_portal_events (created_by) where created_by is not null;
create index if not exists customer_portal_events_updated_by_idx
  on public.customer_portal_events (updated_by) where updated_by is not null;
create index if not exists customer_push_subscriptions_customer_id_idx
  on public.customer_push_subscriptions (customer_id) where customer_id is not null;
