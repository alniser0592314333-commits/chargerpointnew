select plan(7);

select has_table(
  'public',
  'order_renumber_audit',
  'The controlled renumber audit table is created by migrations'
);

select has_function(
  'public',
  'execute_canonical_sync_command',
  ARRAY['uuid', 'text', 'jsonb', 'text', 'text', 'uuid'],
  'The canonical sync dispatcher keeps its established six-argument signature'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.execute_canonical_sync_command(uuid,text,jsonb,text,text,uuid)',
    'EXECUTE'
  ),
  'Authenticated callers retain the canonical sync execution contract'
);

select ok(
  not has_function_privilege(
    'anon',
    'public.execute_canonical_sync_command(uuid,text,jsonb,text,text,uuid)',
    'EXECUTE'
  ),
  'Anonymous callers cannot directly execute the SECURITY DEFINER dispatcher'
);

select ok(
  not has_table_privilege('authenticated', 'public.order_renumber_audit', 'SELECT'),
  'Authenticated callers cannot read the internal renumber audit table directly'
);

select ok(
  not has_table_privilege('authenticated', 'public.order_renumber_audit', 'INSERT'),
  'Authenticated callers cannot forge audit records directly'
);

select ok(
  not has_table_privilege('anon', 'public.order_renumber_audit', 'SELECT'),
  'Anonymous callers cannot read the internal renumber audit table'
);

select * from finish();
