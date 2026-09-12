-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260907081603; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260907081603   (the stamp IS the apply time, UTC: 2026-09-07 08:16:03)
--   name        marketplace_phase8_lifetime_vip_unlimited_digital_benefits
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 54796 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260907081603 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_time_bank_allowance, public.sp_is_lifetime_vip, public.fn_use_throwable_v2, public.fn_use_throwable, public.fn_consume_rabbit_hunt_v2, public.fn_consume_rabbit_hunt, public.fn_time_bank_allowance_v2, public.fn_consume_time_bank
--     TABLE          public.digital_purchase_receipts, public.throwable_use_receipts
--     POLICY         digital_purchase_receipts_deny_browser, throwable_use_receipts_deny_browser
--     DROP           POLICY digital_purchase_receipts_deny_browser, POLICY throwable_use_receipts_deny_browser
--     RLS-ENABLE     
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- Lifetime VIP owns the digital poker-table experience.
--
-- A Lifetime member may use Throwables, Rabbit Hunts, and normal 20-second
-- Time Banks without a monthly meter, purchased-credit decrement, or Diamond
-- debit. The Time Bank street cap is deliberately not a database entitlement:
-- the authoritative engine continues to allow no more than two activations on
-- one street. This migration grants more activations, never longer decisions.
--
-- Cataloged Table Studio assets and card backs already use
-- sp_theme_asset_is_owned(), which grants every premium catalog asset to an
-- active VIP and treats the exact `lifetime` tier as non-expiring. VIP frames
-- and auras have equivalent ownership guards. VIP avatar visibility is filtered
-- by the client, but the legacy profile avatar URL remains a broadly writable
-- field with free, generated, purchased, and historic URL shapes. This migration
-- deliberately does not risk breaking that 97-avatar/custom-avatar library with
-- a guessed URL trigger. We do not manufacture one purchase row per asset:
-- membership is permission, while purchase rows remain durable receipts for
-- individually bought assets.
--
-- Deliberate boundary: this does not make physical merchandise, Diamond
-- packages, memberships, tournament value, transferable assets, or arbitrary
-- operator-stock Club Shop items free. Those products have fulfillment,
-- inventory, refund, or financial semantics that a blanket zero-price branch
-- would corrupt.
--
-- It also does not issue the proposed expiring monthly Diamond stipend. The
-- current Diamond balance is fungible and has no grant-lot provenance, so an
-- expiry job could destroy bought or earned value. That benefit needs a separate
-- lot ledger and oldest-expiring-first redemption migration before it is safe.

BEGIN;

-- Keep the legacy rollout reader for older clients, but do not let one member
-- enumerate another member's VIP or purchased Time Bank balance through this
-- SECURITY DEFINER function. The service-role game engine may batch-read every
-- seated player; an authenticated browser may read only itself.
CREATE OR REPLACE FUNCTION public.fn_time_bank_allowance(p_user_ids uuid[])
RETURNS TABLE(
  user_id uuid,
  is_vip boolean,
  vip_seconds_remaining integer,
  purchased_seconds integer,
  extra_seconds integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH vip AS (
    SELECT
      p.id,
      (
        COALESCE(p.is_vip, false)
        AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now())
      ) AS is_vip
    FROM public.profiles p
    WHERE p.id = ANY(p_user_ids)
      AND (auth.role() = 'service_role' OR p.id = auth.uid())
  ), monthly AS (
    SELECT
      m.user_id AS uid,
      COALESCE(SUM(m.usage_count), 0)::int AS used
    FROM public.vip_feature_usage_monthly m
    WHERE m.user_id IN (SELECT vip.id FROM vip)
      AND m.feature = 'time_bank_seconds'
      AND m.month = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')
    GROUP BY 1
  ), bought AS (
    SELECT
      fp.user_id AS uid,
      COALESCE(SUM(fp.uses_remaining), 0)::int * 20 AS secs
    FROM public.feature_purchases fp
    WHERE fp.user_id IN (SELECT vip.id FROM vip)
      AND fp.feature = 'time_bank_seconds'
      AND COALESCE(fp.uses_remaining, 0) > 0
      AND (fp.expires_at IS NULL OR fp.expires_at > now())
    GROUP BY 1
  )
  SELECT
    v.id,
    v.is_vip,
    CASE
      WHEN v.is_vip THEN GREATEST(0, 120 - COALESCE(m.used, 0))
      ELSE 0
    END,
    COALESCE(b.secs, 0),
    CASE
      WHEN v.is_vip THEN GREATEST(0, 120 - COALESCE(m.used, 0))
      ELSE 0
    END + COALESCE(b.secs, 0)
  FROM vip v
  LEFT JOIN monthly m ON m.uid = v.id
  LEFT JOIN bought b ON b.uid = v.id;
$function$;

REVOKE ALL ON FUNCTION public.fn_time_bank_allowance(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_time_bank_allowance(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_time_bank_allowance(uuid[])
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sp_is_lifetime_vip(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT COALESCE((
    SELECT COALESCE(p.is_vip, false) AND p.vip_tier = 'lifetime'
      FROM public.profiles p
     WHERE p.id = p_user_id
  ), false);
$function$;

REVOKE ALL ON FUNCTION public.sp_is_lifetime_vip(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sp_is_lifetime_vip(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.sp_is_lifetime_vip(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.sp_is_lifetime_vip(uuid) TO service_role;

-- A wallet journal row proves that Diamonds moved, but it is not a complete
-- purchase receipt: a zero-cost SKU has no debit row, and the journal cannot
-- bind one request UUID to its original operation and payload. Keep the real
-- request contract in a private table so every successful paid or free outcome
-- can be replayed without charging or granting again.
CREATE TABLE IF NOT EXISTS public.digital_purchase_receipts (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  purchase_kind text NOT NULL CHECK (purchase_kind IN ('rabbit_hunt', 'time_bank', 'feature')),
  request_payload jsonb NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);

ALTER TABLE public.digital_purchase_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.digital_purchase_receipts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.digital_purchase_receipts TO service_role;
DROP POLICY IF EXISTS digital_purchase_receipts_deny_browser
  ON public.digital_purchase_receipts;
CREATE POLICY digital_purchase_receipts_deny_browser
  ON public.digital_purchase_receipts
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

-- A usage row alone cannot identify a response-lost retry because the same
-- member may intentionally send the same reaction again. This private receipt
-- binds one browser UUID to one throwable and its committed result.
CREATE TABLE IF NOT EXISTS public.throwable_use_receipts (
  user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  throwable_id text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, request_id)
);

ALTER TABLE public.throwable_use_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.throwable_use_receipts
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.throwable_use_receipts TO service_role;
DROP POLICY IF EXISTS throwable_use_receipts_deny_browser
  ON public.throwable_use_receipts;
CREATE POLICY throwable_use_receipts_deny_browser
  ON public.throwable_use_receipts
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (false)
  WITH CHECK (false);

CREATE OR REPLACE FUNCTION public.fn_use_throwable_v2(
  p_throwable_id text,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_uid         uuid := auth.uid();
  v_vip         boolean;
  v_lifetime    boolean;
  v_used        integer;
  v_free        constant integer := 500;
  v_credit      uuid;
  v_left        integer;
  v_res         jsonb;
  v_result      jsonb;
  v_cached_id   text;
  v_cached      jsonb;
  v_month_start timestamptz := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Authentication Required');
  END IF;
  IF p_throwable_id IS NULL OR length(p_throwable_id) = 0 OR length(p_throwable_id) > 64 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Invalid Throwable');
  END IF;
  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Secure Request Id Required');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended('throwable:request:' || v_uid::text || ':' || p_request_id::text, 0)
  );

  SELECT r.throwable_id, r.result
    INTO v_cached_id, v_cached
    FROM public.throwable_use_receipts r
   WHERE r.user_id = v_uid
     AND r.request_id = p_request_id;

  IF v_cached IS NOT NULL THEN
    IF v_cached_id IS DISTINCT FROM p_throwable_id THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Request Id Already Used For Another Throwable'
      );
    END IF;
    RETURN v_cached || jsonb_build_object(
      'diamonds_spent', 0,
      'original_diamonds_spent',
        COALESCE(
          (v_cached->>'original_diamonds_spent')::integer,
          (v_cached->>'diamonds_spent')::integer,
          0
        ),
      'idempotent', true,
      'consumed', false
    );
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('throwable:' || v_uid::text, 0));

  SELECT
    COALESCE(p.is_vip, false)
      AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now()),
    COALESCE(p.is_vip, false) AND p.vip_tier = 'lifetime'
    INTO v_vip, v_lifetime
    FROM public.profiles p
   WHERE p.id = v_uid;

  IF v_vip IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown User');
  END IF;

  -- Unlimited means no inventory meter, not unlimited write throughput. The
  -- visible selector already has the same 1.5-second animation cooldown; pin it
  -- here under the per-account advisory lock so a crafted browser client cannot
  -- turn the Lifetime audit trail into an unbounded database-write endpoint.
  IF EXISTS (
    SELECT 1
      FROM public.throw_usage tu
     WHERE tu.user_id = v_uid
       AND tu.created_at > clock_timestamp() - interval '1500 milliseconds'
  ) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Please Wait Before Sending Another Throwable',
      'code', 'RATE_LIMITED',
      'retry_after_ms', 1500
    );
  END IF;

  IF v_lifetime THEN
    INSERT INTO public.throw_usage (user_id, throwable_id, paid_diamonds)
    VALUES (v_uid, p_throwable_id, false);

    v_result := jsonb_build_object(
      'success', true,
      'paid', false,
      'source', 'lifetime_vip',
      'unlimited', true,
      'diamonds_spent', 0,
      'idempotent', false,
      'consumed', true
    );
    INSERT INTO public.throwable_use_receipts (user_id, request_id, throwable_id, result)
    VALUES (v_uid, p_request_id, p_throwable_id, v_result);
    RETURN v_result;
  END IF;

  IF v_vip THEN
    SELECT count(*) INTO v_used
      FROM public.throw_usage
     WHERE user_id = v_uid
       AND created_at >= v_month_start;

    IF v_used < v_free THEN
      INSERT INTO public.throw_usage (user_id, throwable_id, paid_diamonds)
      VALUES (v_uid, p_throwable_id, false);

      v_result := jsonb_build_object(
        'success', true,
        'paid', false,
        'source', 'vip_monthly',
        'free_remaining', v_free - v_used - 1,
        'diamonds_spent', 0,
        'idempotent', false,
        'consumed', true
      );
      INSERT INTO public.throwable_use_receipts (user_id, request_id, throwable_id, result)
      VALUES (v_uid, p_request_id, p_throwable_id, v_result);
      RETURN v_result;
    END IF;
  END IF;

  SELECT id INTO v_credit
    FROM public.feature_purchases
   WHERE user_id = v_uid
     AND feature = 'throwable'
     AND COALESCE(uses_remaining, 0) > 0
     AND (expires_at IS NULL OR expires_at > now())
   ORDER BY created_at ASC
   LIMIT 1
   FOR UPDATE SKIP LOCKED;

  IF v_credit IS NOT NULL THEN
    UPDATE public.feature_purchases
       SET uses_remaining = uses_remaining - 1
     WHERE id = v_credit
     RETURNING uses_remaining INTO v_left;

    INSERT INTO public.throw_usage (user_id, throwable_id, paid_diamonds)
    VALUES (v_uid, p_throwable_id, false);

    v_result := jsonb_build_object(
      'success', true,
      'paid', false,
      'source', 'purchased',
      'from_pack', true,
      'pack_remaining', v_left,
      'diamonds_spent', 0,
      'idempotent', false,
      'consumed', true
    );
    INSERT INTO public.throwable_use_receipts (user_id, request_id, throwable_id, result)
    VALUES (v_uid, p_request_id, p_throwable_id, v_result);
    RETURN v_result;
  END IF;

  v_res := public.deduct_diamonds(
    v_uid,
    1,
    'Throwable: ' || p_throwable_id,
    'throwable'
  );

  IF COALESCE((v_res->>'success')::boolean, false) IS NOT TRUE THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', COALESCE(v_res->>'error', 'Diamond Charge Failed')
    );
  END IF;

  INSERT INTO public.throw_usage (user_id, throwable_id, paid_diamonds)
  VALUES (v_uid, p_throwable_id, true);

  v_result := jsonb_build_object(
    'success', true,
    'paid', true,
    'source', 'diamonds',
    'diamonds_spent', 1,
    'balance', (v_res->>'balance')::numeric,
    'idempotent', false,
    'consumed', true
  );
  INSERT INTO public.throwable_use_receipts (user_id, request_id, throwable_id, result)
  VALUES (v_uid, p_request_id, p_throwable_id, v_result);
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_use_throwable_v2(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_use_throwable_v2(text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_use_throwable_v2(text, uuid)
  TO authenticated, service_role;

-- Rollout bridge for the already-published selector. The unkeyed signature is
-- retired only after the v2 caller is proven live in a separate release.
CREATE OR REPLACE FUNCTION public.fn_use_throwable(p_throwable_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Authentication required');
  END IF;

  RETURN public.fn_use_throwable_v2(p_throwable_id, gen_random_uuid());
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_use_throwable(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_use_throwable(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_use_throwable(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_consume_rabbit_hunt_v2(
  p_user_id uuid,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_vip_monthly_cap CONSTANT int := 100;
  v_default_cost    CONSTANT int := 5;
  v_is_vip          boolean;
  v_is_lifetime     boolean;
  v_month           text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_used            int;
  v_cost            int;
  v_row             record;
  v_deduct          jsonb;
  v_balance         integer;
  v_request_payload jsonb := jsonb_build_object(
    'feature', 'rabbit_hunt',
    'user_id', p_user_id
  );
  v_cached_kind     text;
  v_cached_payload  jsonb;
  v_cached_result   jsonb;
  v_result          jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'fn_consume_rabbit_hunt_v2 is engine-only';
  END IF;
  IF p_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'User Id Required');
  END IF;
  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Secure Request Id Required');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'digital_purchase_request:' || p_user_id::text || ':' || p_request_id::text,
      0
    )
  );

  SELECT r.purchase_kind, r.request_payload, r.result
    INTO v_cached_kind, v_cached_payload, v_cached_result
    FROM public.digital_purchase_receipts r
   WHERE r.user_id = p_user_id
     AND r.request_id = p_request_id;

  IF FOUND THEN
    IF v_cached_kind IS DISTINCT FROM 'rabbit_hunt'
       OR v_cached_payload IS DISTINCT FROM v_request_payload
    THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Request Id Already Used For Another Purchase',
        'code', 'REQUEST_ID_REUSED'
      );
    END IF;

    RETURN v_cached_result || jsonb_build_object(
      'diamonds_spent', 0,
      'original_diamonds_spent',
        COALESCE(
          (v_cached_result->>'original_diamonds_spent')::integer,
          (v_cached_result->>'diamonds_spent')::integer,
          0
        ),
      'idempotent', true,
      'consumed', false
    );
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('rabbit_hunt:' || p_user_id::text, 0));

  SELECT
    COALESCE(p.is_vip, false)
      AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now()),
    COALESCE(p.is_vip, false) AND p.vip_tier = 'lifetime'
    INTO v_is_vip, v_is_lifetime
    FROM public.profiles p
   WHERE p.id = p_user_id;

  IF v_is_vip IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown user');
  END IF;

  IF v_is_lifetime THEN
    INSERT INTO public.vip_feature_usage_monthly
      (user_id, feature, month, usage_count, updated_at)
    VALUES
      (p_user_id, 'rabbit_hunt', v_month, 1, now())
    ON CONFLICT (user_id, feature, month) DO UPDATE
       SET usage_count = public.vip_feature_usage_monthly.usage_count + 1,
           updated_at = now();

    v_result := jsonb_build_object(
      'success', true,
      'source', 'lifetime_vip',
      'unlimited', true,
      'vip_remaining', null,
      'diamonds_spent', 0,
      'idempotent', false,
      'consumed', true
    );
    INSERT INTO public.digital_purchase_receipts
      (user_id, request_id, purchase_kind, request_payload, result)
    VALUES
      (p_user_id, p_request_id, 'rabbit_hunt', v_request_payload, v_result);
    RETURN v_result;
  END IF;

  IF v_is_vip THEN
    SELECT COALESCE(SUM(usage_count), 0)::int INTO v_used
      FROM public.vip_feature_usage_monthly
     WHERE user_id = p_user_id
       AND feature = 'rabbit_hunt'
       AND month = v_month;

    IF v_used < v_vip_monthly_cap THEN
      INSERT INTO public.vip_feature_usage_monthly
        (user_id, feature, month, usage_count, updated_at)
      VALUES
        (p_user_id, 'rabbit_hunt', v_month, 1, now())
      ON CONFLICT (user_id, feature, month) DO UPDATE
         SET usage_count = public.vip_feature_usage_monthly.usage_count + 1,
             updated_at = now();

      v_result := jsonb_build_object(
        'success', true,
        'source', 'vip_monthly',
        'vip_used', v_used + 1,
        'vip_remaining', v_vip_monthly_cap - (v_used + 1),
        'diamonds_spent', 0,
        'idempotent', false,
        'consumed', true
      );
      INSERT INTO public.digital_purchase_receipts
        (user_id, request_id, purchase_kind, request_payload, result)
      VALUES
        (p_user_id, p_request_id, 'rabbit_hunt', v_request_payload, v_result);
      RETURN v_result;
    END IF;
  END IF;

  SELECT id, uses_remaining INTO v_row
    FROM public.feature_purchases
   WHERE user_id = p_user_id
     AND feature = 'rabbit_hunt'
     AND COALESCE(uses_remaining, 0) > 0
     AND (expires_at IS NULL OR expires_at > now())
   ORDER BY created_at
   FOR UPDATE
   LIMIT 1;

  IF FOUND THEN
    UPDATE public.feature_purchases
       SET uses_remaining = uses_remaining - 1
     WHERE id = v_row.id;

    v_result := jsonb_build_object(
      'success', true,
      'source', 'purchased',
      'uses_remaining', v_row.uses_remaining - 1,
      'diamonds_spent', 0,
      'idempotent', false,
      'consumed', true
    );
    INSERT INTO public.digital_purchase_receipts
      (user_id, request_id, purchase_kind, request_payload, result)
    VALUES
      (p_user_id, p_request_id, 'rabbit_hunt', v_request_payload, v_result);
    RETURN v_result;
  END IF;

  SELECT COALESCE(diamond_cost, v_default_cost) INTO v_cost
    FROM public.feature_pricing
   WHERE feature = 'rabbit_hunt'
   LIMIT 1;
  v_cost := COALESCE(v_cost, v_default_cost);

  IF v_cost < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Rabbit Hunt Pricing Is Invalid');
  END IF;

  IF v_cost > 0 THEN
    v_deduct := public.deduct_diamonds(
      p_user_id          => p_user_id,
      p_amount           => v_cost,
      p_description      => 'Rabbit Hunt',
      p_transaction_type => 'feature_purchase',
      p_source           => 'rabbit_hunt',
      p_reference_id     => 'rabbit_use_' || p_user_id::text || '_' || p_request_id::text
    );

    IF COALESCE((v_deduct->>'success')::boolean, false) IS NOT TRUE THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'insufficient_diamonds',
        'cost', v_cost,
        'diamonds_remaining', (v_deduct->>'balance')::numeric
      );
    END IF;

    IF COALESCE((v_deduct->>'idempotent')::boolean, false) THEN
      v_result := jsonb_build_object(
        'success', true,
        'source', 'diamonds',
        'diamonds_spent', 0,
        'original_diamonds_spent', v_cost,
        'diamonds_remaining', (v_deduct->>'balance')::numeric,
        'idempotent', true,
        'consumed', false
      );
      INSERT INTO public.digital_purchase_receipts
        (user_id, request_id, purchase_kind, request_payload, result)
      VALUES
        (p_user_id, p_request_id, 'rabbit_hunt', v_request_payload, v_result);
      RETURN v_result;
    END IF;
    v_balance := (v_deduct->>'balance')::integer;
  ELSE
    SELECT p.diamonds INTO v_balance
      FROM public.profiles p
     WHERE p.id = p_user_id;
  END IF;

  v_result := jsonb_build_object(
    'success', true,
    'source', 'diamonds',
    'diamonds_spent', v_cost,
    'diamonds_remaining', v_balance,
    'idempotent', false,
    'consumed', true
  );
  INSERT INTO public.digital_purchase_receipts
    (user_id, request_id, purchase_kind, request_payload, result)
  VALUES
    (p_user_id, p_request_id, 'rabbit_hunt', v_request_payload, v_result);
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_consume_rabbit_hunt_v2(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_consume_rabbit_hunt_v2(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_consume_rabbit_hunt_v2(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_consume_rabbit_hunt_v2(uuid, uuid) TO service_role;

-- DB-first rollout bridge. The engine moves to the keyed v2 call in this
-- release; a later migration retires this unkeyed shape after production proves
-- the new caller is live.
CREATE OR REPLACE FUNCTION public.fn_consume_rabbit_hunt(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'fn_consume_rabbit_hunt is engine-only';
  END IF;

  RETURN public.fn_consume_rabbit_hunt_v2(p_user_id, gen_random_uuid());
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_consume_rabbit_hunt(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_consume_rabbit_hunt(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.fn_consume_rabbit_hunt(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_consume_rabbit_hunt(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_time_bank_allowance_v2(p_user_ids uuid[])
RETURNS TABLE(
  user_id uuid,
  is_vip boolean,
  is_lifetime boolean,
  unlimited_activations boolean,
  vip_seconds_remaining integer,
  purchased_seconds integer,
  extra_seconds integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH vip AS (
    SELECT
      p.id,
      COALESCE(p.is_vip, false)
        AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now())
          AS is_vip,
      COALESCE(p.is_vip, false) AND p.vip_tier = 'lifetime' AS is_lifetime
    FROM public.profiles p
    WHERE p.id = ANY(p_user_ids)
      AND (auth.role() = 'service_role' OR p.id = auth.uid())
  ), monthly AS (
    SELECT m.user_id AS uid, COALESCE(SUM(m.usage_count), 0)::int AS used
      FROM public.vip_feature_usage_monthly m
     WHERE m.user_id IN (SELECT vip.id FROM vip)
       AND m.feature = 'time_bank_seconds'
       AND m.month = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM')
     GROUP BY 1
  ), bought AS (
    SELECT fp.user_id AS uid, COALESCE(SUM(fp.uses_remaining), 0)::int * 20 AS secs
      FROM public.feature_purchases fp
     WHERE fp.user_id IN (SELECT vip.id FROM vip)
       AND fp.feature = 'time_bank_seconds'
       AND COALESCE(fp.uses_remaining, 0) > 0
       AND (fp.expires_at IS NULL OR fp.expires_at > now())
     GROUP BY 1
  )
  SELECT
    v.id,
    v.is_vip,
    v.is_lifetime,
    v.is_lifetime,
    CASE
      WHEN v.is_lifetime THEN NULL
      WHEN v.is_vip THEN GREATEST(0, 120 - COALESCE(m.used, 0))
      ELSE 0
    END,
    COALESCE(b.secs, 0),
    CASE
      WHEN v.is_lifetime THEN 0
      WHEN v.is_vip THEN GREATEST(0, 120 - COALESCE(m.used, 0)) + COALESCE(b.secs, 0)
      ELSE COALESCE(b.secs, 0)
    END
  FROM vip v
  LEFT JOIN monthly m ON m.uid = v.id
  LEFT JOIN bought b ON b.uid = v.id;
$function$;

REVOKE ALL ON FUNCTION public.fn_time_bank_allowance_v2(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_time_bank_allowance_v2(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_time_bank_allowance_v2(uuid[])
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_consume_time_bank(p_user_id uuid, p_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_is_vip      boolean;
  v_is_lifetime boolean;
  v_month       text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_used        int;
  v_from_vip    int := 0;
  v_remaining   int;
  v_uses_needed int;
  v_uses_taken  int := 0;
  v_row         record;
  v_take        int;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'fn_consume_time_bank is engine-only';
  END IF;
  IF p_seconds IS NULL OR p_seconds <= 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'p_seconds must be positive');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('time_bank:' || p_user_id::text, 0));

  SELECT
    COALESCE(p.is_vip, false)
      AND (p.vip_tier = 'lifetime' OR p.vip_expires_at IS NULL OR p.vip_expires_at > now()),
    COALESCE(p.is_vip, false) AND p.vip_tier = 'lifetime'
    INTO v_is_vip, v_is_lifetime
    FROM public.profiles p
   WHERE p.id = p_user_id;

  IF v_is_vip IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unknown user');
  END IF;

  IF v_is_lifetime THEN
    INSERT INTO public.vip_feature_usage_monthly
      (user_id, feature, month, usage_count, updated_at)
    VALUES
      (p_user_id, 'time_bank_seconds', v_month, p_seconds, now())
    ON CONFLICT (user_id, feature, month) DO UPDATE
       SET usage_count = public.vip_feature_usage_monthly.usage_count + EXCLUDED.usage_count,
           updated_at = now();

    RETURN jsonb_build_object(
      'success', true,
      'source', 'lifetime_vip',
      'unlimited', true,
      'consumed_vip_seconds', p_seconds,
      'consumed_purchased_uses', 0,
      'shortfall_seconds', 0
    );
  END IF;

  v_remaining := p_seconds;

  IF v_is_vip THEN
    SELECT COALESCE(SUM(usage_count), 0)::int INTO v_used
      FROM public.vip_feature_usage_monthly
     WHERE user_id = p_user_id
       AND feature = 'time_bank_seconds'
       AND month = v_month;

    v_from_vip := LEAST(v_remaining, GREATEST(0, 120 - v_used));
    IF v_from_vip > 0 THEN
      INSERT INTO public.vip_feature_usage_monthly
        (user_id, feature, month, usage_count, updated_at)
      VALUES
        (p_user_id, 'time_bank_seconds', v_month, v_from_vip, now())
      ON CONFLICT (user_id, feature, month) DO UPDATE
         SET usage_count = public.vip_feature_usage_monthly.usage_count + EXCLUDED.usage_count,
             updated_at = now();
      v_remaining := v_remaining - v_from_vip;
    END IF;
  END IF;

  IF v_remaining > 0 THEN
    v_uses_needed := CEIL(v_remaining / 20.0)::int;
    FOR v_row IN
      SELECT id, uses_remaining
        FROM public.feature_purchases
       WHERE user_id = p_user_id
         AND feature = 'time_bank_seconds'
         AND COALESCE(uses_remaining, 0) > 0
         AND (expires_at IS NULL OR expires_at > now())
       ORDER BY created_at
       FOR UPDATE
    LOOP
      EXIT WHEN v_uses_needed <= 0;
      v_take := LEAST(v_row.uses_remaining, v_uses_needed);
      UPDATE public.feature_purchases
         SET uses_remaining = uses_remaining - v_take
       WHERE id = v_row.id;
      v_uses_taken := v_uses_taken + v_take;
      v_uses_needed := v_uses_needed - v_take;
    END LOOP;
    v_remaining := GREATEST(0, v_remaining - v_uses_taken * 20);
  END IF;

  RETURN jsonb_build_object(
    'success', true,
    'consumed_vip_seconds', v_from_vip,
    'consumed_purchased_uses', v_uses_taken,
    'shortfall_seconds', v_remaining
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_consume_time_bank(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_consume_time_bank(uuid, integer) FROM anon;
REVOKE ALL ON FUNCTION public.fn_consume_time_bank(uuid, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.fn_consume_time_bank(uuid, integer) TO service_role;

-- A Lifetime member has nothing to buy here. Guard the direct RPC as well as
-- the UI so a stale tab or crafted request cannot burn Diamonds for an
-- entitlement the account already owns. Every ordinary purchase is keyed by
-- one browser-minted UUID. The account/request advisory lock is acquired before
-- the wallet receipt check, debit, or grant, so a lost response and every
-- sequential or concurrent replay converge on one debit and one grant.
CREATE OR REPLACE FUNCTION public.fn_purchase_time_banks_v2(
  p_quantity integer,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_caller         uuid := auth.uid();
  v_unit_cost      integer;
  v_total_cost     integer;
  v_deduct         jsonb;
  v_reference      text;
  v_balance        integer;
  v_request_payload jsonb := jsonb_build_object('quantity', p_quantity);
  v_cached_kind    text;
  v_cached_payload jsonb;
  v_cached_result  jsonb;
  v_result         jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Authentication Required');
  END IF;

  IF p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 500 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Quantity Must Be Between 1 And 500');
  END IF;

  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Secure Request Id Required');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'digital_purchase_request:' || v_caller::text || ':' || p_request_id::text,
      0
    )
  );

  SELECT r.purchase_kind, r.request_payload, r.result
    INTO v_cached_kind, v_cached_payload, v_cached_result
    FROM public.digital_purchase_receipts r
   WHERE r.user_id = v_caller
     AND r.request_id = p_request_id;

  IF FOUND THEN
    IF v_cached_kind IS DISTINCT FROM 'time_bank'
       OR v_cached_payload IS DISTINCT FROM v_request_payload
    THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Request Id Already Used For Another Purchase',
        'code', 'REQUEST_ID_REUSED'
      );
    END IF;

    RETURN v_cached_result || jsonb_build_object(
      'total_cost', 0,
      'original_total_cost',
        COALESCE(
          (v_cached_result->>'original_total_cost')::integer,
          (v_cached_result->>'total_cost')::integer,
          0
        ),
      'idempotent', true,
      'granted', false
    );
  END IF;

  IF public.sp_is_lifetime_vip(v_caller) THEN
    SELECT p.diamonds INTO v_balance
      FROM public.profiles p
     WHERE p.id = v_caller;

    v_result := jsonb_build_object(
      'success', true,
      'included', true,
      'unlimited', true,
      'source', 'lifetime_vip',
      'quantity', p_quantity,
      'unit_cost', 0,
      'total_cost', 0,
      'idempotent', false,
      'granted', false,
      'diamonds_remaining', v_balance
    );
    INSERT INTO public.digital_purchase_receipts
      (user_id, request_id, purchase_kind, request_payload, result)
    VALUES
      (v_caller, p_request_id, 'time_bank', v_request_payload, v_result);
    RETURN v_result;
  END IF;

  SELECT diamond_cost INTO v_unit_cost
    FROM public.feature_pricing
   WHERE feature = 'time_bank_seconds';

  IF v_unit_cost IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Time Bank Pricing Not Configured');
  END IF;
  IF v_unit_cost < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Time Bank Pricing Is Invalid');
  END IF;

  v_total_cost := v_unit_cost * p_quantity;
  v_reference := 'tbank_' || v_caller::text || '_' || p_request_id::text;

  IF v_total_cost > 0 THEN
    v_deduct := public.deduct_diamonds(
      p_user_id          := v_caller,
      p_amount           := v_total_cost,
      p_description      := 'Time Banks x' || p_quantity,
      p_transaction_type := 'feature_purchase',
      p_source           := 'feature_purchase',
      p_metadata         := jsonb_build_object(
                              'feature', 'time_bank_seconds',
                              'quantity', p_quantity,
                              'unit_cost', v_unit_cost,
                              'sink', 'time_bank',
                              'counterparty', 'revenue:feature_purchase',
                              'issuance_class', 'spend'),
      p_reference_id     := v_reference
    );

    IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', COALESCE(v_deduct->>'error', 'Diamond Charge Failed'),
        'required', v_total_cost
      );
    END IF;

    IF COALESCE((v_deduct->>'idempotent')::boolean, false) THEN
      v_result := jsonb_build_object(
        'success', true,
        'quantity', p_quantity,
        'unit_cost', v_unit_cost,
        'total_cost', 0,
        'original_total_cost', v_total_cost,
        'idempotent', true,
        'granted', false,
        'diamonds_remaining', (v_deduct->>'balance')::integer
      );
      INSERT INTO public.digital_purchase_receipts
        (user_id, request_id, purchase_kind, request_payload, result)
      VALUES
        (v_caller, p_request_id, 'time_bank', v_request_payload, v_result);
      RETURN v_result;
    END IF;
    v_balance := (v_deduct->>'balance')::integer;
  ELSE
    SELECT p.diamonds INTO v_balance
      FROM public.profiles p
     WHERE p.id = v_caller;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'User Not Found');
    END IF;
  END IF;

  INSERT INTO public.feature_purchases
    (user_id, feature, cost, usage_type, uses_remaining, expires_at)
  VALUES
    (v_caller, 'time_bank_seconds', v_total_cost, 'per_use', p_quantity, NULL);

  v_result := jsonb_build_object(
    'success', true,
    'quantity', p_quantity,
    'unit_cost', v_unit_cost,
    'total_cost', v_total_cost,
    'idempotent', false,
    'granted', true,
    'diamonds_remaining', v_balance
  );
  INSERT INTO public.digital_purchase_receipts
    (user_id, request_id, purchase_kind, request_payload, result)
  VALUES
    (v_caller, p_request_id, 'time_bank', v_request_payload, v_result);
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_purchase_time_banks_v2(integer, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_purchase_time_banks_v2(integer, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_purchase_time_banks_v2(integer, uuid)
  TO authenticated, service_role;

-- Rollout bridge for the already-published client. It preserves the old RPC
-- until the new client is live, while still protecting Lifetime members from a
-- Diamond debit. A follow-up migration tombstones this unkeyed signature after
-- production proves the v2 caller is active.
CREATE OR REPLACE FUNCTION public.fn_purchase_time_banks(p_quantity integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Authentication Required');
  END IF;

  RETURN public.fn_purchase_time_banks_v2(p_quantity, gen_random_uuid());
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_purchase_time_banks(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_purchase_time_banks(integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_purchase_time_banks(integer)
  TO authenticated, service_role;

-- The generic feature RPC is another public route to the same digital items.
-- Its Lifetime branch is deliberately an allowlist. Club creation is omitted,
-- and Table Studio/card-back SKUs retain their existing entitlement predicate,
-- so this cannot become a blanket bypass for a newly introduced product. The
-- v2 request UUID also makes a response-lost per-use purchase retry converge
-- on the original wallet receipt instead of charging and granting it twice.
CREATE OR REPLACE FUNCTION public.fn_purchase_feature_v2(
  p_user_id uuid,
  p_feature text,
  p_request_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller            uuid := auth.uid();
  v_price             record;
  v_deduct            jsonb;
  v_expires           timestamptz;
  v_uses              integer;
  v_category          text;
  v_asset_id          text;
  v_is_customization  boolean := false;
  v_lifetime_included boolean := false;
  v_balance           integer;
  v_request_payload   jsonb := jsonb_build_object('feature', p_feature);
  v_cached_kind       text;
  v_cached_payload    jsonb;
  v_cached_result     jsonb;
  v_result            jsonb;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Authentication Required');
  END IF;
  IF p_user_id IS DISTINCT FROM v_caller THEN
    RETURN jsonb_build_object('success', false, 'error', 'Purchases Are Limited To Your Own Account');
  END IF;
  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Secure Request Id Required');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      'digital_purchase_request:' || v_caller::text || ':' || p_request_id::text,
      0
    )
  );

  SELECT r.purchase_kind, r.request_payload, r.result
    INTO v_cached_kind, v_cached_payload, v_cached_result
    FROM public.digital_purchase_receipts r
   WHERE r.user_id = v_caller
     AND r.request_id = p_request_id;

  IF FOUND THEN
    IF v_cached_kind IS DISTINCT FROM 'feature'
       OR v_cached_payload IS DISTINCT FROM v_request_payload
    THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'Request Id Already Used For Another Purchase',
        'code', 'REQUEST_ID_REUSED'
      );
    END IF;

    RETURN v_cached_result || jsonb_build_object(
      'cost', 0,
      'original_cost',
        COALESCE(
          (v_cached_result->>'original_cost')::integer,
          (v_cached_result->>'cost')::integer,
          0
        ),
      'idempotent', true,
      'granted', false
    );
  END IF;

  SELECT feature, diamond_cost, usage_type INTO v_price
    FROM public.feature_pricing
   WHERE feature = p_feature;
  IF v_price.feature IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Unknown Feature: ' || p_feature);
  END IF;
  IF v_price.diamond_cost < 0 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Feature Pricing Is Invalid');
  END IF;

  v_lifetime_included := public.sp_is_lifetime_vip(v_caller)
    AND p_feature = ANY(ARRAY[
      'rabbit_hunt',
      'time_bank_seconds',
      'throwable',
      'emoji_pack',
      'tag_pack',
      'show_stack_bb',
      'offline_protection',
      'auto_time_bank'
    ]::text[]);

  IF v_lifetime_included THEN
    SELECT p.diamonds INTO v_balance
      FROM public.profiles p
     WHERE p.id = v_caller;

    v_result := jsonb_build_object(
      'success', true,
      'included', true,
      'unlimited', v_price.usage_type = 'per_use',
      'source', 'lifetime_vip',
      'cost', 0,
      'usage_type', v_price.usage_type,
      'idempotent', false,
      'granted', false,
      'diamonds_remaining', v_balance
    );
    INSERT INTO public.digital_purchase_receipts
      (user_id, request_id, purchase_kind, request_payload, result)
    VALUES
      (v_caller, p_request_id, 'feature', v_request_payload, v_result);
    RETURN v_result;
  END IF;

  IF p_feature LIKE 'studio:%' THEN
    v_category := split_part(p_feature, ':', 2);
    v_asset_id := substring(p_feature from length('studio:' || v_category || ':') + 1);
    v_is_customization := v_category IN (
      'theme_id', 'table_id', 'button_id', 'background_id'
    ) AND COALESCE(v_asset_id, '') <> '';
  ELSIF p_feature LIKE 'card_back_%' THEN
    v_category := 'cards_id';
    v_asset_id := substring(p_feature from length('card_back_') + 1);
    v_is_customization := COALESCE(v_asset_id, '') <> '';
  END IF;

  IF v_is_customization AND v_price.usage_type = 'permanent' THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended('fn_purchase_feature:customization:' || v_caller::text, 0)
    );
  ELSE
    PERFORM pg_advisory_xact_lock(
      hashtextextended('fn_purchase_feature:' || v_caller::text || ':' || p_feature, 0)
    );
  END IF;

  IF v_price.usage_type IN ('permanent', 'per_session') THEN
    IF EXISTS (
      SELECT 1
        FROM public.feature_purchases
       WHERE user_id = v_caller
         AND feature = p_feature
         AND (expires_at IS NULL OR expires_at > now())
    ) THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'already_owned',
        'already_owned', true,
        'usage_type', v_price.usage_type,
        'ownership_source', 'purchase_receipt'
      );
    END IF;

    IF v_is_customization
       AND public.sp_theme_asset_is_owned(v_caller, v_category, v_asset_id)
    THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', 'already_owned',
        'already_owned', true,
        'usage_type', v_price.usage_type,
        'ownership_source', 'entitlement'
      );
    END IF;
  END IF;

  IF v_price.diamond_cost > 0 THEN
    v_deduct := public.deduct_diamonds(
      p_user_id          := v_caller,
      p_amount           := v_price.diamond_cost,
      p_description      := 'Feature purchase: ' || p_feature,
      p_transaction_type := 'feature_purchase',
      p_source           := 'feature_purchase',
      p_metadata         := jsonb_build_object('feature', p_feature),
      p_reference_id     := 'feat_' || v_caller::text || '_' || p_request_id::text
    );
    IF COALESCE((v_deduct->>'success')::boolean, false) = false THEN
      RETURN jsonb_build_object(
        'success', false,
        'error', COALESCE(v_deduct->>'error', 'Diamond Charge Failed')
      );
    END IF;

    -- deduct_diamonds deliberately deduplicates a repeated request receipt.
    -- Never turn that one debit into two grants after a response-lost retry.
    IF COALESCE((v_deduct->>'idempotent')::boolean, false) THEN
      v_result := jsonb_build_object(
        'success', true,
        'cost', 0,
        'original_cost', v_price.diamond_cost,
        'usage_type', v_price.usage_type,
        'idempotent', true,
        'granted', false,
        'diamonds_remaining', (v_deduct->>'balance')::integer
      );
      INSERT INTO public.digital_purchase_receipts
        (user_id, request_id, purchase_kind, request_payload, result)
      VALUES
        (v_caller, p_request_id, 'feature', v_request_payload, v_result);
      RETURN v_result;
    END IF;
    v_balance := (v_deduct->>'balance')::integer;
  ELSE
    SELECT p.diamonds INTO v_balance
      FROM public.profiles p
     WHERE p.id = v_caller;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error', 'User Not Found');
    END IF;
  END IF;

  v_uses := CASE v_price.usage_type WHEN 'per_use' THEN 1 ELSE NULL END;
  v_expires := CASE v_price.usage_type
    WHEN 'per_session' THEN now() + interval '8 hours'
    ELSE NULL
  END;

  INSERT INTO public.feature_purchases
    (user_id, feature, cost, usage_type, uses_remaining, expires_at)
  VALUES
    (v_caller, p_feature, v_price.diamond_cost, v_price.usage_type, v_uses, v_expires);

  v_result := jsonb_build_object(
    'success', true,
    'cost', v_price.diamond_cost,
    'usage_type', v_price.usage_type,
    'idempotent', false,
    'granted', true,
    'diamonds_remaining', v_balance
  );
  INSERT INTO public.digital_purchase_receipts
    (user_id, request_id, purchase_kind, request_payload, result)
  VALUES
    (v_caller, p_request_id, 'feature', v_request_payload, v_result);
  RETURN v_result;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_purchase_feature_v2(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_purchase_feature_v2(uuid, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_purchase_feature_v2(uuid, text, uuid)
  TO authenticated, service_role;

-- Rollout bridge for the already-published caller. It retains the old shape
-- while the keyed client publishes. The unkeyed shape is retired in a separate
-- post-deployment migration only after production verifies the v2 caller.
CREATE OR REPLACE FUNCTION public.fn_purchase_feature(
  p_user_id uuid,
  p_feature text,
  p_cost integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Authentication Required');
  END IF;

  RETURN public.fn_purchase_feature_v2(p_user_id, p_feature, gen_random_uuid());
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_purchase_feature(uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fn_purchase_feature(uuid, text, integer) FROM anon;
GRANT EXECUTE ON FUNCTION public.fn_purchase_feature(uuid, text, integer)
  TO authenticated, service_role;

DO $assertions$
DECLARE
  v_allowance text := pg_get_functiondef('public.fn_time_bank_allowance(uuid[])'::regprocedure);
  v_allowance_v2 text := pg_get_functiondef('public.fn_time_bank_allowance_v2(uuid[])'::regprocedure);
  v_throw text := pg_get_functiondef('public.fn_use_throwable_v2(text, uuid)'::regprocedure);
  v_rabbit text := pg_get_functiondef('public.fn_consume_rabbit_hunt_v2(uuid, uuid)'::regprocedure);
  v_rabbit_bridge text := pg_get_functiondef('public.fn_consume_rabbit_hunt(uuid)'::regprocedure);
  v_consume_bank text := pg_get_functiondef('public.fn_consume_time_bank(uuid, integer)'::regprocedure);
  v_buy_bank text := pg_get_functiondef('public.fn_purchase_time_banks_v2(integer, uuid)'::regprocedure);
  v_buy_feature text := pg_get_functiondef('public.fn_purchase_feature_v2(uuid, text, uuid)'::regprocedure);
BEGIN
  IF to_regclass('public.digital_purchase_receipts') IS NULL THEN
    RAISE EXCEPTION 'Digital purchase receipt ledger is missing';
  END IF;
  IF to_regclass('public.throwable_use_receipts') IS NULL THEN
    RAISE EXCEPTION 'Throwable receipt ledger is missing';
  END IF;
  IF NOT (
    SELECT c.relrowsecurity
      FROM pg_class c
     WHERE c.oid = 'public.digital_purchase_receipts'::regclass
  ) THEN
    RAISE EXCEPTION 'Digital purchase receipt ledger must have RLS enabled';
  END IF;
  IF NOT (
    SELECT c.relrowsecurity
      FROM pg_class c
     WHERE c.oid = 'public.throwable_use_receipts'::regclass
  ) THEN
    RAISE EXCEPTION 'Throwable receipt ledger must have RLS enabled';
  END IF;
  IF NOT EXISTS (
    SELECT 1
     FROM pg_policy p
     WHERE p.polrelid = 'public.digital_purchase_receipts'::regclass
       AND p.polname = 'digital_purchase_receipts_deny_browser'
       AND NOT p.polpermissive
       AND p.polcmd = '*'
       AND p.polroles = ARRAY[0]::oid[]
       AND pg_get_expr(p.polqual, p.polrelid) = 'false'
       AND pg_get_expr(p.polwithcheck, p.polrelid) = 'false'
  ) OR NOT EXISTS (
    SELECT 1
      FROM pg_policy p
     WHERE p.polrelid = 'public.throwable_use_receipts'::regclass
       AND p.polname = 'throwable_use_receipts_deny_browser'
       AND NOT p.polpermissive
       AND p.polcmd = '*'
       AND p.polroles = ARRAY[0]::oid[]
       AND pg_get_expr(p.polqual, p.polrelid) = 'false'
       AND pg_get_expr(p.polwithcheck, p.polrelid) = 'false'
  ) THEN
    RAISE EXCEPTION 'A private receipt ledger has no explicit deny policy';
  END IF;
  IF has_table_privilege('authenticated', 'public.digital_purchase_receipts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.digital_purchase_receipts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.digital_purchase_receipts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.digital_purchase_receipts', 'DELETE')
     OR has_table_privilege('anon', 'public.digital_purchase_receipts', 'SELECT')
     OR has_table_privilege('anon', 'public.digital_purchase_receipts', 'INSERT')
     OR has_table_privilege('anon', 'public.digital_purchase_receipts', 'UPDATE')
     OR has_table_privilege('anon', 'public.digital_purchase_receipts', 'DELETE')
     OR has_table_privilege('authenticated', 'public.throwable_use_receipts', 'SELECT')
     OR has_table_privilege('authenticated', 'public.throwable_use_receipts', 'INSERT')
     OR has_table_privilege('authenticated', 'public.throwable_use_receipts', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.throwable_use_receipts', 'DELETE')
     OR has_table_privilege('anon', 'public.throwable_use_receipts', 'SELECT')
     OR has_table_privilege('anon', 'public.throwable_use_receipts', 'INSERT')
     OR has_table_privilege('anon', 'public.throwable_use_receipts', 'UPDATE')
     OR has_table_privilege('anon', 'public.throwable_use_receipts', 'DELETE')
  THEN
    RAISE EXCEPTION 'A private receipt ledger became browser-readable or writable';
  END IF;
  IF NOT has_table_privilege('service_role', 'public.digital_purchase_receipts', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.digital_purchase_receipts', 'INSERT')
     OR has_table_privilege('service_role', 'public.digital_purchase_receipts', 'UPDATE')
     OR has_table_privilege('service_role', 'public.digital_purchase_receipts', 'DELETE')
     OR NOT has_table_privilege('service_role', 'public.throwable_use_receipts', 'SELECT')
     OR NOT has_table_privilege('service_role', 'public.throwable_use_receipts', 'INSERT')
     OR has_table_privilege('service_role', 'public.throwable_use_receipts', 'UPDATE')
     OR has_table_privilege('service_role', 'public.throwable_use_receipts', 'DELETE')
  THEN
    RAISE EXCEPTION 'Service role receipt access is missing or not append-only';
  END IF;
  IF has_function_privilege('authenticated', 'public.sp_is_lifetime_vip(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Lifetime VIP helper must remain private';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fn_use_throwable_v2(text, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_use_throwable(text)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'Authenticated players lost throwable access';
  END IF;
  IF has_function_privilege('authenticated', 'public.fn_consume_rabbit_hunt_v2(uuid, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_consume_rabbit_hunt(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fn_consume_time_bank(uuid, integer)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'An engine-only consumable sink became client callable';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fn_consume_rabbit_hunt_v2(uuid, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fn_consume_rabbit_hunt(uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'Rabbit Hunt engine access is incomplete';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fn_time_bank_allowance_v2(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_time_bank_allowance(uuid[])', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_purchase_time_banks_v2(integer, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_purchase_time_banks(integer)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fn_purchase_feature_v2(uuid, text, uuid)', 'EXECUTE')
  THEN
    RAISE EXCEPTION 'Authenticated Time Bank access is incomplete';
  END IF;
  IF position('p.id = auth.uid()' IN v_allowance) = 0
     OR position('vip_tier = ''lifetime''' IN v_allowance) = 0
     OR position('m.user_id IN (SELECT vip.id FROM vip)' IN v_allowance_v2) = 0
     OR position('fp.user_id IN (SELECT vip.id FROM vip)' IN v_allowance_v2) = 0
     OR position('1500 milliseconds' IN v_throw) = 0
     OR position('RATE_LIMITED' IN v_throw) = 0
     OR position('lifetime_vip' IN v_throw) = 0
     OR position('deduct_diamonds' IN v_throw) = 0
     OR position('throwable_use_receipts' IN v_throw) = 0
     OR position('p_request_id' IN v_throw) = 0
     OR position('consumed' IN v_throw) = 0
     OR position('lifetime_vip' IN v_rabbit) = 0
     OR position('deduct_diamonds' IN v_rabbit) = 0
     OR position('digital_purchase_receipts' IN v_rabbit) = 0
     OR position('digital_purchase_request:' IN v_rabbit) = 0
     OR position('p_request_id' IN v_rabbit) = 0
     OR position('consumed' IN v_rabbit) = 0
     OR position('fn_consume_rabbit_hunt_v2' IN v_rabbit_bridge) = 0
     OR position('gen_random_uuid' IN v_rabbit_bridge) = 0
     OR position('lifetime_vip' IN v_consume_bank) = 0
     OR position('FOR UPDATE' IN v_consume_bank) = 0
     OR position('lifetime_vip' IN v_buy_bank) = 0
     OR position('deduct_diamonds' IN v_buy_bank) = 0
     OR position('pg_advisory_xact_lock' IN v_buy_bank) = 0
     OR position('p_request_id' IN v_buy_bank) = 0
     OR position('digital_purchase_receipts' IN v_buy_bank) = 0
     OR position('v_request_payload' IN v_buy_bank) = 0
     OR position('clock_timestamp' IN v_buy_bank) > 0
     OR position('v_lifetime_included' IN v_buy_feature) = 0
     OR position('deduct_diamonds' IN v_buy_feature) = 0
     OR position('v_deduct->>''idempotent''' IN v_buy_feature) = 0
     OR position('pg_advisory_xact_lock' IN v_buy_feature) = 0
     OR position('p_request_id' IN v_buy_feature) = 0
     OR position('digital_purchase_receipts' IN v_buy_feature) = 0
     OR position('v_request_payload' IN v_buy_feature) = 0
     OR position('date_trunc' IN v_buy_feature) > 0
     OR position('club_creation' IN v_buy_feature) > 0
  THEN
    RAISE EXCEPTION 'A Lifetime bypass or ordinary paid path is missing';
  END IF;
END;
$assertions$;

COMMIT;
