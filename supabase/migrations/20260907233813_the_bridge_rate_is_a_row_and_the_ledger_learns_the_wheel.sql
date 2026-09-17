-- 20260907233813_the_bridge_rate_is_a_row_and_the_ledger_learns_the_wheel.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- Dan's ruling, 2026-09-07: ONE DIAMOND IS ONE CENT AND ONE CHIP IS ONE DOLLAR,
-- so one hundred diamonds buy one chip. The live owner bridge,
-- fn_mint_chips_from_diamonds, carried the rate the other way round as a
-- literal in its body: `v_chips := v_diamonds * 100; -- THE RATE: 100 diamonds
-- = 10,000 chips`. That is ten thousand times too generous - one cent of
-- diamonds minted one hundred dollars of chips. It is owner-only and fired
-- three times in its life (3 diamonds became 300 chips), so the damage is
-- thirty-three cents of diamonds against three hundred dollars of chips, all
-- of it on 2026-08-21 and all of it already inside the acknowledged baseline.
-- Nothing is clawed back (CLAUDE.md 10.9: nothing is taken back from a player
-- for our mistake); the function is corrected forward.
--
-- The rate becomes A ROW, ca_bridge_rate, read by fn_ca_bridge_rate(), so the
-- bridge and the Diamond Wheel (the next migration) can never disagree, and
-- every change to it is a history row with the actor and a reason. This closes
-- Diamond Accounting Standard decision 7.
--
-- Two smaller things ride along because the wheel needs them and each is a
-- vocabulary word rather than behaviour (the chip_ledger word 'wheel_prize' is
-- its own migration, 20260907235112: the first attempt to take the ACCESS
-- EXCLUSIVE lock on chip_ledger inside this larger transaction deadlocked
-- against live play, 40P01, and rolled back cleanly - one hot table, one
-- transaction, nothing else held):
--
--   1. ca_payout_freeze learns scope 'wheel', the wheel's kill switch.
--   2. fn_ca_diamond_engine_of learns that a reference beginning 'wheel:' is
--      the engine 'wheel', with a budget line and a per-player daily cap, so a
--      diamond prize from the wheel is budgeted issuance (DR7) and never lands
--      in 'unclassified'.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

-- ── 1. the rate is a row ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ca_bridge_rate (
  id                smallint PRIMARY KEY CHECK (id = 1),
  diamonds_per_chip integer NOT NULL CHECK (diamonds_per_chip > 0),
  note              text NOT NULL CHECK (length(btrim(note)) >= 10),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid
);
COMMENT ON TABLE public.ca_bridge_rate IS
  'The one diamonds-to-chips rate (Dan 2026-09-07: 1 diamond = $0.01, 1 chip = $1.00, so 100 diamonds per chip). Read by fn_ca_bridge_rate(); the owner bridge and the Diamond Wheel both read it and neither carries a literal.';

CREATE TABLE IF NOT EXISTS public.ca_bridge_rate_history (
  id                     bigserial PRIMARY KEY,
  at                     timestamptz NOT NULL DEFAULT now(),
  diamonds_per_chip      integer NOT NULL,
  previous               integer,
  changed_by             uuid,
  db_role                text NOT NULL DEFAULT current_user,
  note                   text
);

CREATE OR REPLACE FUNCTION public.fn_ca_bridge_rate_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.ca_bridge_rate_history (diamonds_per_chip, previous, changed_by, note)
  VALUES (NEW.diamonds_per_chip,
          CASE WHEN TG_OP = 'UPDATE' THEN OLD.diamonds_per_chip END,
          COALESCE(NEW.updated_by, auth.uid()), NEW.note);
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.fn_ca_bridge_rate_history() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_ca_bridge_rate_history ON public.ca_bridge_rate;
CREATE TRIGGER trg_ca_bridge_rate_history
  AFTER INSERT OR UPDATE ON public.ca_bridge_rate
  FOR EACH ROW EXECUTE FUNCTION public.fn_ca_bridge_rate_history();

INSERT INTO public.ca_bridge_rate (id, diamonds_per_chip, note)
VALUES (1, 100, 'Dan 2026-09-07: 1 diamond = 1 cent, 1 chip = 1 dollar. 100 diamonds per chip.')
ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.fn_ca_bridge_rate()
RETURNS integer
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  SELECT diamonds_per_chip FROM public.ca_bridge_rate WHERE id = 1;
$function$;
COMMENT ON FUNCTION public.fn_ca_bridge_rate() IS
  'Diamonds per chip, from ca_bridge_rate. The only place a bridge rate may be read from.';

REVOKE ALL ON public.ca_bridge_rate FROM PUBLIC, anon;
REVOKE ALL ON public.ca_bridge_rate_history FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ca_bridge_rate TO authenticated, service_role;
GRANT SELECT ON public.ca_bridge_rate_history TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_ca_bridge_rate() TO authenticated, service_role;
ALTER TABLE public.ca_bridge_rate ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ca_bridge_rate_read ON public.ca_bridge_rate;
CREATE POLICY ca_bridge_rate_read ON public.ca_bridge_rate FOR SELECT TO authenticated USING (true);

-- ── 2. the owner bridge reads the row ─────────────────────────────────────────
-- Byte-for-byte the live body of 2026-09-07 except: the rate line, an
-- exactness check (the chips a diamond count buys must land on whole cents),
-- and the receipt notes, which used to say the wrong direction.
CREATE OR REPLACE FUNCTION public.fn_mint_chips_from_diamonds(p_club_id uuid, p_diamonds numeric, p_op_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_op_id uuid := coalesce(p_op_id, gen_random_uuid());
  v_prior record;
  v_diamonds numeric;
  v_chips numeric;
  v_rate integer;
  v_deduct jsonb;
  v_diamonds_after numeric;
  v_club record;
  v_is_union_minter boolean := false;
  v_pool_after numeric;
  v_union_bank_after numeric;
begin
  if v_actor is null then
    return jsonb_build_object('success', false, 'error', 'Not Authenticated');
  end if;
  if p_diamonds is null or p_diamonds <= 0 or p_diamonds <> floor(p_diamonds) then
    return jsonb_build_object('success', false, 'error', 'Diamonds Must Be A Positive Whole Number');
  end if;
  if p_diamonds > 1000000 then
    return jsonb_build_object('success', false, 'error', 'Maximum 1,000,000 Diamonds Per Mint');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_club_id::text || ':' || v_op_id::text, 0));

  select amount, transaction_type, metadata, balance_after into v_prior
    from chip_transactions
   where transaction_type = 'mint'
     and club_id = p_club_id
     and metadata ->> 'op_id' = v_op_id::text
   limit 1;
  if found then
    return jsonb_build_object('success', true, 'replayed', true,
      'scope', v_prior.metadata ->> 'scope',
      'chips', v_prior.amount,
      'diamonds_spent', (v_prior.metadata ->> 'diamonds_spent')::numeric,
      'diamonds_after', (select coalesce(diamonds, 0) from profiles where id = v_actor),
      'club_pool_after', case when (v_prior.metadata ->> 'scope') = 'club'
                              then v_prior.balance_after end,
      'union_bank_after', case when (v_prior.metadata ->> 'scope') = 'union'
                               then v_prior.balance_after end);
  end if;

  v_diamonds := p_diamonds;
  -- THE RATE IS A ROW (Dan 2026-09-07: 1 diamond = $0.01, 1 chip = $1.00).
  -- Read from ca_bridge_rate; never a literal in this body again.
  v_rate := public.fn_ca_bridge_rate();
  if v_rate is null or v_rate <= 0 then
    return jsonb_build_object('success', false, 'error', 'The Bridge Rate Is Not Set');
  end if;
  v_chips := round(v_diamonds / v_rate, 2);
  if v_chips <= 0 or v_chips * v_rate <> v_diamonds then
    return jsonb_build_object('success', false,
      'error', format('Diamonds Must Convert To Whole Cents Of Chips At %s Diamonds Per Chip', v_rate));
  end if;

  select id, name, union_id, owner_id into v_club
    from clubs where id = p_club_id for update;
  if v_club.id is null then
    return jsonb_build_object('success', false, 'error', 'That Club Could Not Be Found');
  end if;

  if v_club.union_id is not null then
    if exists (select 1 from unions u where u.id = v_club.union_id and u.owner_id = v_actor)
       or exists (select 1 from union_admins ua where ua.union_id = v_club.union_id and ua.user_id = v_actor) then
      v_is_union_minter := true;
    end if;
    if not v_is_union_minter then
      return jsonb_build_object('success', false,
        'error', 'Chip Mint Is Revoked For Clubs In A Union. Chips Flow From The Union. Ask Your Union Owner');
    end if;

    v_deduct := deduct_diamonds(
      v_actor, v_diamonds::integer,
      'Chip Mint: ' || v_chips::text || ' chips minted to union bank',
      'chip_mint', 'chip_mint',
      jsonb_build_object('club_id', p_club_id, 'union_id', v_club.union_id,
                         'chips', v_chips, 'op_id', v_op_id, 'diamonds_per_chip', v_rate),
      null, 0);
    if coalesce((v_deduct->>'success')::boolean, false) = false then
      return jsonb_build_object('success', false,
        'error', coalesce(v_deduct->>'error', 'That Diamond Deduction Did Not Go Through'));
    end if;
    select coalesce(diamonds, 0) into v_diamonds_after from profiles where id = v_actor;

    /* THE MINT (chip standard 3.1, 2026-09-04): chips bought with diamonds
       are ISSUED. Declared issuance_reserve -> union_bank with the op id as
       the journal key; the register row follows from the leg (deferred
       trigger on chip_ledger). Undeclared, this landed in suspense and the
       register never saw it. */
    perform public.fn_ca_declare_ledger('mint', 'issuance_reserve', null, null,
                                        'diamond-mint:' || v_op_id::text, null);
    insert into union_wallets (union_id, chip_balance)
    values (v_club.union_id, v_chips)
    on conflict (union_id)
    do update set chip_balance = coalesce(union_wallets.chip_balance, 0) + v_chips,
                  updated_at = now();
    perform set_config('app.ledger_category', '', true);
    perform set_config('app.ledger_counterparty', '', true);
    perform set_config('app.ledger_idempotency_key', '', true);
    select chip_balance into v_union_bank_after
      from union_wallets where union_id = v_club.union_id;

    insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
    values (p_club_id, v_actor, null, v_chips, 'mint',
            'Union Chip Mint: ' || v_chips::text || ' chips from ' || v_diamonds::text || ' diamonds at ' || v_rate::text || ' per chip',
            jsonb_build_object('op_id', v_op_id, 'scope', 'union',
                               'diamonds_spent', v_diamonds, 'union_id', v_club.union_id,
                               'diamonds_per_chip', v_rate),
            v_union_bank_after);

    return jsonb_build_object('success', true, 'replayed', false, 'scope', 'union',
      'chips', v_chips, 'diamonds_spent', v_diamonds, 'diamonds_per_chip', v_rate,
      'diamonds_after', v_diamonds_after, 'union_bank_after', v_union_bank_after);
  else
    -- STANDALONE CLUB: owner / co_owner / admin may mint into the club's pool.
    -- BOTH membership words (2026-08-27): status='active' alone refused the
    -- ~98% of production rows still carrying the pre-2026-07-22 'approved'.
    if not (v_club.owner_id = v_actor
            or exists (select 1 from club_members cm
                        where cm.club_id = p_club_id and cm.user_id = v_actor
                          and cm.role in ('owner', 'co_owner', 'admin')
                          and coalesce(cm.status, 'active') in ('active', 'approved'))) then
      return jsonb_build_object('success', false,
        'error', 'Only The Club Owner Or An Admin May Mint Chips');
    end if;

    v_deduct := deduct_diamonds(
      v_actor, v_diamonds::integer,
      'Chip Mint: ' || v_chips::text || ' chips minted to club bank',
      'chip_mint', 'chip_mint',
      jsonb_build_object('club_id', p_club_id, 'chips', v_chips, 'op_id', v_op_id,
                         'diamonds_per_chip', v_rate),
      null, 0);
    if coalesce((v_deduct->>'success')::boolean, false) = false then
      return jsonb_build_object('success', false,
        'error', coalesce(v_deduct->>'error', 'That Diamond Deduction Did Not Go Through'));
    end if;
    select coalesce(diamonds, 0) into v_diamonds_after from profiles where id = v_actor;

    /* THE MINT (chip standard 3.1, 2026-09-04): see the union branch. */
    perform public.fn_ca_declare_ledger('mint', 'issuance_reserve', null, null,
                                        'diamond-mint:' || v_op_id::text, null);
    update clubs set chip_treasury = coalesce(chip_treasury, 0) + v_chips, updated_at = now()
     where id = p_club_id
     returning chip_treasury into v_pool_after;
    perform set_config('app.ledger_category', '', true);
    perform set_config('app.ledger_counterparty', '', true);
    perform set_config('app.ledger_idempotency_key', '', true);

    insert into chip_transactions (club_id, from_user_id, to_user_id, amount, transaction_type, notes, metadata, balance_after)
    values (p_club_id, v_actor, null, v_chips, 'mint',
            'Chip Mint: ' || v_chips::text || ' chips from ' || v_diamonds::text || ' diamonds at ' || v_rate::text || ' per chip',
            jsonb_build_object('op_id', v_op_id, 'scope', 'club',
                               'diamonds_spent', v_diamonds, 'diamonds_per_chip', v_rate),
            v_pool_after);

    return jsonb_build_object('success', true, 'replayed', false, 'scope', 'club',
      'chips', v_chips, 'diamonds_spent', v_diamonds, 'diamonds_per_chip', v_rate,
      'diamonds_after', v_diamonds_after, 'club_pool_after', v_pool_after);
  end if;
end
$function$;

-- ── 3. the kill switch learns the wheel ───────────────────────────────────────
ALTER TABLE public.ca_payout_freeze DROP CONSTRAINT IF EXISTS ca_payout_freeze_scope_check;
ALTER TABLE public.ca_payout_freeze ADD CONSTRAINT ca_payout_freeze_scope_check
  CHECK ((scope = ANY (ARRAY['tournament_payouts'::text, 'bbj_payouts'::text, 'diamond_issuance'::text, 'diamond_tournament_payouts'::text, 'arena_withdrawals'::text, 'wheel'::text])));

-- ── 4. the diamond earn ledger knows the wheel as an engine ──────────────────
CREATE OR REPLACE FUNCTION public.fn_ca_diamond_engine_of(p_type text, p_transaction_type text, p_source text, p_description text, p_reference_id text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
    SELECT CASE
        WHEN starts_with(p_reference_id, 'wheel:')            THEN 'wheel'
        WHEN starts_with(p_reference_id, 'trivia_tourn_')     THEN 'trivia_tournaments'
        WHEN starts_with(p_reference_id, 'trivia_session_')   THEN 'trivia'
        WHEN starts_with(p_reference_id, 'trivia_wheel_')     THEN 'trivia'
        WHEN starts_with(p_reference_id, 'challenge_claim')   THEN 'daily_challenges'
        WHEN starts_with(p_reference_id, 'daily_mission_milestones:') THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'daily-missions-historical-multiplier:') THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'daily_mission_')    THEN 'daily_missions'
        WHEN starts_with(p_reference_id, 'streak_milestone_') THEN 'share_streak'
        WHEN starts_with(p_reference_id, 'streak_')           THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'signup:')           THEN 'signup'
        WHEN starts_with(p_reference_id, 'easter_egg_')       THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'video_favorite_')   THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'vip_stipend_')      THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'hotd_')             THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'progress_')         THEN 'catalog_v2'
        WHEN starts_with(p_reference_id, 'customization-cert-fund') THEN 'cert_fixture'
        WHEN p_source = 'complete_daily_challenge' THEN 'memory_game'
        WHEN p_source = 'handle_new_user'          THEN 'signup'
        WHEN p_source = 'union'                    THEN 'union_grant'
        WHEN p_source = 'the_mint'                 THEN 'mint'
        WHEN COALESCE(p_transaction_type, p_type) IN ('wheel_prize', 'wheel_spin') THEN 'wheel'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'referral_bonus', 'referral_bonus_reversal', 'referral_qualified',
                'referral_referee', 'referral_vip_conversion')             THEN 'referrals'
        WHEN COALESCE(p_transaction_type, p_type) = 'signup_bonus'         THEN 'signup'
        WHEN COALESCE(p_transaction_type, p_type) = 'union_grant'          THEN 'union_grant'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'pvp_refund', 'pvp_win', 'pvp_tie_refund', 'trivia_run',
                'trivia_daily_bonus', 'daily_trivia', 'trivia_reward',
                'trivia_prize_wheel', 'endless_reward', 'survival_reward',
                'mixed_reward', 'time_attack_reward', 'trivia_double_win')  THEN 'trivia'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'tournament_prize', 'tournament_entry_refund',
                'tournament_cancel_refund')                                THEN 'trivia_tournaments'
        WHEN COALESCE(p_transaction_type, p_type) IN ('daily_challenge_claim') THEN 'daily_challenges'
        WHEN COALESCE(p_transaction_type, p_type) IN ('daily_mission_milestone', 'daily_mission_reward') THEN 'daily_missions'
        WHEN COALESCE(p_transaction_type, p_type) = 'streak_reward'        THEN 'share_streak'
        WHEN COALESCE(p_transaction_type, p_type) IN (
                'daily_login', 'easter_egg', 'training_reward',
                'video_favorite', 'vip_stipend')                           THEN 'catalog_v2'
        WHEN COALESCE(p_transaction_type, p_type) IN ('credit', 'earn', 'bonus') THEN 'legacy_credit'
        WHEN p_description LIKE 'Diamond Rewards v2:%'                      THEN 'catalog_v2'
        ELSE 'other'
    END;
$function$;

-- The wheel's diamond prizes are 3.75 percent of intake in expectation (the two
-- diamond tiers of segment version 1: 50 diamonds at 6 percent and 25 at 3
-- percent, on a 100-diamond spin); 50,000 a month funds about 1.33 million
-- diamonds of spins ($13,300). Over-budget files DR7 at warning, never refuses
-- a drawn prize (a drawn prize is owed).
INSERT INTO public.diamond_reward_budgets (period, engine, budget_diamonds, spent_diamonds, updated_at)
VALUES ('2026-09', 'wheel', 50000, 0, now()), ('2026-10', 'wheel', 50000, 0, now())
ON CONFLICT (period, engine) DO NOTHING;
INSERT INTO public.diamond_engine_daily_caps (engine, max_per_user_per_day, max_per_user_per_day_vip, note, updated_at)
VALUES ('wheel', 10000, 10000,
        'Diamond Wheel prizes per player per day. Top diamond tier is 250 (1 in 128 at 100 a spin); 200 spins a day cannot reach this except by luck, in which case DR7 warns and nothing is refused.',
        now())
ON CONFLICT (engine) DO NOTHING;

-- ── post-apply assertions: abort the transaction if any assumption failed ─────
DO $$
DECLARE v_def text; v_src text; v_rate integer;
BEGIN
  SELECT diamonds_per_chip INTO v_rate FROM public.ca_bridge_rate WHERE id = 1;
  IF v_rate IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'POST-APPLY: ca_bridge_rate must read 100 diamonds per chip, got %', v_rate;
  END IF;
  IF (SELECT count(*) FROM public.ca_bridge_rate_history) < 1 THEN
    RAISE EXCEPTION 'POST-APPLY: the rate history did not record the seed row';
  END IF;
  SELECT prosrc INTO v_src FROM pg_proc WHERE proname = 'fn_mint_chips_from_diamonds' AND pronamespace = 'public'::regnamespace;
  IF v_src LIKE '%v_diamonds * 100%' OR v_src NOT LIKE '%fn_ca_bridge_rate()%' THEN
    RAISE EXCEPTION 'POST-APPLY: fn_mint_chips_from_diamonds still carries a literal rate or does not read fn_ca_bridge_rate()';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ca_payout_freeze'::regclass
                   AND pg_get_constraintdef(oid) LIKE '%''wheel''%') THEN
    RAISE EXCEPTION 'POST-APPLY: ca_payout_freeze scope check lacks wheel';
  END IF;
  IF public.fn_ca_diamond_engine_of('wheel_prize', 'wheel_prize', NULL, NULL, 'wheel:abc:prize') <> 'wheel' THEN
    RAISE EXCEPTION 'POST-APPLY: fn_ca_diamond_engine_of does not map wheel references to the wheel engine';
  END IF;
  IF (SELECT count(*) FROM public.diamond_reward_budgets WHERE engine = 'wheel') < 2 THEN
    RAISE EXCEPTION 'POST-APPLY: wheel budget lines missing';
  END IF;
END $$;

COMMIT;
