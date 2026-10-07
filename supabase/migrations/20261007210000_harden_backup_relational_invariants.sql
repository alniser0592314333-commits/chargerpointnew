-- Canonical relational invariants for online business replacement.
-- Applied to the authoritative Supabase project as part of the backup/restore contract.

alter table public.orders
  add constraint orders_qr_token_id_fkey
  foreign key (qr_token_id) references public.qr_tokens(id) on delete set null;

alter table public.payment_allocations
  add constraint payment_allocations_target_check
  check (order_id is not null or order_item_id is not null);

alter table public.qr_tokens
  add constraint qr_tokens_token_hash_check
  check (token_hash = encode(digest(public_token, 'sha256'), 'hex'));
