-- ═══════════════════════════════════════════════════════════════════════════
-- IDEMPOTENCY FOR ATOMIC TABLE BUY-IN
-- ───────────────────────────────────────────────────────────────────────────
-- Fix for idempotency requirements from handoff to prevent double-charges on
-- network timeouts. Adds p_idempotency_key uuid DEFAULT NULL and table.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.table_buyin_idempotency_keys (
  key        uuid PRIMARY KEY,
  user_id    uuid NOT NULL,
  amount     numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.table_buyin_idempotency_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.table_buyin_idempotency_keys FROM PUBLIC;
GRANT SELECT, INSERT ON public.table_buyin_idempotency_keys TO service_role;

DO $migration$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'atomic_table_buyin'
     AND pg_get_function_identity_arguments(p.oid) LIKE '%p_auto_rebuy boolean, p_club_id uuid%';

  IF v_def IS NULL THEN
    -- It might already have the new signature
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'atomic_table_buyin'
       AND pg_get_function_identity_arguments(p.oid) LIKE '%p_idempotency_key uuid%';
    
    IF v_def IS NOT NULL THEN
      RAISE NOTICE 'atomic_table_buyin already has p_idempotency_key';
      RETURN;
    END IF;

    RAISE EXCEPTION 'atomic_table_buyin original signature not found';
  END IF;

  v_def := replace(v_def,
    'p_club_id uuid DEFAULT NULL::uuid',
    'p_club_id uuid DEFAULT NULL::uuid, p_idempotency_key uuid DEFAULT NULL::uuid'
  );
  
  v_def := replace(v_def,
    E'BEGIN\n',
    E'BEGIN\n    IF p_idempotency_key IS NOT NULL THEN\n        INSERT INTO public.table_buyin_idempotency_keys (key, user_id, amount)\n        VALUES (p_idempotency_key, p_user_id, p_amount) ON CONFLICT (key) DO NOTHING;\n        IF NOT FOUND THEN\n            RETURN;\n        END IF;\n    END IF;\n'
  );

  EXECUTE v_def;
  
  -- Drop the old signature so it doesn't conflict
  DROP FUNCTION IF EXISTS public.atomic_table_buyin(uuid, uuid, integer, numeric, boolean, uuid);
END
$migration$;
