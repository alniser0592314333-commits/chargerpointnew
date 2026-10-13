-- Minimal schema for testing the commit-order lock migration in isolated PostgreSQL.
CREATE TABLE public.change_log (
  sequence_id bigserial PRIMARY KEY,
  entity_type varchar(50) NOT NULL,
  entity_id uuid NOT NULL,
  action varchar(20) NOT NULL,
  payload jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.system_settings (key text PRIMARY KEY, value_number bigint);
INSERT INTO public.system_settings(key, value_number) VALUES ('server_reset_generation', 1);
CREATE TABLE public.orders (id uuid PRIMARY KEY, name text NOT NULL);

CREATE OR REPLACE FUNCTION public.record_canonical_change(
  p_entity_type varchar(50), p_entity_id uuid, p_action varchar(20), p_payload jsonb, p_version integer DEFAULT 1
) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_seq bigint;
BEGIN
  INSERT INTO public.change_log(entity_type, entity_id, action, payload, version, changed_at)
  VALUES (p_entity_type, p_entity_id, p_action, p_payload, COALESCE(p_version,1), now())
  RETURNING sequence_id INTO v_seq;
  RETURN v_seq;
END; $$;

CREATE OR REPLACE FUNCTION public.trg_change_capture()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_row jsonb; v_id uuid; v_action text;
BEGIN
  IF TG_OP = 'DELETE' THEN v_row := to_jsonb(OLD); v_id := OLD.id; v_action := 'DELETE';
  ELSE v_row := to_jsonb(NEW); v_id := NEW.id; v_action := CASE WHEN TG_OP='INSERT' THEN 'INSERT' ELSE 'UPDATE' END;
  END IF;
  PERFORM public.record_canonical_change(TG_TABLE_NAME, v_id, v_action, v_row, 1);
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;

CREATE TRIGGER trg_change_capture
AFTER INSERT OR UPDATE OR DELETE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.trg_change_capture();
