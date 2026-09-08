-- 20260908021452_diamond_rules_wired_for_refusal_and_the_money_paths_finished.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (Diamond Accounting Standard; docs/DIAMOND-RULINGS.md;
-- docs/DIAMOND-ACCOUNTING-ROADMAP.md phases 1 and 2; written 2026-09-08):
--
--   1. ca_diamond_rule_modes: every log-only rule that the rulings promise will become a
--      refusal (DR2, DR4, DR6, DR7 x2, DR8, DR20) now has ONE row saying whether it logs
--      or refuses, the earliest date it may flip (2026-09-14, seven days from the
--      rulings), and the clean-days requirement. The refusal code is wired into each
--      writer NOW, behind fn_ca_diamond_rule_mode(rule), so a flip is one call to
--      fn_ca_diamond_rule_flip, which asserts the rule has been clean (no non-info
--      incident on a player account) for the required days and refuses to flip early.
--      No rule flips on its own: 10.86 says a switch nobody watched is a switch that
--      lies; the flip is a migration a person reads.
--
--   2. The signup grant is issued by the Mint (ruling 17, roadmap 1.3). handle_new_user,
--      initialize_player_profile and heal_auth_integrity insert profiles holding 0 and
--      ask fn_ca_mint for 500 under the op id signup:<id> - the same op id
--      ensure-profile.js uses - so the grant is made exactly once whichever door a
--      player arrives through, and DR2 (balance born outside the Mint) can become a
--      refusal. fn_ca_mint gains the trigger door (the database's own triggers run with
--      auth.role() NULL) and records the op id as the journal reference; so does
--      fn_ca_burn.
--
--   3. Purchased lots are consumed FIFO at every sink (ruling 1) through
--      fn_ca_consume_purchase_lots, called by deduct_diamonds and by the negative path of
--      add_diamonds_to_balance. Open receivables are settled by the next positive credit,
--      oldest first (ruling 2), inside add_diamonds_to_balance, with their own journal row.
--
--   4. The trivia tournament cut is 10 percent rounded to the nearest diamond, minimum
--      one (ruling 8). Both daily-challenge claim writers stamp their class and
--      counterparty (the classifier was filling them and filing DR12 on every claim).
--      referral_milestone and referral_reward file under the referrals engine (ruling
--      15). DR5:deleted_with_balance files at info for certification cleanups.
--
--   5. The monthly budgets are restated to keep the platform-wide 250,000 after two
--      engines appeared since ruling 18 (wheel, club_arena_daily): see the UPDATEs.
--
-- Every function change is an apply-time patch of the LIVE body: the migration re-reads
-- pg_get_functiondef and aborts unless each marker occurs exactly the expected number of
-- times, so a body another agent changed underneath is never half-patched. One
-- transaction, one schema reload (CLAUDE.md section 2, production DDL policy).
--
-- Probed first in a rolled-back transaction (docs/changelog/2026-09-08-diamond-rules-wired.md
-- carries the transcript): a synthetic signup is born with 0 and receives 500 from the
-- Mint with one register row and one journal row; a receivable of 120 is settled by a
-- credit of 100 then 50; a purchased lot is consumed FIFO by a debit; DR4, DR6 and DR7
-- refuse when flipped and log when not; a cs_test_ session is refused when DR20 is
-- flipped; fn_ca_diamond_rule_flip refuses to flip before flip_after.

BEGIN;

-- ---------------------------------------------------------------------------
-- 0. The apply-time patcher (pg_temp: gone with the session, never in public).
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.ca_patch(p_fn text, p_from text, p_to text, p_expected integer DEFAULT 1)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_def text; v_n integer; v_procs integer;
BEGIN
  SELECT count(*) INTO v_procs FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  IF v_procs <> 1 THEN
    RAISE EXCEPTION 'ca_patch: % has % overloads in public (expected exactly 1)', p_fn, v_procs;
  END IF;
  SELECT pg_get_functiondef(p.oid) INTO v_def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = p_fn;
  v_n := (length(v_def) - length(replace(v_def, p_from, ''))) / length(p_from);
  IF v_n <> p_expected THEN
    RAISE EXCEPTION 'ca_patch: marker in % found % times, expected %: %', p_fn, v_n, p_expected, left(p_from, 120);
  END IF;
  EXECUTE replace(v_def, p_from, p_to);
END $$;

-- ---------------------------------------------------------------------------
-- 1. Rule modes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ca_diamond_rule_modes (
  rule                text PRIMARY KEY,
  mode                text NOT NULL DEFAULT 'log' CHECK (mode IN ('log', 'refuse')),
  flip_after          timestamptz NOT NULL,
  clean_days_required integer NOT NULL DEFAULT 7 CHECK (clean_days_required >= 0),
  flipped_at          timestamptz,
  flipped_by          text,
  ruling              text,
  note                text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.ca_diamond_rule_modes IS
  'Diamond Accounting Standard: whether each promised-to-refuse rule logs or refuses. Flip with fn_ca_diamond_rule_flip, never by hand (docs/DIAMOND-RULINGS.md ruling 17).';
ALTER TABLE public.ca_diamond_rule_modes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ca_diamond_rule_modes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_diamond_rule_modes TO service_role;

INSERT INTO public.ca_diamond_rule_modes (rule, mode, flip_after, clean_days_required, ruling, note) VALUES
  ('DR2:balance_born_outside_the_mint',        'log', '2026-09-14 00:00:00+00', 7, '17',
   'Refuse a profile INSERT carrying a balance on a player account once every seeder inserts 0 and lets the Mint grant (this migration converts handle_new_user, initialize_player_profile, heal_auth_integrity). Fixtures are never refused.'),
  ('DR4:credit_without_reference',             'log', '2026-09-14 00:00:00+00', 7, '17',
   'Refuse a positive credit with no reference id in add_diamonds_to_balance.'),
  ('DR6:balance_changed_without_journal',      'log', '2026-09-14 00:00:00+00', 7, '17',
   'Refuse an unsanctioned write to profiles.diamonds on a player account (fn_ca_audit_diamond_change). Fixtures are filed at info, never refused.'),
  ('DR7:engine_over_budget',                   'log', '2026-09-14 00:00:00+00', 7, '17, 18',
   'Refuse promotional issuance that takes an engine over its monthly budget (fn_ca_diamond_earn_ledger raises; the writer''s transaction rolls back).'),
  ('DR7:user_over_daily_cap',                  'log', '2026-09-14 00:00:00+00', 7, '17, 18',
   'Refuse promotional issuance that takes a player over the engine''s daily cap.'),
  ('DR8:purchase_price_disagrees_with_package','log', '2026-09-14 00:00:00+00', 7, '17',
   'Refuse a settlement whose purchase row disagrees with diamond_packages (settle_diamond_card_purchase_atomic returns settlement_refused; the row records it).'),
  ('DR7:test_mode_session_settled',            'log', '2026-09-14 00:00:00+00', 7, '20',
   'Refuse a cs_test_ session settling live diamonds.')
ON CONFLICT (rule) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_rule_mode(p_rule text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((SELECT m.mode FROM public.ca_diamond_rule_modes m WHERE m.rule = p_rule), 'log');
$$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_rule_mode(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_rule_mode(text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_ca_diamond_rule_flip(p_rule text, p_by text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_row public.ca_diamond_rule_modes%ROWTYPE; v_dirty integer;
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role' AND current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'fn_ca_diamond_rule_flip: service_role required';
  END IF;
  SELECT * INTO v_row FROM public.ca_diamond_rule_modes WHERE rule = p_rule FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fn_ca_diamond_rule_flip: unknown rule %', p_rule;
  END IF;
  IF v_row.mode = 'refuse' THEN
    RETURN jsonb_build_object('ok', true, 'rule', p_rule, 'mode', 'refuse', 'already', true);
  END IF;
  IF now() < v_row.flip_after THEN
    RAISE EXCEPTION 'fn_ca_diamond_rule_flip: % may not flip before %', p_rule, v_row.flip_after;
  END IF;
  SELECT count(*) INTO v_dirty
    FROM public.ca_diamond_incidents i
   WHERE i.rule = p_rule AND i.severity <> 'info'
     AND i.occurred_at >= now() - make_interval(days => v_row.clean_days_required);
  IF v_dirty > 0 THEN
    RAISE EXCEPTION 'fn_ca_diamond_rule_flip: % has % non-info incidents in the last % days; not clean',
      p_rule, v_dirty, v_row.clean_days_required;
  END IF;
  UPDATE public.ca_diamond_rule_modes
     SET mode = 'refuse', flipped_at = now(), flipped_by = p_by, updated_at = now()
   WHERE rule = p_rule;
  RETURN jsonb_build_object('ok', true, 'rule', p_rule, 'mode', 'refuse', 'flipped_by', p_by);
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_diamond_rule_flip(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_diamond_rule_flip(text, text) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. FIFO consumption of purchased lots (ruling 1). Never refuses a spend: a lot
--    that cannot be written files DR9 and the spend stands.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_consume_purchase_lots(p_user_id uuid, p_amount bigint)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_left bigint := COALESCE(p_amount, 0); v_lot record; v_take bigint; v_consumed bigint := 0;
BEGIN
  IF v_left <= 0 THEN RETURN 0; END IF;
  BEGIN
    FOR v_lot IN
      SELECT l.id, (l.issued - l.consumed - l.refunded) AS avail
        FROM public.diamond_purchase_lots l
       WHERE l.user_id = p_user_id AND l.frozen_at IS NULL
         AND (l.issued - l.consumed - l.refunded) > 0
       ORDER BY l.created_at, l.id
       FOR UPDATE
    LOOP
      EXIT WHEN v_left <= 0;
      v_take := LEAST(v_lot.avail, v_left);
      UPDATE public.diamond_purchase_lots SET consumed = consumed + v_take WHERE id = v_lot.id;
      v_left := v_left - v_take;
      v_consumed := v_consumed + v_take;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    BEGIN
      PERFORM public.fn_ca_diamond_incident('DR9:purchase_lot_write_failed', 'critical', p_user_id, p_amount,
        'fn_ca_consume_purchase_lots', jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN v_consumed;
END $$;
REVOKE ALL ON FUNCTION public.fn_ca_consume_purchase_lots(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_consume_purchase_lots(uuid, bigint) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. DR2 refusal on the born-with-balance door (full body: the function is small and
--    the refusal has to sit OUTSIDE its exception handlers).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_born_with_balance()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_fixture boolean := false;
BEGIN
  BEGIN
    v_fixture := public.fn_ca_is_fixture_account(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    v_fixture := false;
  END;
  -- DR2 (DIAMOND-RULINGS 17): once flipped, a player profile may not be born holding
  -- diamonds; every seeder inserts 0 and the Mint grants under signup:<id>. Fixtures are
  -- filed at info and never refused. The raise is outside the handlers below on purpose.
  IF NOT v_fixture AND public.fn_ca_diamond_rule_mode('DR2:balance_born_outside_the_mint') = 'refuse' THEN
    RAISE EXCEPTION 'DR2: a profile may not be born holding % diamonds; insert 0 and let fn_ca_mint grant under signup:<id>', NEW.diamonds
      USING ERRCODE = 'P0402';
  END IF;
  BEGIN
    PERFORM public.fn_ca_diamond_incident(
      'DR2:balance_born_outside_the_mint',
      CASE WHEN v_fixture THEN 'info' ELSE 'warning' END,
      NEW.id, NEW.diamonds, 'profiles INSERT',
      jsonb_build_object('is_horse', NEW.is_horse, 'is_fixture', v_fixture,
                         'app_name', COALESCE(current_setting('application_name', true), ''),
                         'db_role', CURRENT_USER, 'username', NEW.username, 'diamonds', NEW.diamonds));
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_ca_diamond_born_with_balance could not record the incident for %: %', NEW.id, SQLERRM;
  END;
  BEGIN
    INSERT INTO public.ca_mint_ledger
      (op_id, action, asset, holder_type, holder_id, holder_label, amount, balance_before, balance_after,
       supply_after, reason, performed_by, performed_by_label)
    VALUES
      ('seed:' || NEW.id::text, 'mint', 'diamonds', 'player', NEW.id,
       COALESCE(NULLIF(BTRIM(NEW.username), ''), NEW.id::text), NEW.diamonds, 0, NEW.diamonds,
       public.fn_ca_mint_supply('diamonds') + NEW.diamonds,
       CASE WHEN v_fixture THEN 'balance present at fixture profile INSERT' ELSE 'balance present at profile INSERT' END,
       NULL, 'zz_ca_diamond_born_with_balance')
    ON CONFLICT (op_id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'fn_ca_diamond_born_with_balance could not register the seed for %: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Apply-time patches of the live bodies (built from the bodies as read on
--    2026-09-08 02:20 UTC; each marker must match exactly once, or as stated).
-- ---------------------------------------------------------------------------
SELECT pg_temp.ca_patch('fn_ca_mint', $ca_from$  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    SELECT EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.id = v_actor AND p.role IN ('admin', 'god')) INTO v_admin;$ca_from$, $ca_to$  -- The trigger door (2026-09-08, DIAMOND-RULINGS 17 / roadmap 1.3): handle_new_user and the
  -- other seeders fire inside a trigger owned by the database itself, where auth.role() is
  -- NULL. The database's own code may mint; a browser never reaches this branch because a
  -- SECURITY DEFINER trigger runs as the owner and a client session is never at depth > 0.
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT (pg_trigger_depth() > 0
              AND current_user IN ('postgres', 'supabase_admin', 'supabase_auth_admin')) THEN
    SELECT EXISTS (SELECT 1 FROM public.profiles p
                    WHERE p.id = v_actor AND p.role IN ('admin', 'god')) INTO v_admin;$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_mint', $ca_from$      INSERT INTO public.diamond_transactions
        (user_id, type, transaction_type, amount, balance_after, description, source,
         metadata, counterparty, issuance_class)
      VALUES (p_target_id, 'earn', 'mint', p_amount, v_after,
              'The Mint: ' || v_reason, 'the_mint',
              jsonb_build_object('minted_by', v_actor, 'op_id', p_op_id),
              'issuance', v_class)
      RETURNING id INTO v_dia_id;$ca_from$, $ca_to$      -- The op id is the journal reference (DR4: a credit carries its reference), so the earn
      -- ledger files a promotional mint under its engine by prefix (signup: -> signup).
      INSERT INTO public.diamond_transactions
        (user_id, type, transaction_type, amount, balance_after, description, source,
         metadata, counterparty, issuance_class, reference_id)
      VALUES (p_target_id, 'earn', 'mint', p_amount, v_after,
              'The Mint: ' || v_reason, 'the_mint',
              jsonb_build_object('minted_by', v_actor, 'op_id', p_op_id),
              'issuance', v_class, p_op_id)
      RETURNING id INTO v_dia_id;$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_burn', $ca_from$      INSERT INTO public.diamond_transactions
        (user_id, type, transaction_type, amount, balance_after, description, source,
         metadata, counterparty, issuance_class)
      VALUES (p_target_id, 'spend', 'burn', -p_amount, v_after,
              'The Mint (retired): ' || v_reason, 'the_mint',
              jsonb_build_object('burned_by', v_actor, 'op_id', p_op_id),
              'retired', v_class)
      RETURNING id INTO v_dia_id;$ca_from$, $ca_to$      -- The op id is the journal reference (DR4), the same way fn_ca_mint records it.
      INSERT INTO public.diamond_transactions
        (user_id, type, transaction_type, amount, balance_after, description, source,
         metadata, counterparty, issuance_class, reference_id)
      VALUES (p_target_id, 'spend', 'burn', -p_amount, v_after,
              'The Mint (retired): ' || v_reason, 'the_mint',
              jsonb_build_object('burned_by', v_actor, 'op_id', p_op_id),
              'retired', v_class, p_op_id)
      RETURNING id INTO v_dia_id;$ca_to$, 1);

SELECT pg_temp.ca_patch('handle_new_user', $ca_from$        next_player_num, 0, 500, 500, 1.0, 'Newcomer',$ca_from$, $ca_to$        next_player_num, 0, 0, 0, 1.0, 'Newcomer',$ca_to$, 1);

SELECT pg_temp.ca_patch('handle_new_user', $ca_from$        diamonds      = CASE WHEN profiles.diamonds IS NULL OR profiles.diamonds = 0 THEN 500 ELSE profiles.diamonds END,
        diamond_balance = CASE WHEN profiles.diamonds IS NULL OR profiles.diamonds = 0 THEN 500 ELSE profiles.diamonds END,
$ca_from$, $ca_to$$ca_to$, 1);

SELECT pg_temp.ca_patch('handle_new_user', $ca_from$    v_now_diamonds INTEGER;
$ca_from$, $ca_to$    v_now_diamonds INTEGER;
    v_grant JSONB;
$ca_to$, 1);

SELECT pg_temp.ca_patch('handle_new_user', $ca_from$    SELECT diamonds INTO v_now_diamonds FROM public.profiles WHERE id = NEW.id;

    -- THE SIGNUP GRANT IS JOURNALED ON BOTH PATHS (2026-09-03, Lane B).
    --
    -- The old guard was `COALESCE(v_prev_diamonds,0) = 0 AND v_now_diamonds = 500`,
    -- which is TRUE only when this function created the profile itself. The horse
    -- seeder inserts the profile ALREADY holding 500 about 2 ms before the
    -- auth.users row exists, so the ON CONFLICT path ran with v_prev_diamonds = 500
    -- and wrote nothing: 416 horses / 208,000 diamonds since 2026-09-01 with no row
    -- in any ledger. The human welcome INSERT in ensure-profile.js has the same
    -- shape.
    --
    --   prev 0 or NULL -> 500 : this function granted it. class 'promotional'.
    --   prev 500       -> 500 : it arrived with the profile.  class 'seeded'.
    --
    -- Deduped three ways so a re-auth can never double-journal: NOT EXISTS on the
    -- journal (by type OR by reference), NOT EXISTS on the register (by this
    -- user's signup: or seed: op_id - part 2's trigger may already have recorded
    -- the same 500 as it was born), and ca_mint_ledger.op_id UNIQUE underneath.
    -- The whole block is a nested BEGIN/EXCEPTION: a ledger failure files an
    -- incident and is swallowed, so it can NEVER block a signup.
    IF v_now_diamonds = 500 AND COALESCE(v_prev_diamonds, 0) IN (0, 500) THEN
        v_grant_class := CASE WHEN COALESCE(v_prev_diamonds, 0) = 500
                              THEN 'seeded' ELSE 'promotional' END;
        BEGIN
            INSERT INTO public.diamond_transactions
                (user_id, type, amount, balance_after, description, reference_id, source,
                 counterparty, issuance_class)
            SELECT NEW.id, 'signup_bonus', 500, 500,
                   'Signup Grant Journaled At Creation', 'signup:' || NEW.id::text,
                   'handle_new_user', 'issuance:signup', v_grant_class
            WHERE NOT EXISTS (
                SELECT 1 FROM public.diamond_transactions t
                 WHERE t.user_id = NEW.id
                   AND (t.type = 'signup_bonus'
                        OR t.reference_id = 'signup:' || NEW.id::text));

            INSERT INTO public.ca_mint_ledger
                (op_id, action, asset, holder_type, holder_id, holder_label, amount,
                 balance_before, balance_after, supply_after, reason,
                 performed_by, performed_by_label)
            SELECT 'signup:' || NEW.id::text, 'mint', 'diamonds', 'player', NEW.id,
                   COALESCE(NULLIF(BTRIM(generated_username), ''), NEW.id::text), 500,
                   COALESCE(v_prev_diamonds, 0), 500,
                   -- profiles already holds the 500 at this point; the register
                   -- does not, so the supply this row establishes is the register
                   -- plus this grant.
                   public.fn_ca_mint_supply('diamonds') + 500,
                   'signup grant', NULL, 'handle_new_user'
            WHERE NOT EXISTS (
                SELECT 1 FROM public.ca_mint_ledger m
                 WHERE m.op_id IN ('signup:' || NEW.id::text, 'seed:' || NEW.id::text))
            ON CONFLICT (op_id) DO NOTHING;
        EXCEPTION WHEN OTHERS THEN
            PERFORM public.fn_ca_diamond_incident(
                'DR2:signup_grant_not_journaled', 'critical', NEW.id, 500, 'handle_new_user',
                jsonb_build_object('sqlstate', SQLSTATE, 'sqlerrm', SQLERRM,
                                   'prev_diamonds', v_prev_diamonds,
                                   'now_diamonds', v_now_diamonds,
                                   'grant_class', v_grant_class));
        END;
    END IF;
$ca_from$, $ca_to$    SELECT diamonds INTO v_now_diamonds FROM public.profiles WHERE id = NEW.id;

    -- THE SIGNUP GRANT IS ISSUED BY THE MINT (2026-09-08, DIAMOND-RULINGS 17, roadmap 1.3).
    -- The profile is born holding 0 and the 500 arrive through fn_ca_mint under the op id
    -- signup:<id>, which fills the balance, journals (class promotional, reference signup:<id>)
    -- and registers in one call, and replays as a no-op. A profile that already carries a
    -- register row (seed: from the older born-with-balance door, or signup:) or a signup
    -- journal row is not granted again, so a re-auth of an existing player mints nothing.
    -- A refusal by the Mint (the diamond_issuance freeze) is filed as DR2:signup_grant_refused;
    -- ensure-profile.js re-asks the Mint for the same op id on the next login, so the live path
    -- restarts from its own record and no back-pay job exists (CLAUDE.md 10.12).
    IF NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger m
                    WHERE m.op_id IN ('signup:' || NEW.id::text, 'seed:' || NEW.id::text))
       AND NOT EXISTS (SELECT 1 FROM public.diamond_transactions t
                        WHERE t.user_id = NEW.id
                          AND (t.type = 'signup_bonus'
                               OR t.reference_id = 'signup:' || NEW.id::text)) THEN
        BEGIN
            v_grant := public.fn_ca_mint('diamonds', 'player', NEW.id, 500, 'signup grant',
                                         'signup:' || NEW.id::text, 'promotional');
            IF COALESCE((v_grant ->> 'ok')::boolean, false) IS NOT TRUE
               AND COALESCE((v_grant ->> 'replayed')::boolean, false) IS NOT TRUE THEN
                PERFORM public.fn_ca_diamond_incident(
                    'DR2:signup_grant_refused', 'warning', NEW.id, 500, 'handle_new_user',
                    jsonb_build_object('result', v_grant, 'prev_diamonds', v_prev_diamonds,
                                       'now_diamonds', v_now_diamonds));
            END IF;
        EXCEPTION WHEN OTHERS THEN
            PERFORM public.fn_ca_diamond_incident(
                'DR2:signup_grant_not_journaled', 'critical', NEW.id, 500, 'handle_new_user',
                jsonb_build_object('sqlstate', SQLSTATE, 'sqlerrm', SQLERRM,
                                   'prev_diamonds', v_prev_diamonds,
                                   'now_diamonds', v_now_diamonds));
        END;
    END IF;
$ca_to$, 1);

SELECT pg_temp.ca_patch('initialize_player_profile', $ca_from$        500, 500, 1.0, 0,
$ca_from$, $ca_to$        0, 0, 1.0, 0,
$ca_to$, 1);

SELECT pg_temp.ca_patch('initialize_player_profile', $ca_from$        END,
        -- Only grant diamonds if user has none
        diamonds = CASE
            WHEN profiles.diamonds IS NULL OR profiles.diamonds = 0 THEN 500
            ELSE profiles.diamonds
        END;
$ca_from$, $ca_to$        END;

    -- The welcome 500 are issued by the Mint under signup:<id> (DIAMOND-RULINGS 17), never
    -- inserted into the row. Idempotent: a register row under signup: or seed: means the
    -- grant was already made by another door.
    IF NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger m
                    WHERE m.op_id IN ('signup:' || p_user_id::text, 'seed:' || p_user_id::text)) THEN
        PERFORM public.fn_ca_mint('diamonds', 'player', p_user_id, 500, 'signup grant',
                                  'signup:' || p_user_id::text, 'promotional');
    END IF;
$ca_to$, 1);

SELECT pg_temp.ca_patch('heal_auth_integrity', $ca_from$    healed_diamonds  int := 0;
$ca_from$, $ca_to$    healed_diamonds  int := 0;
    v_healed_ids     uuid[] := '{}';
    v_id             uuid;
$ca_to$, 1);

SELECT pg_temp.ca_patch('heal_auth_integrity', $ca_from$            500, 1.0, 0, 'Newcomer', 'Full_Access', true, 'monthly',
$ca_from$, $ca_to$            0, 1.0, 0, 'Newcomer', 'Full_Access', true, 'monthly',
$ca_to$, 1);

SELECT pg_temp.ca_patch('heal_auth_integrity', $ca_from$        ON CONFLICT (id) DO NOTHING
        RETURNING 1
    )
    SELECT count(*) INTO healed_profiles FROM inserted;
$ca_from$, $ca_to$        ON CONFLICT (id) DO NOTHING
        RETURNING id
    )
    SELECT count(*), COALESCE(array_agg(id), '{}') INTO healed_profiles, v_healed_ids FROM inserted;

    -- A healed profile is born holding 0; its welcome 500 come from the Mint under the same
    -- signup:<id> op id every other door uses (DIAMOND-RULINGS 17).
    FOREACH v_id IN ARRAY v_healed_ids LOOP
        IF NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger m
                        WHERE m.op_id IN ('signup:' || v_id::text, 'seed:' || v_id::text)) THEN
            PERFORM public.fn_ca_mint('diamonds', 'player', v_id, 500, 'signup grant',
                                      'signup:' || v_id::text, 'promotional');
        END IF;
    END LOOP;
$ca_to$, 1);

SELECT pg_temp.ca_patch('add_diamonds_to_balance', $ca_from$  v_counterparty text;
BEGIN
$ca_from$, $ca_to$  v_counterparty text;
  v_settled bigint := 0;
  v_settled_ids uuid[] := '{}';
  v_debt record;
  v_take bigint;
  v_settle_ref text;
BEGIN
$ca_to$, 1);

SELECT pg_temp.ca_patch('add_diamonds_to_balance', $ca_from$  SELECT COALESCE(diamonds, 0), COALESCE(diamond_multiplier, 1.00)
    INTO v_old_balance, v_multiplier
    FROM public.profiles WHERE id = p_user_id FOR UPDATE;
$ca_from$, $ca_to$  -- DR4 (DIAMOND-RULINGS 17): a positive credit without a reference is refused once the rule
  -- is flipped in ca_diamond_rule_modes. Until then it is journaled and filed below.
  IF COALESCE(p_amount, 0) > 0 AND p_reference_id IS NULL
     AND public.fn_ca_diamond_rule_mode('DR4:credit_without_reference') = 'refuse' THEN
    RETURN jsonb_build_object('success', false, 'error', 'reference_id_required',
                              'reference_required', true, 'refused_by', 'DR4:credit_without_reference');
  END IF;

  SELECT COALESCE(diamonds, 0), COALESCE(diamond_multiplier, 1.00)
    INTO v_old_balance, v_multiplier
    FROM public.profiles WHERE id = p_user_id FOR UPDATE;
$ca_to$, 1);

SELECT pg_temp.ca_patch('add_diamonds_to_balance', $ca_from$  UPDATE public.profiles
     SET diamonds = v_new_balance, diamond_balance = v_new_balance, updated_at = now()
   WHERE id = p_user_id;
$ca_from$, $ca_to$  -- DIAMOND-RULINGS 2: a chargeback the balance could not cover is a receivable, never a
  -- negative balance, and the next positive credit of any class settles open receivables
  -- oldest first before the player sees the rest. A debt larger than the credit is split:
  -- the paid part becomes its own settled row, the residual stays open.
  IF v_actual_amount > 0 THEN
    FOR v_debt IN
      SELECT d.id, d.amount FROM public.diamond_debts d
       WHERE d.user_id = p_user_id AND d.settled_at IS NULL
       ORDER BY d.created_at, d.id
       FOR UPDATE
    LOOP
      EXIT WHEN v_settled >= v_actual_amount;
      v_take := LEAST(v_debt.amount, v_actual_amount - v_settled);
      IF v_take >= v_debt.amount THEN
        UPDATE public.diamond_debts SET settled_at = now(), settled_by = 'add_diamonds_to_balance'
         WHERE id = v_debt.id;
      ELSE
        UPDATE public.diamond_debts SET amount = amount - v_take WHERE id = v_debt.id;
        INSERT INTO public.diamond_debts (user_id, purchase_id, amount, reason, created_at, settled_at, settled_by)
        SELECT d.user_id, d.purchase_id, v_take,
               d.reason || ' (partial settlement of ' || d.id::text || ')',
               d.created_at, now(), 'add_diamonds_to_balance'
          FROM public.diamond_debts d WHERE d.id = v_debt.id;
      END IF;
      v_settled := v_settled + v_take;
      v_settled_ids := v_settled_ids || v_debt.id;
    END LOOP;
  END IF;

  UPDATE public.profiles
     SET diamonds = v_new_balance - v_settled, diamond_balance = v_new_balance - v_settled, updated_at = now()
   WHERE id = p_user_id;
$ca_to$, 1);

SELECT pg_temp.ca_patch('add_diamonds_to_balance', $ca_from$    v_counterparty, v_issuance_class
  ) RETURNING id INTO v_txn_id;
$ca_from$, $ca_to$    v_counterparty, v_issuance_class
  ) RETURNING id INTO v_txn_id;

  IF v_settled > 0 THEN
    -- The settlement is its own journal row (class spend, counterparty the receivable), so the
    -- register retires what the reversed purchase had issued and the player's statement shows
    -- both the credit and what it paid off.
    v_settle_ref := 'debt-settlement:' || v_txn_id::text;
    INSERT INTO public.diamond_transactions (
      user_id, amount, transaction_type, type, description, balance_after, reference_id, metadata,
      counterparty, issuance_class
    ) VALUES (
      p_user_id, -v_settled, 'debt_settlement', 'debt_settlement',
      'Settled ' || v_settled::text || ' diamonds owed after a reversed purchase',
      v_new_balance - v_settled, v_settle_ref,
      jsonb_build_object('reference_id', v_settle_ref, 'credit_transaction_id', v_txn_id,
                         'settled_debt_ids', to_jsonb(v_settled_ids), 'raw_amount', -v_settled,
                         'multiplier', 1.00, 'exact_value', true),
      'receivable:diamond_debts', 'spend'
    );
  END IF;

  -- DIAMOND-RULINGS 1: a debit through this door consumes purchased lots first (FIFO).
  IF v_actual_amount < 0 THEN
    PERFORM public.fn_ca_consume_purchase_lots(p_user_id, -v_actual_amount);
  END IF;
$ca_to$, 1);

SELECT pg_temp.ca_patch('add_diamonds_to_balance', $ca_from$  RETURN jsonb_build_object('success', true, 'old_balance', v_old_balance, 'new_balance', v_new_balance,
                            'amount', v_actual_amount, 'multiplier', v_multiplier, 'transaction_id', v_txn_id);
$ca_from$, $ca_to$  RETURN jsonb_build_object('success', true, 'old_balance', v_old_balance,
                            'new_balance', v_new_balance - v_settled,
                            'amount', v_actual_amount, 'multiplier', v_multiplier, 'transaction_id', v_txn_id,
                            'debt_settled', v_settled);
$ca_to$, 1);

SELECT pg_temp.ca_patch('deduct_diamonds', $ca_from$     WHERE id = p_user_id
     RETURNING diamonds INTO v_new_balance;
$ca_from$, $ca_to$     WHERE id = p_user_id
     RETURNING diamonds INTO v_new_balance;

    -- DIAMOND-RULINGS 1: purchased lots are consumed FIFO before promotional balance at every
    -- sink, so a refund or chargeback knows what is left of what was paid for.
    PERFORM public.fn_ca_consume_purchase_lots(p_user_id, p_amount);
$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_audit_diamond_change', $ca_from$  v_cert boolean; v_fixture boolean; v_sanctioned boolean;
$ca_from$, $ca_to$  v_cert boolean; v_fixture boolean; v_sanctioned boolean; v_refuse boolean := false;
$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_audit_diamond_change', $ca_from$    IF v_delta <> 0 AND NOT v_journaled AND NOT v_sanctioned THEN
      PERFORM public.fn_ca_diamond_incident($ca_from$, $ca_to$    IF v_delta <> 0 AND NOT v_journaled AND NOT v_sanctioned THEN
      -- DR6 (DIAMOND-RULINGS 17): once flipped, an unsanctioned balance write on a player
      -- account is refused; fixtures are never refused, only filed at info.
      v_refuse := NOT v_fixture
                  AND public.fn_ca_diamond_rule_mode('DR6:balance_changed_without_journal') = 'refuse';
      PERFORM public.fn_ca_diamond_incident($ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_audit_diamond_change', $ca_from$    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN NEW;
END;$ca_from$, $ca_to$    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  IF v_refuse THEN
    RAISE EXCEPTION 'DR6: profiles.diamonds may only change through a sanctioned money path (writer %, delta %)',
      COALESCE(v_writer, v_path, '(no function frame)'), v_delta
      USING ERRCODE = 'P0406', HINT = 'Use add_diamonds_to_balance, deduct_diamonds, fn_ca_mint or fn_ca_burn.';
  END IF;
  RETURN NEW;
END;$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_diamond_earn_ledger', $ca_from$    v_cap integer; v_cap_vip integer; v_is_vip boolean := false; v_at timestamptz;
$ca_from$, $ca_to$    v_cap integer; v_cap_vip integer; v_is_vip boolean := false; v_at timestamptz;
    v_refuse text; v_refuse_detail text;
$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_diamond_earn_ledger', $ca_from$        IF v_spent > v_budget THEN
            PERFORM public.fn_ca_diamond_incident('DR7:engine_over_budget', 'warning', NEW.user_id, NEW.amount,$ca_from$, $ca_to$        IF v_spent > v_budget THEN
            IF public.fn_ca_diamond_rule_mode('DR7:engine_over_budget') = 'refuse' THEN
                v_refuse := 'DR7:engine_over_budget';
                v_refuse_detail := format('engine %s period %s budget %s spent %s', v_engine, v_period, v_budget, v_spent);
            END IF;
            PERFORM public.fn_ca_diamond_incident('DR7:engine_over_budget', 'warning', NEW.user_id, NEW.amount,$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_diamond_earn_ledger', $ca_from$        IF v_cap IS NOT NULL AND v_awarded > v_cap THEN
            PERFORM public.fn_ca_diamond_incident('DR7:user_over_daily_cap', 'warning', NEW.user_id, NEW.amount,$ca_from$, $ca_to$        IF v_cap IS NOT NULL AND v_awarded > v_cap THEN
            IF public.fn_ca_diamond_rule_mode('DR7:user_over_daily_cap') = 'refuse' THEN
                v_refuse := COALESCE(v_refuse, 'DR7:user_over_daily_cap');
                v_refuse_detail := COALESCE(v_refuse_detail, format('engine %s day %s cap %s awarded %s', v_engine, v_day, v_cap, v_awarded));
            END IF;
            PERFORM public.fn_ca_diamond_incident('DR7:user_over_daily_cap', 'warning', NEW.user_id, NEW.amount,$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_diamond_earn_ledger', $ca_from$            jsonb_build_object('sqlstate', SQLSTATE, 'sqlerrm', SQLERRM, 'journal_id', NEW.id, 'reference_id', NEW.reference_id));
    END;
    RETURN NULL;
END;$ca_from$, $ca_to$            jsonb_build_object('sqlstate', SQLSTATE, 'sqlerrm', SQLERRM, 'journal_id', NEW.id, 'reference_id', NEW.reference_id));
    END;
    -- DIAMOND-RULINGS 17/18: a flipped DR7 refuses the credit. Raising here aborts the writer's
    -- whole transaction (balance, journal, ledger rows), so nothing is issued and nothing is
    -- half-written. The incident above rolls back with it; the writer's error carries the reason.
    IF v_refuse IS NOT NULL THEN
        RAISE EXCEPTION '%: promotional issuance refused (%)', v_refuse, v_refuse_detail
            USING ERRCODE = 'P0407';
    END IF;
    RETURN NULL;
END;$ca_to$, 1);

SELECT pg_temp.ca_patch('settle_diamond_card_purchase_atomic', $ca_from$  v_pkg public.diamond_packages%ROWTYPE; v_pkg_found boolean := false;
$ca_from$, $ca_to$  v_pkg public.diamond_packages%ROWTYPE; v_pkg_found boolean := false;
  v_refuse text;
$ca_to$, 1);

SELECT pg_temp.ca_patch('settle_diamond_card_purchase_atomic', $ca_from$          'note', 'Stripe test-mode session credited real diamonds. Log-only by Dan risk rule 12.'));
    END IF;$ca_from$, $ca_to$          'note', 'Stripe test-mode session credited real diamonds. Log-only by Dan risk rule 12.'));
      -- DIAMOND-RULINGS 20: once flipped, a cs_test_ session never settles live diamonds.
      IF public.fn_ca_diamond_rule_mode('DR7:test_mode_session_settled') = 'refuse' THEN
        v_refuse := 'DR20:test_mode_session';
      END IF;
    END IF;$ca_to$, 1);

SELECT pg_temp.ca_patch('settle_diamond_card_purchase_atomic', $ca_from$      PERFORM public.fn_ca_diamond_incident(
        'DR8:purchase_price_disagrees_with_package', 'warning', v_purchase.user_id, v_total,$ca_from$, $ca_to$      IF public.fn_ca_diamond_rule_mode('DR8:purchase_price_disagrees_with_package') = 'refuse' THEN
        v_refuse := COALESCE(v_refuse, 'DR8:purchase_price_disagrees_with_package');
      END IF;
      PERFORM public.fn_ca_diamond_incident(
        'DR8:purchase_price_disagrees_with_package', 'warning', v_purchase.user_id, v_total,$ca_to$, 2);

SELECT pg_temp.ca_patch('settle_diamond_card_purchase_atomic', $ca_from$  v_credit := public.add_diamonds_to_balance(v_purchase.user_id, v_total, 'purchase',$ca_from$, $ca_to$  -- DIAMOND-RULINGS 17: a flipped DR8 or DR20 refuses the settlement. The purchase row keeps
  -- its status and records the refusal; no diamonds move; the webhook acknowledges the event
  -- so Stripe does not retry a decision that will not change, and a human sees the row.
  IF v_refuse IS NOT NULL THEN
    UPDATE public.diamond_purchases
       SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'settlement_refused_at', now(), 'settlement_refused_by', v_refuse,
             'settlement_refused_session', p_session_id,
             'settlement_refused_payment_intent', p_payment_intent_id),
           updated_at = now()
     WHERE id = v_purchase.id;
    RETURN jsonb_build_object('success', false, 'error', 'settlement_refused', 'refused_by', v_refuse,
      'purchase_id', v_purchase.id, 'diamonds', v_total);
  END IF;

  v_credit := public.add_diamonds_to_balance(v_purchase.user_id, v_total, 'purchase',$ca_to$, 1);

SELECT pg_temp.ca_patch('enter_trivia_tournament_v2', $ca_from$    v_net := v_fee - floor(v_fee*0.10)::int;
$ca_from$, $ca_to$    -- DIAMOND-RULINGS 8: the house cut is 10 percent rounded to the nearest diamond, at least
    -- one on any paid entry; never floored to zero and never burned by omission.
    v_net := CASE WHEN v_fee > 0 THEN v_fee - GREATEST(1, round(v_fee * 0.10))::int ELSE 0 END;
$ca_to$, 1);

SELECT pg_temp.ca_patch('claim_daily_challenges_serialized_body', $ca_from$      INSERT INTO public.diamond_transactions (
        user_id, amount, transaction_type, type, description,
        balance_after, metadata, reference_id, created_at
      ) VALUES ($ca_from$, $ca_to$      INSERT INTO public.diamond_transactions (
        user_id, amount, transaction_type, type, description,
        balance_after, metadata, reference_id, created_at, counterparty, issuance_class
      ) VALUES ($ca_to$, 1);

SELECT pg_temp.ca_patch('claim_daily_challenges_serialized_body', $ca_from$        'challenge_claim_batch:' || p_request_id::text || ':diamonds',
        now()
      );$ca_from$, $ca_to$        'challenge_claim_batch:' || p_request_id::text || ':diamonds',
        now(),
        'promo_budget:daily_challenges', 'earned'
      );$ca_to$, 1);

SELECT pg_temp.ca_patch('claim_daily_challenge_serialized_body', $ca_from$    INSERT INTO public.diamond_transactions (
      user_id, amount, transaction_type, type, description,
      balance_after, metadata, reference_id, created_at
    ) VALUES ($ca_from$, $ca_to$    INSERT INTO public.diamond_transactions (
      user_id, amount, transaction_type, type, description,
      balance_after, metadata, reference_id, created_at, counterparty, issuance_class
    ) VALUES ($ca_to$, 1);

SELECT pg_temp.ca_patch('claim_daily_challenge_serialized_body', $ca_from$      'challenge_claim:' || p_challenge_row_id::text || ':diamonds',
      now()
    );$ca_from$, $ca_to$      'challenge_claim:' || p_challenge_row_id::text || ':diamonds',
      now(),
      'promo_budget:daily_challenges', 'earned'
    );$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_journal_profile_deletion', $ca_from$        'DR5:deleted_with_balance', 'warning', OLD.id, OLD.diamonds, 'profiles DELETE',$ca_from$, $ca_to$        'DR5:deleted_with_balance',
        CASE WHEN COALESCE(v_reason, '') LIKE 'certification-cleanup:%'
               OR public.fn_ca_is_fixture_account(OLD.id) THEN 'info' ELSE 'warning' END,
        OLD.id, OLD.diamonds, 'profiles DELETE',$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_diamond_engine_of', $ca_from$                'referral_referee', 'referral_vip_conversion')             THEN 'referrals'$ca_from$, $ca_to$                'referral_referee', 'referral_vip_conversion',
                'referral_milestone', 'referral_reward')                    THEN 'referrals'$ca_to$, 1);

-- ---------------------------------------------------------------------------
-- 5. Budgets restated (ruling 18, amended 2026-09-08). Two engines appeared since the
--    ruling was written - wheel (50,000) and club_arena_daily (9.2e18, a placeholder
--    another agent set) - and the platform-wide envelope is 250,000 a month. The
--    envelope holds; the lines move: daily_challenges 100,000 -> 50,000 (0 spent in
--    September), signup 15,000 -> 25,000 (thirty grants a month was below the seven real
--    signups a week measured 2026-09-08), wheel 50,000 -> 30,000, club_arena_daily
--    -> 10,000. A new month inherits the latest period's budget per engine, so these
--    rows carry forward.
-- ---------------------------------------------------------------------------
UPDATE public.diamond_reward_budgets SET budget_diamonds = 50000,  updated_at = now() WHERE period = '2026-09' AND engine = 'daily_challenges';
UPDATE public.diamond_reward_budgets SET budget_diamonds = 25000,  updated_at = now() WHERE period = '2026-09' AND engine = 'signup';
UPDATE public.diamond_reward_budgets SET budget_diamonds = 30000,  updated_at = now() WHERE period = '2026-09' AND engine = 'wheel';
UPDATE public.diamond_reward_budgets SET budget_diamonds = 10000,  updated_at = now() WHERE period = '2026-09' AND engine = 'club_arena_daily';
INSERT INTO public.diamond_reward_budgets (period, engine, budget_diamonds, spent_diamonds)
VALUES ('2026-09', 'wheel', 30000, 0), ('2026-09', 'club_arena_daily', 10000, 0)
ON CONFLICT (period, engine) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 6. Assertions: the transaction aborts if any of these is false.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n integer; v_body text; v_total bigint;
BEGIN
  SELECT count(*) INTO v_n FROM public.ca_diamond_rule_modes WHERE mode = 'log';
  IF v_n < 7 THEN RAISE EXCEPTION 'rule modes: expected 7 log rows, found %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM public.ca_diamond_rule_modes WHERE mode = 'refuse') THEN
    RAISE EXCEPTION 'rule modes: nothing may be in refuse mode at apply time';
  END IF;

  SELECT pg_get_functiondef('public.handle_new_user()'::regprocedure) INTO v_body;
  IF v_body LIKE '%0, 500, 500, 1.0%' OR v_body NOT LIKE '%fn_ca_mint(''diamonds'', ''player'', NEW.id, 500%' THEN
    RAISE EXCEPTION 'handle_new_user: still inserts 500 or does not mint';
  END IF;
  IF v_body LIKE '%profiles.diamonds = 0 THEN 500%' THEN
    RAISE EXCEPTION 'handle_new_user: ON CONFLICT still grants 500';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_mint';
  IF v_body NOT LIKE '%pg_trigger_depth() > 0%' OR v_body NOT LIKE '%''issuance'', v_class, p_op_id)%' THEN
    RAISE EXCEPTION 'fn_ca_mint: trigger door or journal reference missing';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'add_diamonds_to_balance';
  IF v_body NOT LIKE '%DR4:credit_without_reference'') = ''refuse''%'
     OR v_body NOT LIKE '%debt-settlement:%' OR v_body NOT LIKE '%fn_ca_consume_purchase_lots%' THEN
    RAISE EXCEPTION 'add_diamonds_to_balance: DR4 refusal, debt settlement or lot consumption missing';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'deduct_diamonds';
  IF v_body NOT LIKE '%fn_ca_consume_purchase_lots(p_user_id, p_amount)%' THEN
    RAISE EXCEPTION 'deduct_diamonds: lot consumption missing';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_audit_diamond_change';
  IF v_body NOT LIKE '%ERRCODE = ''P0406''%' THEN RAISE EXCEPTION 'DR6 refusal missing'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_ca_diamond_earn_ledger';
  IF v_body NOT LIKE '%ERRCODE = ''P0407''%' THEN RAISE EXCEPTION 'DR7 refusal missing'; END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'settle_diamond_card_purchase_atomic';
  IF v_body NOT LIKE '%''settlement_refused''%' OR v_body NOT LIKE '%DR20:test_mode_session%' THEN
    RAISE EXCEPTION 'DR8/DR20 refusal missing';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_body FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'enter_trivia_tournament_v2';
  IF v_body NOT LIKE '%GREATEST(1, round(v_fee * 0.10))%' THEN RAISE EXCEPTION 'trivia cut rounding missing'; END IF;

  FOR v_body IN SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname IN ('claim_daily_challenge_serialized_body', 'claim_daily_challenges_serialized_body') LOOP
    IF v_body NOT LIKE '%''promo_budget:daily_challenges'', ''earned''%' THEN
      RAISE EXCEPTION 'a daily challenge writer still leaves its class NULL';
    END IF;
  END LOOP;

  SELECT sum(budget_diamonds) INTO v_total FROM public.diamond_reward_budgets
   WHERE period = '2026-09' AND engine NOT IN ('cert_fixture', 'legacy_credit', 'mint', 'other', 'unclassified', 'union_grant');
  IF v_total <> 250000 THEN
    RAISE EXCEPTION 'ruling 18: the September budget lines sum to %, not 250000', v_total;
  END IF;
END $$;

COMMIT;
