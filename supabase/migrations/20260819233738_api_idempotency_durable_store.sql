-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819233738 "api_idempotency_durable_store"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 502b74f77700481ef70ab1596f27fd04 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- Durable idempotency store.
--
-- WHY: src/lib/club-arena/idempotency.js keeps keys in a per-process Map. On
-- Vercel every lambda instance has its own, so two rapid requests that land on
-- different instances BOTH miss the cache and both execute. The header promises
-- a guarantee the transport cannot keep.
--
-- This is a shared, TTL'd store. fn_idempotency_begin atomically claims a key:
-- the first caller gets {claimed:true} and proceeds; a concurrent caller gets
-- {claimed:false, state:'processing'} (409); a later caller gets the cached
-- response replayed. Because the claim is a single INSERT ... ON CONFLICT, the
-- race is decided by Postgres rather than by whichever instance woke first.
--
-- NOTE: this backstops, it does not replace, the invariants in the schema.
-- The partial unique index on club_shop_inventory is still what makes a double
-- purchase impossible — an idempotency layer alone cannot, because the client
-- mints a fresh key per click.
--
-- Rollback:
--   DROP FUNCTION public.fn_idempotency_begin(text, text, integer);
--   DROP FUNCTION public.fn_idempotency_finish(text, integer, jsonb);
--   DROP TABLE public.api_idempotency;
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.api_idempotency (
  key         text PRIMARY KEY,
  route       text NOT NULL,
  state       text NOT NULL DEFAULT 'processing'
              CHECK (state IN ('processing', 'done')),
  status      integer,
  body        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_api_idempotency_expiry
  ON public.api_idempotency (expires_at);

ALTER TABLE public.api_idempotency ENABLE ROW LEVEL SECURITY;

-- Server-only: never readable by a client.
DROP POLICY IF EXISTS api_idempotency_svc ON public.api_idempotency;
CREATE POLICY api_idempotency_svc ON public.api_idempotency
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.api_idempotency IS
  'Cross-instance idempotency keys. Per-process Maps do not work on serverless.';

CREATE OR REPLACE FUNCTION public.fn_idempotency_begin(
  p_key text, p_route text, p_ttl_seconds integer DEFAULT 300
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_row api_idempotency;
BEGIN
  IF p_key IS NULL OR length(p_key) < 8 THEN
    RETURN jsonb_build_object('claimed', false, 'state', 'invalid');
  END IF;

  -- Opportunistic sweep; cheap and keeps the table from growing unbounded.
  DELETE FROM api_idempotency WHERE expires_at < now();

  INSERT INTO api_idempotency (key, route, state, expires_at)
  VALUES (p_key, p_route, 'processing', now() + make_interval(secs => GREATEST(1, p_ttl_seconds)))
  ON CONFLICT (key) DO NOTHING;

  IF FOUND THEN
    RETURN jsonb_build_object('claimed', true);
  END IF;

  SELECT * INTO v_row FROM api_idempotency WHERE key = p_key;

  IF NOT FOUND THEN
    -- Swept between the INSERT and the SELECT; treat as a fresh claim.
    RETURN jsonb_build_object('claimed', true);
  END IF;

  IF v_row.state = 'done' THEN
    RETURN jsonb_build_object('claimed', false, 'state', 'done',
                              'status', v_row.status, 'body', v_row.body);
  END IF;

  RETURN jsonb_build_object('claimed', false, 'state', 'processing');
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_idempotency_finish(
  p_key text, p_status integer, p_body jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF p_key IS NULL THEN RETURN; END IF;

  -- Never cache a 5xx: a transient failure would be replayed as a permanent
  -- one for the whole TTL, over an operation that may well have committed.
  IF p_status >= 500 THEN
    DELETE FROM api_idempotency WHERE key = p_key;
    RETURN;
  END IF;

  UPDATE api_idempotency
     SET state = 'done', status = p_status, body = p_body
   WHERE key = p_key;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_idempotency_begin(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_idempotency_finish(text, integer, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_idempotency_begin(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_idempotency_finish(text, integer, jsonb) TO service_role;

DO $$
BEGIN
  IF to_regclass('public.api_idempotency') IS NULL THEN
    RAISE EXCEPTION 'api_idempotency missing';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_idempotency_begin(text, text, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'fn_idempotency_begin must not be executable by authenticated';
  END IF;
END $$;
