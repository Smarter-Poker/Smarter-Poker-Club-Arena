-- 20260909232326_the_exact_refund_authority_is_a_money_path_r3_recognises.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- R3 (fn_ca_money_path_log, mode 'refuse' since 2026-09-03) admits a
-- tournament-category wallet credit only when app.money_path names
-- fn_settle_tournament_obligation or fn_settle_satellite_tournament. On
-- 2026-09-09 16:56 UTC (20260909165629) refunds moved OUT of
-- fn_settle_tournament_obligation - it now answers every refund with
-- exact_refund_authority_required - and INTO fn_settle_tournament_refund_exact,
-- which stamps app.ca_exact_refund_token around its one wallet_transactions
-- insert and never sets app.money_path. Nobody told R3. Measured live at
-- 23:05 UTC in a rolled-back probe: atomic_cancel_tournament on a paid event
-- (0fac7473, a 1.00 refund) is refused with
--   R3: a refund credit of 1.00 was written outside
--   fn_settle_tournament_obligation (money_path=<none>, ...)
-- so since 16:56 no paid tournament on this platform can be cancelled and
-- refunded. Only one cancellation had been recorded in the 24 hours before.
--
-- THE FIX, AT THE ROOT: R3 recognises the exact refund authority by the
-- evidence that authority leaves - the authorization row that
-- fn_settle_tournament_refund_exact books BEFORE its insert and that
-- fn_ca_escrow_on_wallet_tx (trigger zz_, after R3's trg_) consumes AFTER it.
-- The row must name the same tournament, the same player and the same amount
-- as the credit being written. A GUC alone is not accepted: the token has to
-- be on the books. Every other branch of the function is byte-identical.
--
-- No mode flip, no repair job, no compensating write (CLAUDE.md 10.12). The
-- damage this refusal did - nineteen MTTs stuck REGISTERING with launch
-- receipts that never completed, all-horse rosters, 3,604.50 in buy-ins held
-- - is settled through atomic_cancel_tournament, the platform's own idempotent
-- cancellation path, one event per transaction, and each cancellation writes
-- its own tournament_cancellation_receipts row. See
-- docs/changelog/2026-09-09-a-legacy-horse-id-is-still-a-player.md.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_ca_money_path_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_path text;
  v_cat  text;
  v_mode text;
  v_exact_refund_token uuid;
BEGIN
  v_path := COALESCE(current_setting('app.money_path', true), '');
  IF v_path IN (
       'fn_settle_tournament_obligation',
       'fn_settle_satellite_tournament') THEN
    RETURN NEW;
  END IF;

  v_cat := lower(COALESCE(NEW.category, ''));

  -- The exact refund authority (fn_settle_tournament_refund_exact, the only
  -- payer of a tournament refund since 20260909165629) books an authorization
  -- row before its insert and stamps its token in app.ca_exact_refund_token;
  -- the escrow trigger consumes that row after this one fires. The credit is
  -- authorized when the row on the books names this tournament, this player
  -- and this amount. A token with no row is not an authority.
  IF v_cat = 'refund' THEN
    BEGIN
      v_exact_refund_token :=
        NULLIF(current_setting('app.ca_exact_refund_token', true), '')::uuid;
    EXCEPTION WHEN OTHERS THEN
      v_exact_refund_token := NULL;
    END;
    IF v_exact_refund_token IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.tournament_refund_authorizations a
       WHERE a.token = v_exact_refund_token
         AND a.tournament_id = NEW.related_entity_id
         AND a.user_id = NEW.user_id
         AND round(a.amount_paid_now, 2) = round(NEW.amount, 2)
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- The mode is data, so the way back is an UPDATE and not a deploy. A missing
  -- row means log: this guard never becomes stricter by accident.
  SELECT e.mode INTO v_mode FROM public.ca_money_path_enforcement e WHERE e.only_row;
  v_mode := COALESCE(v_mode, 'log');

  IF v_mode = 'refuse' THEN
    -- Nothing survives this raise, so the message carries the evidence: who
    -- wrote, from where, for how much, against which entity.
    RAISE EXCEPTION
      'R3: a % credit of % was written outside fn_settle_tournament_obligation (money_path=%, app=%, role=%, wallet_transactions.related_entity_id=%). Route it through fn_settle_tournament_obligation. To reopen the door: UPDATE public.ca_money_path_enforcement SET mode = ''log'';',
      COALESCE(NULLIF(v_cat, ''), '<none>'), NEW.amount, COALESCE(NULLIF(v_path, ''), '<none>'),
      COALESCE(NULLIF(current_setting('application_name', true), ''), '<none>'),
      session_user::text, NEW.related_entity_id
      USING ERRCODE = 'raise_exception';
  END IF;

  BEGIN
    INSERT INTO public.ca_money_path_violations
      (table_name, user_id, amount, category, description, related_entity_id,
       money_path, app_name, db_role)
    VALUES
      (TG_TABLE_NAME, NEW.user_id, NEW.amount, NEW.category, NEW.description,
       NEW.related_entity_id, NULLIF(v_path, ''),
       NULLIF(current_setting('application_name', true), ''),
       session_user::text);
  EXCEPTION WHEN OTHERS THEN
    -- The logger must never be the reason a credit fails.
    NULL;
  END;

  BEGIN
    -- Global scope (no entity dimension) so it files for every union; the
    -- tournament id travels in metadata only. INFO never pages.
    PERFORM public.fn_ca_raise_drift_incident(
      p_source         => 'r3_money_path_log',
      p_classification => 'unauthorized_adjustment',
      p_severity       => 'info',
      p_dedupe_key     => 'r3:' || v_cat || ':' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24'),
      p_discrepancy    => NEW.amount,
      p_layer          => 'settlement',
      p_entity_type    => 'wallet_transactions',
      p_entity_id      => NEW.id,
      p_suspected_cause => 'a tournament-category credit was written outside fn_settle_tournament_obligation (R3, log-only)',
      p_metadata       => jsonb_build_object('category', NEW.category, 'money_path', NULLIF(v_path, ''),
                            'related_entity_id', NEW.related_entity_id,
                            'app_name', NULLIF(current_setting('application_name', true), ''),
                            'session_user', session_user::text));
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END
$function$;

COMMENT ON FUNCTION public.fn_ca_money_path_log() IS
  'R3: a tournament-category wallet credit is admitted when app.money_path names the obligation or satellite settlement authority, or when it is the exact refund authority''s credit (an app.ca_exact_refund_token whose tournament_refund_authorizations row names this tournament, player and amount). Otherwise logged, or refused when ca_money_path_enforcement.mode = refuse.';

COMMIT;
