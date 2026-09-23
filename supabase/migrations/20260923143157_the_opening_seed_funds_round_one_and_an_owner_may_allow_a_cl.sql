-- 20260923143157_the_opening_seed_funds_round_one_and_an_owner_may_allow_a_cl.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY (owner brief 8.3, 2026-09-23):
--
--   "Paid leaderboards: first-round funding is explicitly seeded. Later rounds
--    use Promotion funds. Any insufficient Promotion amount becomes an explicit
--    club-wallet overlay."
--
-- 1. THE SEED FUNDS THE FIRST ROUND (fn_complete_club_opening_setup,
--    fn_enforce_leaderboard_program_funding). The opening RPC already moves a
--    paid leaderboard's weekly budget out of the Club Bank and holds it as
--    club_opening_setups.leaderboard_seed_remaining, and settlement already
--    pays round one from that seed first. But the row was written AFTER the
--    program was published, and the BEFORE INSERT funding gate compared the
--    program's commitment with clubs.promo_balance alone, so a new club could
--    only publish a paid leaderboard if it ALSO funded a Promotion at least as
--    large as the weekly budget: the owner paid for round one twice. Now the
--    RPC writes (and so holds) the setup row with the seed BEFORE it
--    publishes, and the gate counts that club's unreleased opening seed as
--    capacity for exactly one publication: the one carrying the setup's own
--    operation id (club_opening_setups.last_operation_id, UNIQUE, and
--    (club_id, operation_id) is UNIQUE on the program versions, so the seed
--    can be counted once and only once). Every other publication path - the
--    prize wizard, every existing club, every union - matches no row and is
--    judged exactly as before. This is the smallest change that makes the
--    seed count: no new table, no new balance, no change to what settlement
--    does with the seed.
--
-- 2. THE CURRENT VERSION, NOT 0 (fn_complete_club_opening_setup). The nested
--    publish was passed p_expected_version = 0, so a club that already had any
--    program version was refused with 40001 even for Display Only. The RPC now
--    reads COALESCE(max(version), 0) under the club row lock it already holds;
--    publication takes the same lock, so nothing can publish in between.
--
-- 3. ONE ACTOR CAN COMPLETE IT: THE OWNER (fn_complete_club_opening_setup).
--    The RPC admitted the owner OR a platform admin, but every setup publishes
--    a program and publication admits only the owner or a co-owner. An admin
--    therefore passed, activated Spins, debited the Club Bank, and was then
--    refused (42501) by the nested publish, rolling everything back; a
--    co-owner was refused by the RPC itself. The admin branch could never
--    commit, so it is removed: the owner is the one actor who can complete the
--    whole setup, and everyone else is refused first, with 42501, before
--    anything moves. The refusal text is unchanged.
--
-- 4. AN EXPLICIT CLUB BANK OVERLAY, OFF BY DEFAULT (program versions,
--    fn_publish_leaderboard_reward_program, fn_save_leaderboard_reward_setup,
--    fn_payout_leaderboard, leaderboard_payout_batches).
--    The 2026-09-06 contract (20260906084547) reads: an underfunded Promo
--    Wallet "must never SILENTLY debit the Club Bank or Union Bank". This
--    keeps that sentence true and adds the one debit it allows - an EXPLICIT
--    one:
--      * leaderboard_reward_program_versions.overlay_enabled, NOT NULL DEFAULT
--        false. Every existing program is false. It can only be true on a paid
--        standalone club program (CHECK), never on a union's.
--      * The publication RPC takes it as a trailing parameter DEFAULT false.
--        Both publication functions are dropped and recreated in this one
--        transaction with their grants, so PostgREST never sees two overloads
--        (PGRST203) and every existing caller, which names eight arguments,
--        resolves to the new function with the opt-in OFF.
--      * The opt-in joins the hashed program terms only when ON, so every
--        program without it hashes exactly as before.
--      * Settlement is unchanged when the opt-in is OFF: the same seed, the
--        same Promo Wallet debit, the same refusal text and code, the same
--        unpaid-and-retryable round, overlay_funded 0. When it is ON and seed
--        plus Promo Wallet cannot cover a round, ONLY the shortfall is paid
--        from that club's own Club Bank, as its own journal leg (Club Bank to
--        leaderboard_round, category overlay, idempotency key
--        leaderboard-overlay:<club>:<period>:<start>), recorded on the batch
--        as overlay_funded, in the same transaction as the credits. If the
--        Club Bank cannot hold the whole shortfall either, nothing moves and
--        the round stays unpaid and retryable exactly as today.
--      * The batch CHECK that pinned overlay_funded = 0 becomes: an overlay is
--        only ever a standalone club's own bank (never a union's). The
--        existing CHECK total_paid = seed + promo + overlay is kept.
--    THE PUBLICATION GATE DOES NOT CHANGE WHEN THE OPT-IN IS ON. The opt-in
--    covers a LATER round's shortfall; it is not a funding source to publish
--    against. Counting the Club Bank as publication capacity would let a
--    program be published with no Promotion funding at all and paid from the
--    Club Bank every week, which is the Club Bank as the planned payer - the
--    thing the 09-06 contract forbids - dressed as an overlay.
--
-- 5. THE OWNER CAN SEE IT (fn_get_leaderboard_reward_setup,
--    fn_get_leaderboard_settlement_status): the setup read returns the
--    current program's overlay_enabled, and the settlement read returns the
--    batch's overlay_funded, so a paid batch reconciles as
--    seed + promo + overlay = total on every client.
--
-- NOT CHANGED, AND WHY: A club with NO club_opening_setups row settles with a
-- NULL seed in the live fn_payout_leaderboard (SELECT ... INTO over zero rows
-- assigns NULL; the underfunded test is then NULL, LEAST() skips the NULL, and
-- the whole round is booked as a seed that does not exist while promo_balance
-- is set to NULL). That is a live defect of every existing standalone program
-- published outside the opening wizard. The brief holds every existing club
-- to exactly today's behaviour, so this migration leaves it bit-for-bit for
-- programs without the opt-in and corrects it only on the new overlay path.
-- The root fix for every program is its own migration, 20260923144141, for
-- the lead to apply after reading which clubs it changes.
--
-- Every replaced function is asserted against its live definition before it
-- is replaced (md5 of pg_get_functiondef and prosrc, owner, ACL, config, read
-- 2026-09-23), and against its intended definition before COMMIT. Any drift
-- aborts the whole transaction. Qualified on an isolated PostgreSQL 17 fixture
-- built from those same live definitions; the scenario SQL is kept beside the
-- evidence (see the lead's handover).
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric)',
     '47980506016942eccb64c037322237de', 'a968ef67eac488895f9db21b9aaa6459',
     '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.fn_publish_leaderboard_reward_program(uuid,boolean,text,jsonb,jsonb,text,integer,uuid)',
     'facd963c7e4fa6bcb7d3bc172dd1752e', 'cc9e35b7128794dac8d46e31a8ba5a76',
     '{postgres=X/postgres,service_role=X/postgres}'),
    ('public.fn_save_leaderboard_reward_setup(uuid,boolean,text,jsonb,jsonb,text,integer,uuid)',
     '7b5b1046b17567fed56cbc2054f83e4b', 'b8b042dd2f5c4b316cfdd3798e753d2d',
     '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.fn_enforce_leaderboard_program_funding()',
     '52781f6898b3e0f5857448abaa5d5fb6', 'aa4c5583f4ccda6bd7f251f40522674b',
     '{postgres=X/postgres,service_role=X/postgres}'),
    ('public.fn_payout_leaderboard(uuid,text,text,timestamptz,timestamptz)',
     'f9d5ed7e04368c39adcd10b9f2382586', '8b9c1773e3b5d6732cb98ba94be280d7',
     '{postgres=X/postgres,service_role=X/postgres}'),
    ('public.fn_get_leaderboard_reward_setup(uuid)',
     '3dda030d280235f06e8f502c18a129a2', '9016d6a91750cbfb5a8eae383f8b66b8',
     '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.fn_get_leaderboard_settlement_status(uuid,text,date)',
     'ca0bc21799e0fb1f4ea6e09a99dd8b6d', 'c123aaf0e0a7560a7af5c884c13c01ed',
     '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'),
    ('public.fn_settle_due_leaderboards()',
     '8f2b1c2ff47e45431be6fee4639f9cb8', 'd0d452a2d2c96400743972370d0f6ece',
     '{postgres=X/postgres,service_role=X/postgres}')
  ) v(sig, src_md5, def_md5, acl) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure(r.sig)
         AND md5(p.prosrc) = r.src_md5
         AND md5(pg_get_functiondef(p.oid)) = r.def_md5
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND p.proacl::text = r.acl
         AND p.prosecdef
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
    ) THEN
      RAISE EXCEPTION 'LEADERBOARD_OPENING_SEED_PREIMAGE_DRIFT: %', r.sig;
    END IF;
  END LOOP;
  -- One overload each, so dropping the eight/eighteen-argument forms leaves none.
  IF (SELECT count(*) FROM pg_catalog.pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('fn_publish_leaderboard_reward_program',
                           'fn_save_leaderboard_reward_setup',
                           'fn_complete_club_opening_setup')) <> 3 THEN
    RAISE EXCEPTION 'LEADERBOARD_OPENING_SEED_PREIMAGE_DRIFT: an unexpected overload exists';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE t.tgrelid = 'public.leaderboard_reward_program_versions'::regclass
       AND t.tgname = 'leaderboard_program_funding_gate'
       AND t.tgfoid = 'public.fn_enforce_leaderboard_program_funding()'::regprocedure
       AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'LEADERBOARD_OPENING_SEED_PREIMAGE_DRIFT: the funding gate trigger moved';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'public.leaderboard_payout_batches'::regclass
       AND c.conname = 'leaderboard_payout_batches_promo_only_check'
       AND pg_get_constraintdef(c.oid)
         = 'CHECK (((overlay_funded = (0)::numeric) AND (total_paid = (seed_funded + promo_funded))))'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'public.leaderboard_payout_batches'::regclass
       AND c.conname = 'leaderboard_payout_batches_check'
       AND pg_get_constraintdef(c.oid)
         = 'CHECK ((total_paid = ((seed_funded + promo_funded) + overlay_funded)))'
  ) THEN
    RAISE EXCEPTION 'LEADERBOARD_OPENING_SEED_PREIMAGE_DRIFT: the batch funding checks moved';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = 'public.leaderboard_reward_program_versions'::regclass
       AND a.attname = 'overlay_enabled'
  ) THEN
    RAISE EXCEPTION 'LEADERBOARD_OPENING_SEED_PREIMAGE_DRIFT: overlay_enabled already exists';
  END IF;
END
$pre$;

-- ---------------------------------------------------------------------------
-- The per-program opt-in. Every existing version reads false (a constant
-- default is stored in the catalog: no row is rewritten, so the table's
-- immutability trigger is never asked to allow an UPDATE).
ALTER TABLE public.leaderboard_reward_program_versions
  ADD COLUMN overlay_enabled boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT leaderboard_reward_program_overlay_scope
    CHECK (NOT overlay_enabled
           OR (rewards_enabled AND funding_owner_type = 'club' AND funding_union_id IS NULL));

COMMENT ON COLUMN public.leaderboard_reward_program_versions.overlay_enabled IS
  'The owner''s explicit, per-program Club Bank overlay opt-in. False unless chosen. When true, a round the opening seed and the Promo Wallet cannot cover is paid by the club''s own Club Bank for the shortfall only, as a separate overlay leg; if the Club Bank cannot cover it either the round stays unpaid and retryable. Only a paid standalone club program may carry it.';

ALTER TABLE public.leaderboard_payout_batches
  DROP CONSTRAINT leaderboard_payout_batches_promo_only_check,
  ADD CONSTRAINT leaderboard_payout_batches_overlay_is_the_club_bank_only
    CHECK (overlay_funded = 0 OR funding_owner_type = 'club');

-- ---------------------------------------------------------------------------
-- 1. The funding gate counts the opening seed for the opening publication.
CREATE OR REPLACE FUNCTION public.fn_enforce_leaderboard_program_funding()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_balance numeric := 0;
  v_opening_seed numeric := 0;
  v_other_commitments numeric := 0;
  v_requested_commitment numeric := 0;
BEGIN
  v_requested_commitment := public.fn_leaderboard_program_commitment(
    NEW.rewards_enabled,
    NEW.weekly_prizes,
    NEW.monthly_prizes
  );

  IF NOT NEW.rewards_enabled THEN
    RETURN NEW;
  END IF;

  IF NEW.funding_owner_type = 'union' THEN
    IF NEW.funding_union_id IS NULL THEN
      RAISE EXCEPTION 'A Union-Funded Leaderboard Requires A Funding Union'
        USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(wallet.promo_wallet, 0)
      INTO v_balance
      FROM public.union_wallets wallet
     WHERE wallet.union_id = NEW.funding_union_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Leaderboard Funding Union Has No Promo Wallet'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.funding_owner_type = 'club' THEN
    IF NEW.funding_union_id IS NOT NULL THEN
      RAISE EXCEPTION 'A Standalone Club Leaderboard Cannot Name A Funding Union'
        USING ERRCODE = '23514';
    END IF;
    SELECT COALESCE(club.promo_balance, 0)
      INTO v_balance
      FROM public.clubs club
     WHERE club.id = NEW.club_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002';
    END IF;

    -- THE OPENING SEED FUNDS THE OPENING PROGRAM (2026-09-23). A new club's
    -- opening setup writes its explicit first-round seed on its own row
    -- BEFORE it publishes, and holds that row. Only that one publication, the
    -- setup's own operation id, counts the unreleased seed beside the Promo
    -- Wallet. Every other publication matches no row here and is judged
    -- exactly as before: against the Promo Wallet alone.
    SELECT setup.leaderboard_seed_remaining
      INTO v_opening_seed
      FROM public.club_opening_setups setup
     WHERE setup.club_id = NEW.club_id
       AND setup.last_operation_id = NEW.operation_id
     FOR UPDATE;
    v_balance := v_balance + COALESCE(v_opening_seed, 0);
  ELSE
    RAISE EXCEPTION 'Leaderboard Funding Owner Must Be A Union Or Club'
      USING ERRCODE = '23514';
  END IF;

  WITH latest AS MATERIALIZED (
    SELECT DISTINCT ON (program.club_id)
      program.club_id,
      program.rewards_enabled,
      program.weekly_prizes,
      program.monthly_prizes,
      program.funding_owner_type,
      program.funding_union_id
    FROM public.leaderboard_reward_program_versions program
    WHERE program.club_id <> NEW.club_id
    ORDER BY program.club_id, program.version DESC
  )
  SELECT COALESCE(sum(public.fn_leaderboard_program_commitment(
    latest.rewards_enabled,
    latest.weekly_prizes,
    latest.monthly_prizes
  )), 0)
  INTO v_other_commitments
  FROM latest
  WHERE NEW.funding_owner_type = 'union'
    AND latest.funding_owner_type = 'union'
    AND latest.funding_union_id = NEW.funding_union_id;

  IF v_requested_commitment + v_other_commitments > v_balance THEN
    RAISE EXCEPTION
      'Leaderboard Prize Program Requires % Promo Chips But Only % Are Available After Other Published Commitments',
      round(v_requested_commitment, 2),
      round(GREATEST(v_balance - v_other_commitments, 0), 2)
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. The publication RPC and its browser wrapper take the opt-in. Dropped and
--    recreated together so exactly one of each exists (no PGRST203).
DROP FUNCTION public.fn_save_leaderboard_reward_setup(uuid, boolean, text, jsonb, jsonb, text, integer, uuid);
DROP FUNCTION public.fn_publish_leaderboard_reward_program(uuid, boolean, text, jsonb, jsonb, text, integer, uuid);

CREATE FUNCTION public.fn_publish_leaderboard_reward_program(
  p_club_id uuid,
  p_rewards_enabled boolean,
  p_metric text,
  p_weekly_prizes jsonb,
  p_monthly_prizes jsonb,
  p_suggestion_key text,
  p_expected_version integer,
  p_operation_id uuid,
  p_overlay_enabled boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_club record;
  v_union_id uuid;
  v_can_manage boolean := false;
  v_current_version integer;
  v_previous_id uuid;
  v_existing public.leaderboard_reward_program_versions%ROWTYPE;
  v_weekly_effective date;
  v_monthly_effective date;
  v_next_version integer;
  v_hash text;
  v_requested_hash text;
  v_overlay boolean := COALESCE(p_overlay_enabled, false);
  v_overlay_terms jsonb;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Not Authenticated' USING ERRCODE = '42501';
  END IF;
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'A Publication Retry Key Is Required' USING ERRCODE = '22023';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 0 THEN
    RAISE EXCEPTION 'A Valid Current Program Version Is Required' USING ERRCODE = '22023';
  END IF;

  SELECT club.id, club.owner_id INTO v_club
    FROM public.clubs club WHERE club.id = p_club_id FOR UPDATE;
  IF v_club.id IS NULL THEN
    RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002';
  END IF;

  v_union_id := public.fn_leaderboard_funding_union_id(p_club_id);
  IF v_union_id IS NOT NULL THEN
    v_can_manage := public.fn_union_can_manage_wallets(v_union_id, v_actor);
  ELSE
    v_can_manage := v_club.owner_id = v_actor OR EXISTS (
      SELECT 1 FROM public.club_members member
       WHERE member.club_id = p_club_id
         AND member.user_id = v_actor
         AND member.role IN ('owner', 'co_owner')
         AND COALESCE(member.status, 'active') IN ('active', 'approved')
    );
  END IF;
  IF NOT v_can_manage THEN
    RAISE EXCEPTION 'Only The Funding Owner Can Manage Leaderboard Rewards'
      USING ERRCODE = '42501';
  END IF;

  IF p_metric NOT IN ('profit', 'hands_played', 'tournaments_won', 'roi') THEN
    RAISE EXCEPTION 'Choose A Supported Prize Metric' USING ERRCODE = '22023';
  END IF;
  IF p_suggestion_key NOT IN ('balanced', 'top_heavy', 'even', 'custom') THEN
    RAISE EXCEPTION 'Choose A Supported Prize Plan' USING ERRCODE = '22023';
  END IF;
  IF NOT public.fn_leaderboard_prizes_are_valid(COALESCE(p_weekly_prizes, '[]'::jsonb))
     OR NOT public.fn_leaderboard_prizes_are_valid(COALESCE(p_monthly_prizes, '[]'::jsonb)) THEN
    RAISE EXCEPTION 'Prize Rows Must Use Unique Ranks 1 Through 10 And Positive Amounts With At Most Two Decimals'
      USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_rewards_enabled, false)
     AND jsonb_array_length(COALESCE(p_weekly_prizes, '[]'::jsonb)) = 0
     AND jsonb_array_length(COALESCE(p_monthly_prizes, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'Add A Weekly Or Monthly Prize Before Enabling Rewards'
      USING ERRCODE = '22023';
  END IF;

  -- THE CLUB BANK OVERLAY IS AN EXPLICIT, PER-PROGRAM OWNER OPT-IN (2026-09-23).
  -- OFF unless the caller says ON. It exists only on a paid standalone club
  -- program: a union's programs are paid by the union Promo Wallet alone and
  -- never by any bank.
  IF v_overlay AND NOT COALESCE(p_rewards_enabled, false) THEN
    RAISE EXCEPTION 'A Club Bank Overlay Needs A Paid Leaderboard' USING ERRCODE = '22023';
  END IF;
  IF v_overlay AND v_union_id IS NOT NULL THEN
    RAISE EXCEPTION 'A Club Bank Overlay Is Only Available To A Standalone Club'
      USING ERRCODE = '22023';
  END IF;
  -- The opt-in joins the hashed program terms only when it is ON, so every
  -- program without it hashes exactly as before, and a retry that changes the
  -- answer is refused as a different program.
  v_overlay_terms := CASE WHEN v_overlay
    THEN jsonb_build_object('overlay_enabled', true) ELSE '{}'::jsonb END;

  SELECT existing.* INTO v_existing
    FROM public.leaderboard_reward_program_versions existing
   WHERE existing.club_id = p_club_id
     AND existing.operation_id = p_operation_id;
  IF v_existing.id IS NOT NULL THEN
    v_requested_hash := md5((jsonb_build_object(
      'club_id', p_club_id,
      'version', v_existing.version,
      'rewards_enabled', COALESCE(p_rewards_enabled, false),
      'payout_metric', p_metric,
      'weekly_prizes', COALESCE(p_weekly_prizes, '[]'::jsonb),
      'monthly_prizes', COALESCE(p_monthly_prizes, '[]'::jsonb),
      'funding_owner_type', CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END,
      'funding_union_id', v_union_id,
      'weekly_effective_from', v_existing.weekly_effective_from,
      'monthly_effective_from', v_existing.monthly_effective_from
    ) || v_overlay_terms)::text);
    IF v_existing.program_hash <> v_requested_hash
       OR v_existing.suggestion_key <> p_suggestion_key
       OR v_existing.version <> p_expected_version + 1 THEN
      RAISE EXCEPTION 'Leaderboard Publication Retry Key Was Reused For Different Prize Rules'
        USING ERRCODE = '22023';
    END IF;
    RETURN public.fn_get_leaderboard_reward_setup(p_club_id) || jsonb_build_object(
      'rewards_enabled', v_existing.rewards_enabled,
      'payout_metric', v_existing.payout_metric,
      'weekly_prizes', v_existing.weekly_prizes,
      'monthly_prizes', v_existing.monthly_prizes,
      'suggestion_key', v_existing.suggestion_key,
      'program_version', v_existing.version,
      'program_hash', v_existing.program_hash,
      'program_status', v_existing.status,
      'weekly_effective_from', v_existing.weekly_effective_from,
      'monthly_effective_from', v_existing.monthly_effective_from,
      'published_at', v_existing.published_at,
      'program_funding_owner_type', v_existing.funding_owner_type,
      'program_funding_union_id', v_existing.funding_union_id,
      'overlay_enabled', v_existing.overlay_enabled,
      'program_funding_label', CASE
        WHEN v_existing.funding_owner_type = 'union' THEN COALESCE(
          (SELECT union_row.name FROM public.unions union_row
            WHERE union_row.id = v_existing.funding_union_id),
          'Recorded Union'
        ) || ' Promo Wallet'
        ELSE (SELECT club.name FROM public.clubs club WHERE club.id = p_club_id)
             || ' Promo Wallet'
      END
    );
  END IF;

  SELECT program.version, program.id INTO v_current_version, v_previous_id
    FROM public.leaderboard_reward_program_versions program
   WHERE program.club_id = p_club_id
   ORDER BY program.version DESC
   LIMIT 1;
  v_current_version := COALESCE(v_current_version, 0);
  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'Leaderboard Prize Setup Changed In Another Session'
      USING ERRCODE = '40001',
            DETAIL = format('Expected Version %s But Found Version %s',
                            p_expected_version, v_current_version);
  END IF;

  SELECT bounds.end_date INTO v_weekly_effective
    FROM public.fn_leaderboard_period_window('weekly', 0) bounds;
  SELECT bounds.end_date INTO v_monthly_effective
    FROM public.fn_leaderboard_period_window('monthly', 0) bounds;
  v_next_version := v_current_version + 1;
  v_hash := md5((jsonb_build_object(
    'club_id', p_club_id,
    'version', v_next_version,
    'rewards_enabled', COALESCE(p_rewards_enabled, false),
    'payout_metric', p_metric,
    'weekly_prizes', COALESCE(p_weekly_prizes, '[]'::jsonb),
    'monthly_prizes', COALESCE(p_monthly_prizes, '[]'::jsonb),
    'funding_owner_type', CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END,
    'funding_union_id', v_union_id,
    'weekly_effective_from', v_weekly_effective,
    'monthly_effective_from', v_monthly_effective
  ) || v_overlay_terms)::text);

  INSERT INTO public.leaderboard_reward_program_versions (
    club_id, version, operation_id, rewards_enabled, payout_metric,
    weekly_prizes, monthly_prizes, suggestion_key,
    funding_owner_type, funding_union_id,
    weekly_effective_from, monthly_effective_from,
    published_by, supersedes_program_id, program_hash, overlay_enabled
  ) VALUES (
    p_club_id, v_next_version, p_operation_id, COALESCE(p_rewards_enabled, false), p_metric,
    COALESCE(p_weekly_prizes, '[]'::jsonb), COALESCE(p_monthly_prizes, '[]'::jsonb),
    p_suggestion_key, CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END, v_union_id,
    v_weekly_effective, v_monthly_effective, v_actor, v_previous_id, v_hash, v_overlay
  );

  INSERT INTO public.club_leaderboard_settings (
    club_id, payout_currency, weekly_prizes, monthly_prizes,
    rewards_enabled, payout_metric, funding_owner_type, funding_union_id,
    suggestion_key, setup_completed_at, setup_completed_by, updated_by, updated_at
  ) VALUES (
    p_club_id, 'chips', COALESCE(p_weekly_prizes, '[]'::jsonb),
    COALESCE(p_monthly_prizes, '[]'::jsonb), COALESCE(p_rewards_enabled, false),
    p_metric, CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END, v_union_id,
    p_suggestion_key, now(), v_actor, v_actor, now()
  )
  ON CONFLICT (club_id) DO UPDATE SET
    payout_currency = EXCLUDED.payout_currency,
    weekly_prizes = EXCLUDED.weekly_prizes,
    monthly_prizes = EXCLUDED.monthly_prizes,
    rewards_enabled = EXCLUDED.rewards_enabled,
    payout_metric = EXCLUDED.payout_metric,
    funding_owner_type = EXCLUDED.funding_owner_type,
    funding_union_id = EXCLUDED.funding_union_id,
    suggestion_key = EXCLUDED.suggestion_key,
    setup_completed_at = COALESCE(public.club_leaderboard_settings.setup_completed_at, now()),
    setup_completed_by = COALESCE(public.club_leaderboard_settings.setup_completed_by, v_actor),
    updated_by = v_actor,
    updated_at = now();

  RETURN public.fn_get_leaderboard_reward_setup(p_club_id);
END;
$function$;

CREATE FUNCTION public.fn_save_leaderboard_reward_setup(
  p_club_id uuid,
  p_rewards_enabled boolean,
  p_metric text,
  p_weekly_prizes jsonb,
  p_monthly_prizes jsonb,
  p_suggestion_key text,
  p_expected_version integer,
  p_operation_id uuid,
  p_overlay_enabled boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT public.fn_publish_leaderboard_reward_program(
    p_club_id, p_rewards_enabled, p_metric, p_weekly_prizes,
    p_monthly_prizes, p_suggestion_key, p_expected_version, p_operation_id,
    p_overlay_enabled
  );
$function$;

-- ---------------------------------------------------------------------------
-- 1, 2, 3, 4. The opening RPC.
DROP FUNCTION public.fn_complete_club_opening_setup(
  uuid, uuid, text, numeric, numeric, boolean, numeric, boolean, numeric, numeric,
  boolean, text, text, text, numeric, boolean, text, numeric
);

CREATE FUNCTION public.fn_complete_club_opening_setup(
  p_club_id uuid,
  p_operation_id uuid,
  p_tagline text,
  p_rake_percent numeric,
  p_rake_cap_bb numeric,
  p_bbj_enabled boolean,
  p_bbj_seed numeric,
  p_spins_enabled boolean,
  p_spin_seed numeric,
  p_spin_max_stake numeric,
  p_promo_enabled boolean,
  p_promo_type text,
  p_promo_name text,
  p_promo_description text,
  p_promo_budget numeric,
  p_leaderboard_rewards_enabled boolean,
  p_leaderboard_metric text,
  p_leaderboard_prize_budget numeric,
  p_leaderboard_overlay_enabled boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_club public.clubs%ROWTYPE;
  v_existing public.club_opening_setups%ROWTYPE;
  v_rake numeric := round(COALESCE(p_rake_percent, -1), 2);
  v_cap numeric := round(COALESCE(p_rake_cap_bb, -1), 2);
  v_bbj_seed numeric := round(COALESCE(p_bbj_seed, 0), 2);
  v_spin_seed numeric := round(COALESCE(p_spin_seed, 0), 2);
  v_promo_budget numeric := round(COALESCE(p_promo_budget, 0), 2);
  v_leaderboard_budget numeric := round(COALESCE(p_leaderboard_prize_budget, 0), 2);
  v_spin_required numeric := 0;
  v_other_allocation numeric := 0;
  v_total_allocation numeric := 0;
  v_spin_result jsonb := '{}'::jsonb;
  v_pool_id uuid;
  v_bbj_after numeric := 0;
  v_promo_after numeric := 0;
  v_promotion_id uuid;
  v_leaderboard_result jsonb := '{}'::jsonb;
  v_program_version integer := 0;
  v_leaderboard_overlay boolean := COALESCE(p_leaderboard_rewards_enabled, false)
    AND COALESCE(p_leaderboard_overlay_enabled, false);
  v_bank_after numeric := 0;
  v_result jsonb;
  v_tagline text := left(regexp_replace(btrim(COALESCE(p_tagline, '')), '\s+', ' ', 'g'), 72);
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication Required';
  END IF;
  IF p_operation_id IS NULL THEN
    RAISE EXCEPTION 'Operation ID Is Required';
  END IF;

  SELECT * INTO v_club FROM public.clubs WHERE id = p_club_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club Not Found';
  END IF;

  -- ONLY THE OWNER CAN COMPLETE IT, AND EVERYONE ELSE IS REFUSED HERE
  -- (2026-09-23). Every setup publishes a leaderboard program, and
  -- publication accepts only the club's owner or co-owner. The
  -- platform-admin branch that used to pass this check could never commit:
  -- it activated Spins and debited the Club Bank, then the publish refused
  -- it with 42501 and rolled all of it back. A co-owner never passed here.
  -- The one actor who can complete the whole setup is the owner, so the
  -- owner is the rule, and the refusal comes before anything moves.
  IF v_club.owner_id IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only The Club Owner Can Complete Opening Setup'
      USING ERRCODE = '42501';
  END IF;
  IF COALESCE(v_club.is_union, false) OR v_club.union_id IS NOT NULL THEN
    RAISE EXCEPTION 'Union-Owned Economics Must Be Configured By The Union Lead';
  END IF;

  IF char_length(v_tagline) < 3 THEN
    RAISE EXCEPTION 'Write A Custom Club Tag Line Before Completing Setup';
  END IF;
  IF v_tagline ILIKE '%all fish of all shapes and sizes are welcome%'
     AND v_club.club_id <> 25450 THEN
    RAISE EXCEPTION 'That Tag Line Belongs To Shark Club';
  END IF;

  SELECT * INTO v_existing
  FROM public.club_opening_setups
  WHERE club_id = p_club_id
  FOR UPDATE;

  IF FOUND THEN
    v_result := jsonb_build_object(
      'success', true,
      'already_completed', true,
      'club_id', p_club_id,
      'club_bank_after', v_club.chip_treasury,
      'completed_at', v_existing.completed_at,
      'operation_id', v_existing.last_operation_id
    );
    RETURN v_result;
  END IF;

  IF v_rake <> -1 AND (v_rake < 0 OR v_rake > 10) THEN
    RAISE EXCEPTION 'Rake Must Use The House Schedule Or Be Between 0 And 10 Percent';
  END IF;
  IF v_cap <> -1 AND (v_cap < 0 OR v_cap > 10) THEN
    RAISE EXCEPTION 'Rake Cap Must Use The House Schedule Or Be Between 0 And 10 Big Blinds';
  END IF;

  IF p_bbj_enabled AND v_bbj_seed < 100 THEN
    RAISE EXCEPTION 'BBJ Requires A Minimum 100-Chip Seed';
  END IF;
  IF NOT p_bbj_enabled THEN
    v_bbj_seed := 0;
  END IF;

  IF p_spins_enabled THEN
    IF p_spin_max_stake NOT IN (1, 2, 3, 5, 10, 20, 50, 100) THEN
      RAISE EXCEPTION 'Spin Maximum Stake Is Not A Supported Board Stake';
    END IF;
    v_spin_required := public.fn_spin_required_seed(p_spin_max_stake);
    IF v_spin_seed < GREATEST(100, v_spin_required) THEN
      RAISE EXCEPTION 'Spin Seed Must Be At Least % Chips For The Selected Board',
        GREATEST(100, v_spin_required);
    END IF;
  ELSE
    v_spin_seed := 0;
  END IF;

  IF p_promo_enabled THEN
    IF p_promo_type NOT IN ('leaderboard', 'rake_race', 'milestone', 'mystery', 'high_hand') THEN
      RAISE EXCEPTION 'Promotion Type Is Not Supported';
    END IF;
    IF length(btrim(COALESCE(p_promo_name, ''))) < 3 THEN
      RAISE EXCEPTION 'Promotion Name Must Be At Least 3 Characters';
    END IF;
    IF v_promo_budget < 100 THEN
      RAISE EXCEPTION 'A New Promotion Requires A Minimum 100-Chip Budget';
    END IF;
  ELSE
    v_promo_budget := 0;
  END IF;

  IF p_leaderboard_metric NOT IN ('profit', 'hands_played', 'tournaments_won', 'roi') THEN
    RAISE EXCEPTION 'Leaderboard Metric Is Not Supported';
  END IF;
  IF p_leaderboard_rewards_enabled THEN
    IF v_leaderboard_budget < 100 THEN
      RAISE EXCEPTION 'A Prize Leaderboard Requires A Minimum 100-Chip Budget';
    END IF;
  ELSE
    v_leaderboard_budget := 0;
  END IF;

  v_other_allocation := v_bbj_seed + v_promo_budget + v_leaderboard_budget;
  v_total_allocation := v_other_allocation + v_spin_seed;
  IF COALESCE(v_club.chip_treasury, 0) < v_total_allocation THEN
    RAISE EXCEPTION 'Club Bank Has % Chips But Setup Requires %',
      COALESCE(v_club.chip_treasury, 0), v_total_allocation;
  END IF;

  -- Spin activation owns its wallet debit, reserve credit, repayment metadata,
  -- and reserve ledger. Calling it inside this function keeps all setup steps
  -- in the same database transaction.
  IF p_spins_enabled THEN
    v_spin_result := public.fn_spin_activate(
      p_club_id,
      v_spin_seed,
      p_spin_max_stake,
      'chip_treasury',
      v_actor
    );
    IF NOT COALESCE((v_spin_result ->> 'ok')::boolean, false) THEN
      RAISE EXCEPTION 'Spin Setup Failed: %', COALESCE(v_spin_result ->> 'reason', 'Unknown Reason');
    END IF;

    INSERT INTO public.club_opening_setup_funding
      (club_id, operation_id, destination, amount, balance_after, created_by)
    VALUES (
      p_club_id, p_operation_id, 'spin_reserve', v_spin_seed,
      COALESCE((v_spin_result ->> 'balance')::numeric, v_spin_seed), v_actor
    );
  END IF;

  PERFORM set_config('app.ledger_category', 'club_opening_allocation', true);
  PERFORM set_config('app.ledger_counterparty', 'opening_setup', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_club_id::text, true);

  UPDATE public.clubs
  SET chip_treasury = COALESCE(chip_treasury, 0) - v_other_allocation,
      promo_balance = COALESCE(promo_balance, 0) + v_promo_budget,
      tagline = v_tagline,
      default_rake_percent = v_rake,
      rake_cap = v_cap,
      bbj_enabled = p_bbj_enabled,
      bbj_rake_enabled = p_bbj_enabled,
      spins_enabled = p_spins_enabled,
      spins_preseed_amount = v_spin_seed,
      spins_wallet_funding = 'CHIP_TREASURY',
      updated_at = now()
  WHERE id = p_club_id
  RETURNING chip_treasury, promo_balance INTO v_bank_after, v_promo_after;

  IF p_bbj_enabled THEN
    SELECT pool.id INTO v_pool_id
    FROM public.bbj_pools pool
    WHERE pool.club_id = p_club_id AND pool.union_id IS NULL
    ORDER BY (pool.status = 'active') DESC, pool.created_at
    LIMIT 1
    FOR UPDATE;

    IF v_pool_id IS NULL THEN
      INSERT INTO public.bbj_pools
        (club_id, main_balance, backup_balance, promo_balance, pool_amount, status)
      VALUES (p_club_id, v_bbj_seed, 0, 0, 0, 'active')
      RETURNING id, main_balance INTO v_pool_id, v_bbj_after;
    ELSE
      UPDATE public.bbj_pools
      SET main_balance = main_balance + v_bbj_seed,
          status = 'active',
          updated_at = now()
      WHERE id = v_pool_id
      RETURNING main_balance INTO v_bbj_after;
    END IF;

    INSERT INTO public.club_opening_setup_funding
      (club_id, operation_id, destination, amount, balance_after, created_by)
    VALUES (p_club_id, p_operation_id, 'bbj_main', v_bbj_seed, v_bbj_after, v_actor);
  END IF;

  IF p_promo_enabled THEN
    INSERT INTO public.promotions (
      club_id, name, description, type, start_date, end_date, status,
      prize_pool, requirements, opt_in_required
    ) VALUES (
      p_club_id,
      left(btrim(p_promo_name), 80),
      left(btrim(COALESCE(p_promo_description, '')), 500),
      p_promo_type,
      now(),
      now() + interval '30 days',
      'active',
      v_promo_budget,
      'Created During Club Opening Setup',
      true
    ) RETURNING id INTO v_promotion_id;

    INSERT INTO public.club_opening_setup_funding
      (club_id, operation_id, destination, amount, balance_after, created_by)
    VALUES (p_club_id, p_operation_id, 'promo_wallet', v_promo_budget, v_promo_after, v_actor);
  END IF;

  -- THE SEED IS WRITTEN, AND HELD, BEFORE THE PROGRAM IT FUNDS (2026-09-23).
  -- A paid leaderboard's first round is its explicit seed: the weekly budget
  -- that left the Club Bank above, recorded on this row as
  -- leaderboard_seed_remaining. Writing the row before publishing lets the
  -- publication funding gate count that seed, for this setup's own operation
  -- id only, beside the Promo Wallet, so a paid leaderboard no longer needs a
  -- Promotion at least as large as its weekly budget. Later rounds draw on
  -- the Promo Wallet. It is one transaction: a refused publish removes this
  -- row and every transfer above with it.
  INSERT INTO public.club_opening_setups (
    club_id, owner_id, rake_mode, rake_percent, rake_cap_bb,
    bbj_enabled, bbj_seeded_amount,
    spins_enabled, spin_seeded_amount, spin_max_stake,
    promo_enabled, promo_budget, promotion_id,
    leaderboard_rewards_enabled, leaderboard_metric, leaderboard_prize_budget,
    leaderboard_seed_remaining,
    last_operation_id
  ) VALUES (
    p_club_id, v_club.owner_id,
    CASE WHEN v_rake = -1 AND v_cap = -1 THEN 'house_schedule' ELSE 'custom' END,
    v_rake, v_cap,
    p_bbj_enabled, v_bbj_seed,
    p_spins_enabled, v_spin_seed, CASE WHEN p_spins_enabled THEN p_spin_max_stake ELSE 0 END,
    p_promo_enabled, v_promo_budget, v_promotion_id,
    p_leaderboard_rewards_enabled, p_leaderboard_metric, v_leaderboard_budget,
    v_leaderboard_budget,
    p_operation_id
  );

  -- The program's current version, read under the club lock taken above.
  -- Publication locks this same club row, so nothing can publish between
  -- this read and the publish below. The hard-coded 0 this replaces refused
  -- (40001) every club that already had a program, even for Display Only.
  SELECT COALESCE(max(program.version), 0)
    INTO v_program_version
    FROM public.leaderboard_reward_program_versions program
   WHERE program.club_id = p_club_id;

  -- Leaderboards always receive an explicit program. Display-only is the
  -- safe launch default; a paid program publishes a balanced weekly
  -- top-three plan that sums exactly to the seeded budget, and carries the
  -- owner's explicit answer on the Club Bank overlay (OFF unless chosen).
  v_leaderboard_result := public.fn_publish_leaderboard_reward_program(
    p_club_id,
    p_leaderboard_rewards_enabled,
    p_leaderboard_metric,
    CASE WHEN p_leaderboard_rewards_enabled THEN jsonb_build_array(
      jsonb_build_object('rank', 1, 'amount', round(v_leaderboard_budget * 0.50, 2)),
      jsonb_build_object('rank', 2, 'amount', round(v_leaderboard_budget * 0.30, 2)),
      jsonb_build_object('rank', 3, 'amount', v_leaderboard_budget
        - round(v_leaderboard_budget * 0.50, 2)
        - round(v_leaderboard_budget * 0.30, 2))
    ) ELSE '[]'::jsonb END,
    '[]'::jsonb,
    'balanced',
    v_program_version,
    p_operation_id,
    v_leaderboard_overlay
  );

  IF p_leaderboard_rewards_enabled THEN
    INSERT INTO public.club_opening_setup_funding
      (club_id, operation_id, destination, amount, balance_after, created_by)
    VALUES (
      p_club_id, p_operation_id, 'leaderboard_prizes',
      v_leaderboard_budget, v_leaderboard_budget, v_actor
    );
  END IF;


  v_result := jsonb_build_object(
    'success', true,
    'already_completed', false,
    'club_id', p_club_id,
    'club_bank_after', v_bank_after,
    'allocated', v_total_allocation,
    'bbj_seeded', v_bbj_seed,
    'spin_seeded', v_spin_seed,
    'promo_budget', v_promo_budget,
    'promotion_id', v_promotion_id,
    'leaderboard_rewards_enabled', p_leaderboard_rewards_enabled,
    'leaderboard_prize_budget', v_leaderboard_budget,
    'leaderboard_overlay_enabled', v_leaderboard_overlay,
    'leaderboard', v_leaderboard_result,
    'spin', v_spin_result,
    'operation_id', p_operation_id
  );
  RETURN v_result;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Settlement pays an explicit overlay, and only with the opt-in.
CREATE OR REPLACE FUNCTION public.fn_payout_leaderboard(
  p_club_id uuid,
  p_period text,
  p_metric text,
  p_start_date timestamptz,
  p_end_date timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_start date := (p_start_date AT TIME ZONE 'UTC')::date;
  v_end date := (p_end_date AT TIME ZONE 'UTC')::date;
  v_plan jsonb;
  v_existing public.leaderboard_payout_batches%ROWTYPE;
  v_winners jsonb := '[]'::jsonb;
  v_winner jsonb;
  v_total numeric(18,2) := 0;
  v_promo_available numeric(18,2) := 0;
  v_seed_available numeric(18,2) := 0;
  v_seed_debit numeric(18,2) := 0;
  v_seed_release numeric(18,2) := 0;
  v_promo_debit numeric(18,2) := 0;
  v_bank_available numeric(18,2) := 0;
  v_overlay_enabled boolean := false;
  v_overlay numeric := 0;
  v_union_id uuid;
  v_batch_id uuid;
  v_credited boolean;
BEGIN
  IF p_period NOT IN ('weekly', 'monthly') THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|Only Weekly And Monthly Leaderboards Can Be Settled';
  END IF;
  IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|Leaderboard Settlement Requires A Closed Date Range';
  END IF;
  IF v_end > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|An Open Leaderboard Round Cannot Be Paid';
  END IF;
  IF (p_period = 'weekly' AND (EXTRACT(DOW FROM v_start) <> 0 OR v_end <> v_start + 7))
     OR (p_period = 'monthly' AND (
       EXTRACT(DAY FROM v_start) <> 1
       OR v_end <> (v_start + interval '1 month')::date
     )) THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|Leaderboard Settlement Must Use A Canonical UTC Round';
  END IF;

  SELECT batch.* INTO v_existing
  FROM public.leaderboard_payout_batches batch
  WHERE batch.club_id = p_club_id
    AND batch.period = p_period
    AND batch.period_start = v_start;
  IF v_existing.id IS NOT NULL THEN
    RETURN jsonb_build_object(
      'success', true,
      'already_settled', true,
      'batch_id', v_existing.id,
      'total_paid', v_existing.total_paid,
      'seed_funded', v_existing.seed_funded,
      'promo_funded', v_existing.promo_funded,
      'overlay_funded', v_existing.overlay_funded,
      'winner_count', v_existing.winner_count,
      'tie_policy', v_existing.tie_policy
    );
  END IF;

  v_plan := public.fn_get_leaderboard_reward_plan(p_club_id, p_period, v_start);
  IF v_plan IS NULL OR NOT COALESCE((v_plan ->> 'rewards_enabled')::boolean, false) THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|No Paid Leaderboard Program Applies To This Round';
  END IF;
  IF p_metric IS DISTINCT FROM v_plan ->> 'payout_metric' THEN
    RAISE EXCEPTION 'LEADERBOARD_PROGRAM_INVALID|Leaderboard Metric Does Not Match The Published Program';
  END IF;

  WITH board AS MATERIALIZED (
    SELECT ranked.user_id, ranked.rank
    FROM public.fn_club_leaderboard_by_dates(
      p_club_id, p_metric, v_start, v_end, 1000000, 0
    ) ranked
    WHERE ranked.qualified
  ), tied AS MATERIALIZED (
    SELECT
      board.user_id,
      board.rank,
      count(*) OVER (PARTITION BY board.rank)::integer AS tie_count,
      row_number() OVER (PARTITION BY board.rank ORDER BY board.user_id)::integer AS tie_order
    FROM board
  ), prizes AS MATERIALIZED (
    SELECT prize.rank, round(prize.amount, 2) AS amount
    FROM jsonb_to_recordset(COALESCE(v_plan -> 'prizes', '[]'::jsonb))
      AS prize(rank integer, amount numeric)
    WHERE prize.amount > 0
  ), pooled AS MATERIALIZED (
    SELECT
      tied.user_id,
      tied.rank,
      tied.tie_count,
      tied.tie_order,
      COALESCE(sum(prizes.amount), 0)::numeric(18,2) AS pool_amount
    FROM tied
    LEFT JOIN prizes
      ON prizes.rank >= tied.rank
     AND prizes.rank < tied.rank + tied.tie_count
    GROUP BY tied.user_id, tied.rank, tied.tie_count, tied.tie_order
  ), winners AS (
    SELECT
      pooled.user_id,
      pooled.rank,
      (
        trunc(pooled.pool_amount / pooled.tie_count, 2)
        + CASE
            WHEN pooled.tie_order <= mod((pooled.pool_amount * 100)::bigint, pooled.tie_count)
              THEN 0.01
            ELSE 0
          END
      )::numeric(18,2) AS amount
    FROM pooled
    WHERE pooled.pool_amount > 0
  )
  SELECT
    COALESCE(jsonb_agg(jsonb_build_object(
      'user_id', winners.user_id,
      'rank', winners.rank,
      'amount', winners.amount
    ) ORDER BY winners.rank, winners.user_id), '[]'::jsonb),
    COALESCE(round(sum(winners.amount), 2), 0)
  INTO v_winners, v_total
  FROM winners;

  IF v_plan ->> 'funding_owner_type' = 'union' THEN
    v_union_id := (v_plan ->> 'funding_union_id')::uuid;
    SELECT COALESCE(wallet.promo_wallet, 0)
    INTO v_promo_available
    FROM public.union_wallets wallet
    WHERE wallet.union_id = v_union_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LEADERBOARD_PROMO_WALLET_MISSING|Leaderboard Funding Union Has No Promo Wallet';
    END IF;
  ELSE
    SELECT COALESCE(setup.leaderboard_seed_remaining, 0)
    INTO v_seed_available
    FROM public.club_opening_setups setup
    WHERE setup.club_id = p_club_id
    FOR UPDATE;

    SELECT COALESCE(club.promo_balance, 0), COALESCE(club.chip_treasury, 0)
    INTO v_promo_available, v_bank_available
    FROM public.clubs club
    WHERE club.id = p_club_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'LEADERBOARD_PROMO_WALLET_MISSING|Leaderboard Club Not Found';
    END IF;

    -- THE CLUB BANK OVERLAY OPT-IN (2026-09-23), read from the exact
    -- immutable program version this round is paid under. It is false on
    -- every program published before this migration and on every program
    -- whose owner did not choose it, and it can only be true on a standalone
    -- club's own program (leaderboard_reward_program_overlay_scope).
    SELECT program.overlay_enabled
    INTO v_overlay_enabled
    FROM public.leaderboard_reward_program_versions program
    WHERE program.id = (v_plan ->> 'program_id')::uuid
      AND program.club_id = p_club_id
      AND program.funding_owner_type = 'club';
    v_overlay_enabled := COALESCE(v_overlay_enabled, false);
    IF v_overlay_enabled THEN
      -- A program that may draw on the Club Bank is settled on exact figures:
      -- a club with no opening setup row holds no seed. (The same correction
      -- for every program is its own migration, 20260923144141.)
      v_seed_available := COALESCE(v_seed_available, 0);
    END IF;
  END IF;

  IF v_seed_available + v_promo_available < v_total THEN
    IF NOT v_overlay_enabled THEN
      RAISE EXCEPTION
        'LEADERBOARD_PROMO_UNDERFUNDED|Leaderboard Requires % Promo Chips But The Recorded Promo Wallet Holds %',
        v_total,
        v_seed_available + v_promo_available;
    END IF;
    -- Only the SHORTFALL is an overlay, and only a Club Bank that holds all
    -- of it pays it. Otherwise the round stays unpaid and the daily sweep
    -- retries it, exactly as an underfunded round without the opt-in.
    v_overlay := v_total - v_seed_available - v_promo_available;
    IF v_bank_available < v_overlay THEN
      RAISE EXCEPTION
        'LEADERBOARD_PROMO_UNDERFUNDED|Leaderboard Requires % Chips But The Recorded Promo Wallet Holds % And The Club Bank Can Overlay Only %',
        v_total,
        v_seed_available + v_promo_available,
        v_bank_available;
    END IF;
  END IF;

  v_seed_debit := LEAST(v_total, v_seed_available);
  v_seed_release := v_seed_available - v_seed_debit;
  v_promo_debit := v_total - v_seed_debit - v_overlay;

  PERFORM set_config('app.ledger_category', 'leaderboard_payout', true);
  PERFORM set_config('app.ledger_counterparty', 'leaderboard_round', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_club_id::text, true);

  IF v_plan ->> 'funding_owner_type' = 'union' THEN
    UPDATE public.union_wallets
    SET promo_wallet = promo_wallet - v_promo_debit,
        updated_at = now()
    WHERE union_id = v_union_id;
  ELSE
    UPDATE public.clubs
    SET promo_balance = promo_balance - v_promo_debit + v_seed_release,
        updated_at = now()
    WHERE id = p_club_id;

    UPDATE public.club_opening_setups
    SET leaderboard_seed_remaining = 0,
        updated_at = now()
    WHERE club_id = p_club_id AND leaderboard_seed_remaining > 0;

    IF v_overlay > 0 THEN
      -- THE OVERLAY LEG. Its own statement, so the journal writes it as its
      -- own leg: Club Bank to this leaderboard round, category overlay, under
      -- a key that names the round and can be claimed once.
      PERFORM set_config('app.ledger_category', 'overlay', true);
      PERFORM set_config('app.ledger_idempotency_key',
        format('leaderboard-overlay:%s:%s:%s', p_club_id, p_period, v_start), true);
      UPDATE public.clubs
      SET chip_treasury = chip_treasury - v_overlay,
          updated_at = now()
      WHERE id = p_club_id;
      PERFORM set_config('app.ledger_idempotency_key', '', true);
      PERFORM set_config('app.ledger_category', 'leaderboard_payout', true);
    END IF;
  END IF;

  INSERT INTO public.leaderboard_payout_batches (
    club_id, period, period_start, period_end, metric,
    program_id, program_version, program_hash,
    funding_owner_type, funding_union_id,
    total_paid, seed_funded, promo_funded, overlay_funded, winner_count, tie_policy
  ) VALUES (
    p_club_id, p_period, v_start, v_end, p_metric,
    (v_plan ->> 'program_id')::uuid,
    (v_plan ->> 'program_version')::integer,
    v_plan ->> 'program_hash',
    v_plan ->> 'funding_owner_type', v_union_id,
    v_total, v_seed_debit, v_promo_debit, v_overlay, jsonb_array_length(v_winners),
    'split_occupied_places'
  ) RETURNING id INTO v_batch_id;

  FOR v_winner IN SELECT value FROM jsonb_array_elements(v_winners)
  LOOP
    v_credited := public.fn_credit_and_log(
      (v_winner ->> 'user_id')::uuid,
      (v_winner ->> 'amount')::numeric,
      format('leaderboard:%s:%s:%s:%s', p_club_id, p_period, v_start, v_winner ->> 'user_id'),
      'leaderboard_payout',
      format('%s Leaderboard, Rank %s', initcap(p_period), v_winner ->> 'rank'),
      (v_plan ->> 'program_id')::uuid
    );
    IF NOT v_credited THEN
      RAISE EXCEPTION 'LEADERBOARD_CREDIT_CONFLICT|Leaderboard Credit Key Already Exists Without A Batch Receipt';
    END IF;

    INSERT INTO public.leaderboard_payouts (
      club_id, period, metric, start_date, end_date, user_id, rank,
      payout_amount, payout_currency, awarded_at, batch_id
    ) VALUES (
      p_club_id, p_period, p_metric, v_start, v_end,
      (v_winner ->> 'user_id')::uuid,
      (v_winner ->> 'rank')::integer,
      (v_winner ->> 'amount')::numeric,
      'chips', now(), v_batch_id
    );
  END LOOP;

  UPDATE public.leaderboard_payout_failures
  SET resolved_at = now(),
      resolution = 'Settlement Completed Automatically'
  WHERE club_id = p_club_id
    AND period = p_period
    AND period_start = v_start
    AND resolved_at IS NULL;

  RETURN jsonb_build_object(
    'success', true,
    'already_settled', false,
    'batch_id', v_batch_id,
    'total_paid', v_total,
    'seed_funded', v_seed_debit,
    'promo_funded', v_promo_debit,
    'overlay_funded', v_overlay,
    'winner_count', jsonb_array_length(v_winners),
    'tie_policy', 'split_occupied_places'
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. The read models.
CREATE OR REPLACE FUNCTION public.fn_get_leaderboard_reward_setup(p_club_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_club record;
  v_union_id uuid;
  v_union_name text;
  v_can_manage boolean := false;
  v_is_member boolean := false;
  v_settings public.club_leaderboard_settings%ROWTYPE;
  v_program public.leaderboard_reward_program_versions%ROWTYPE;
  v_program_union_name text;
  v_funding jsonb;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Not Authenticated' USING ERRCODE = '42501'; END IF;
  SELECT club.id, club.name, club.owner_id INTO v_club
    FROM public.clubs club WHERE club.id = p_club_id;
  IF v_club.id IS NULL THEN RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002'; END IF;

  v_union_id := public.fn_leaderboard_funding_union_id(p_club_id);
  SELECT EXISTS (
    SELECT 1 FROM public.club_members member WHERE member.club_id = p_club_id
      AND member.user_id = v_actor
      AND COALESCE(member.status, 'active') IN ('active', 'approved')
  ) INTO v_is_member;
  IF v_union_id IS NOT NULL THEN
    v_can_manage := public.fn_union_can_manage_wallets(v_union_id, v_actor);
    SELECT union_row.name INTO v_union_name
      FROM public.unions union_row
     WHERE union_row.id = v_union_id;
  ELSE
    v_can_manage := v_club.owner_id = v_actor OR EXISTS (
      SELECT 1 FROM public.club_members member WHERE member.club_id = p_club_id
        AND member.user_id = v_actor AND member.role IN ('owner', 'co_owner')
        AND COALESCE(member.status, 'active') IN ('active', 'approved')
    );
  END IF;
  IF NOT v_is_member AND NOT v_can_manage THEN
    RAISE EXCEPTION 'Leaderboard Reward Setup Is Not Available For This Club'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_settings FROM public.club_leaderboard_settings settings
   WHERE settings.club_id = p_club_id;
  SELECT * INTO v_program FROM public.leaderboard_reward_program_versions program
   WHERE program.club_id = p_club_id ORDER BY program.version DESC LIMIT 1;
  IF v_program.funding_owner_type = 'union' THEN
    SELECT union_row.name INTO v_program_union_name FROM public.unions union_row
     WHERE union_row.id = v_program.funding_union_id;
  END IF;
  v_funding := public.fn_leaderboard_funding_summary(p_club_id);

  RETURN jsonb_build_object(
    'club_id', p_club_id, 'club_name', v_club.name,
    'union_id', v_union_id, 'union_name', v_union_name,
    'funding_owner_type', CASE WHEN v_union_id IS NULL THEN 'club' ELSE 'union' END,
    'funding_source', CASE WHEN v_union_id IS NULL THEN 'club_promo_balance' ELSE 'union_promo_wallet' END,
    'funding_label', CASE WHEN v_union_id IS NULL THEN v_club.name || ' Promo Wallet' ELSE v_union_name || ' Promo Wallet' END,
    'available_balance', CASE WHEN v_can_manage THEN v_funding -> 'publication_capacity' ELSE NULL END,
    'wallet_balance', CASE WHEN v_can_manage THEN v_funding -> 'wallet_balance' ELSE NULL END,
    'committed_balance', CASE WHEN v_can_manage THEN v_funding -> 'committed_balance' ELSE NULL END,
    'current_program_commitment', CASE WHEN v_can_manage THEN v_funding -> 'current_program_commitment' ELSE NULL END,
    'other_program_commitments', CASE WHEN v_can_manage THEN v_funding -> 'other_program_commitments' ELSE NULL END,
    'available_uncommitted_balance', CASE WHEN v_can_manage THEN v_funding -> 'available_uncommitted_balance' ELSE NULL END,
    'publication_capacity', CASE WHEN v_can_manage THEN v_funding -> 'publication_capacity' ELSE NULL END,
    'committed_club_count', CASE WHEN v_can_manage THEN v_funding -> 'committed_club_count' ELSE NULL END,
    'funding_status', v_funding ->> 'funding_status',
    'can_manage', v_can_manage,
    'setup_complete', v_settings.setup_completed_at IS NOT NULL,
    'rewards_enabled', COALESCE(v_program.rewards_enabled, v_settings.rewards_enabled, false),
    'payout_currency', 'chips',
    'payout_metric', COALESCE(v_program.payout_metric, v_settings.payout_metric, 'profit'),
    'weekly_prizes', COALESCE(v_program.weekly_prizes, v_settings.weekly_prizes, '[]'::jsonb),
    'monthly_prizes', COALESCE(v_program.monthly_prizes, v_settings.monthly_prizes, '[]'::jsonb),
    'suggestion_key', COALESCE(v_program.suggestion_key, v_settings.suggestion_key, 'balanced'),
    'program_version', COALESCE(v_program.version, 0),
    'program_hash', v_program.program_hash,
    'program_status', CASE WHEN v_program.id IS NULL THEN 'not_published' ELSE 'published' END,
    'weekly_effective_from', v_program.weekly_effective_from,
    'monthly_effective_from', v_program.monthly_effective_from,
    'published_at', v_program.published_at,
    'program_funding_owner_type', v_program.funding_owner_type,
    'program_funding_union_id', v_program.funding_union_id,
    'overlay_enabled', COALESCE(v_program.overlay_enabled, false),
    'program_funding_label', CASE
      WHEN v_program.id IS NULL THEN NULL
      WHEN v_program.funding_owner_type = 'union'
        THEN COALESCE(v_program_union_name, 'Recorded Union') || ' Promo Wallet'
      ELSE v_club.name || ' Promo Wallet'
    END,
    'setup_completed_at', v_settings.setup_completed_at,
    'updated_at', COALESCE(v_program.published_at, v_settings.updated_at)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_get_leaderboard_settlement_status(
  p_club_id uuid,
  p_period text,
  p_period_start date
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_club record;
  v_is_member boolean := false;
  v_can_manage boolean := false;
  v_is_platform_admin boolean := false;
  v_period_end date;
  v_plan jsonb;
  v_batch public.leaderboard_payout_batches%ROWTYPE;
  v_failure public.leaderboard_payout_failures%ROWTYPE;
  v_receipts jsonb := '[]'::jsonb;
  v_state text;
  v_planned_total numeric(18,2) := 0;
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'Authentication Required' USING ERRCODE = '42501';
  END IF;
  IF p_period NOT IN ('weekly', 'monthly') OR p_period_start IS NULL THEN
    RAISE EXCEPTION 'A Canonical Weekly Or Monthly Period Is Required' USING ERRCODE = '22023';
  END IF;

  SELECT club.id, club.owner_id, club.union_id
  INTO v_club
  FROM public.clubs club
  WHERE club.id = p_club_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Club Not Found' USING ERRCODE = 'P0002';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.club_members member
    WHERE member.club_id = p_club_id AND member.user_id = v_actor
  ) INTO v_is_member;
  SELECT EXISTS (
    SELECT 1 FROM public.profiles profile
    WHERE profile.id = v_actor AND profile.role IN ('admin', 'superadmin', 'god')
  ) INTO v_is_platform_admin;

  v_can_manage := v_is_platform_admin
    OR v_club.owner_id = v_actor
    OR EXISTS (
      SELECT 1 FROM public.club_members member
      WHERE member.club_id = p_club_id
        AND member.user_id = v_actor
        AND member.role IN ('owner', 'co_owner')
    )
    OR (
      v_club.union_id IS NOT NULL
      AND public.fn_union_can_manage_wallets(v_club.union_id, v_actor)
    );

  IF NOT v_is_member AND NOT v_can_manage THEN
    RAISE EXCEPTION 'Leaderboard Access Denied' USING ERRCODE = '42501';
  END IF;

  v_period_end := CASE p_period
    WHEN 'weekly' THEN p_period_start + 7
    ELSE (p_period_start + interval '1 month')::date
  END;
  IF (p_period = 'weekly' AND EXTRACT(DOW FROM p_period_start) <> 0)
     OR (p_period = 'monthly' AND EXTRACT(DAY FROM p_period_start) <> 1) THEN
    RAISE EXCEPTION 'A Canonical Weekly Or Monthly Period Is Required' USING ERRCODE = '22023';
  END IF;

  v_plan := public.fn_get_leaderboard_reward_plan(p_club_id, p_period, p_period_start);
  IF v_plan IS NOT NULL THEN
    SELECT COALESCE(sum((prize ->> 'amount')::numeric), 0)
    INTO v_planned_total
    FROM jsonb_array_elements(COALESCE(v_plan -> 'prizes', '[]'::jsonb)) prize;
  END IF;

  SELECT batch.* INTO v_batch
  FROM public.leaderboard_payout_batches batch
  WHERE batch.club_id = p_club_id
    AND batch.period = p_period
    AND batch.period_start = p_period_start;

  IF v_batch.id IS NOT NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'id', payout.id,
      'batch_id', payout.batch_id,
      'user_id', payout.user_id,
      'rank', payout.rank,
      'payout_amount', payout.payout_amount,
      'payout_currency', payout.payout_currency,
      'awarded_at', payout.awarded_at
    ) ORDER BY payout.rank, payout.user_id), '[]'::jsonb)
    INTO v_receipts
    FROM public.leaderboard_payouts payout
    WHERE payout.batch_id = v_batch.id;
  END IF;

  SELECT failure.* INTO v_failure
  FROM public.leaderboard_payout_failures failure
  WHERE failure.club_id = p_club_id
    AND failure.period = p_period
    AND failure.period_start = p_period_start
    AND failure.resolved_at IS NULL;

  v_state := CASE
    WHEN v_batch.id IS NOT NULL THEN 'paid'
    WHEN v_plan IS NULL THEN 'not_published'
    WHEN NOT COALESCE((v_plan ->> 'rewards_enabled')::boolean, false) THEN 'disabled'
    WHEN v_period_end > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date THEN 'open'
    WHEN v_failure.id IS NOT NULL THEN 'failed'
    ELSE 'pending'
  END;

  RETURN jsonb_build_object(
    'club_id', p_club_id,
    'period', p_period,
    'period_start', p_period_start,
    'period_end', v_period_end,
    'state', v_state,
    'can_manage', v_can_manage,
    'planned_total', round(v_planned_total, 2),
    'program', v_plan,
    'batch', CASE WHEN v_batch.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_batch.id,
      'program_id', v_batch.program_id,
      'program_version', v_batch.program_version,
      'program_hash', v_batch.program_hash,
      'metric', v_batch.metric,
      'funding_owner_type', v_batch.funding_owner_type,
      'funding_union_id', v_batch.funding_union_id,
      'total_paid', v_batch.total_paid,
      'seed_funded', v_batch.seed_funded,
      'promo_funded', v_batch.promo_funded,
      'overlay_funded', v_batch.overlay_funded,
      'winner_count', v_batch.winner_count,
      'tie_policy', v_batch.tie_policy,
      'settled_at', v_batch.settled_at
    ) END,
    'failure', CASE WHEN v_failure.id IS NULL THEN NULL ELSE jsonb_build_object(
      'error_code', v_failure.error_code,
      'attempt_count', v_failure.attempt_count,
      'first_failed_at', v_failure.first_failed_at,
      'last_failed_at', v_failure.failed_at,
      'automatic_retry', true,
      'owner_message', CASE WHEN v_can_manage THEN CASE v_failure.error_code
        WHEN 'promo_wallet_underfunded' THEN 'Add Promo Chips To Cover The Published Prize Pool. Automatic Retry Is Active.'
        WHEN 'promo_wallet_missing' THEN 'The Recorded Promo Wallet Could Not Be Found. Automatic Retry Is Active.'
        WHEN 'credit_conflict' THEN 'A Payout Receipt Conflict Needs Platform Review. No Duplicate Credit Was Issued.'
        ELSE 'Settlement Needs Platform Review. Automatic Retry Is Active.'
      END ELSE NULL END
    ) END,
    'receipts', v_receipts
  );
END;
$function$;

-- ---------------------------------------------------------------------------
-- Grants: exactly the live ACLs, restated for every function this declares.
REVOKE ALL ON FUNCTION public.fn_enforce_leaderboard_program_funding()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_enforce_leaderboard_program_funding() TO service_role;
REVOKE ALL ON FUNCTION public.fn_publish_leaderboard_reward_program(
  uuid, boolean, text, jsonb, jsonb, text, integer, uuid, boolean
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_publish_leaderboard_reward_program(
  uuid, boolean, text, jsonb, jsonb, text, integer, uuid, boolean
) TO service_role;
REVOKE ALL ON FUNCTION public.fn_save_leaderboard_reward_setup(
  uuid, boolean, text, jsonb, jsonb, text, integer, uuid, boolean
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_save_leaderboard_reward_setup(
  uuid, boolean, text, jsonb, jsonb, text, integer, uuid, boolean
) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_complete_club_opening_setup(
  uuid, uuid, text, numeric, numeric, boolean, numeric, boolean, numeric, numeric,
  boolean, text, text, text, numeric, boolean, text, numeric, boolean
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_complete_club_opening_setup(
  uuid, uuid, text, numeric, numeric, boolean, numeric, boolean, numeric, numeric,
  boolean, text, text, text, numeric, boolean, text, numeric, boolean
) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz)
  TO service_role;
REVOKE ALL ON FUNCTION public.fn_get_leaderboard_reward_setup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_leaderboard_reward_setup(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.fn_get_leaderboard_settlement_status(uuid, text, date)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_leaderboard_settlement_status(uuid, text, date)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.fn_complete_club_opening_setup(
  uuid, uuid, text, numeric, numeric, boolean, numeric, boolean, numeric, numeric,
  boolean, text, text, text, numeric, boolean, text, numeric, boolean
) IS
  'Owner-only, one-time Club Opening Wizard commit. Configures rake, optionally seeds BBJ and Spins, optionally funds the first promotion, and explicitly publishes a display-only or prize leaderboard plan against the program''s current version. A paid plan''s first round is its explicit seed, written on the setup row before publication so the funding gate counts it; the owner''s explicit Club Bank overlay answer (default off) is recorded on the program. Records immutable funding evidence and rolls every step back on failure.';
COMMENT ON FUNCTION public.fn_publish_leaderboard_reward_program(
  uuid, boolean, text, jsonb, jsonb, text, integer, uuid, boolean
) IS
  'Service-only immutable leaderboard program publication. p_overlay_enabled (default false) is the owner''s explicit Club Bank overlay opt-in, allowed only on a paid standalone club program.';
COMMENT ON FUNCTION public.fn_payout_leaderboard(uuid, text, text, timestamptz, timestamptz) IS
  'Atomic service-only leaderboard settlement. Pays from the opening seed, then the recorded Promo Wallet. A shortfall is paid from the club''s own Club Bank, as a separate overlay leg recorded on the batch, only when the round''s immutable standalone club program carries the owner''s explicit opt-in; otherwise, or when the Club Bank cannot cover it, the round stays unpaid and retryable. Splits occupied prizes across ties exactly, credits winners once, and writes immutable batch-linked receipts.';
COMMENT ON FUNCTION public.fn_settle_due_leaderboards() IS
  'Service-only scheduler. Retries every closed unpaid immutable program and records categorized attempt history. It never debits an operating wallet on its own authority: only a standalone club program whose owner explicitly opted into the Club Bank overlay lets settlement pay a Promo Wallet shortfall from that club''s bank, as its own recorded overlay leg.';

-- ---------------------------------------------------------------------------
DO $post$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('public.fn_enforce_leaderboard_program_funding()', '82d95908883bb20269653a348eae124e', '5e9daeca352e313dfd03ff960e5316b4', 'postgres:EXECUTE,service_role:EXECUTE'),
    ('public.fn_publish_leaderboard_reward_program(uuid,boolean,text,jsonb,jsonb,text,integer,uuid,boolean)', 'ef4ab9935eb3681ba4f1ab068a8b65fd', '897cb1df3bb6cf38e2bb4847f3658c43', 'postgres:EXECUTE,service_role:EXECUTE'),
    ('public.fn_save_leaderboard_reward_setup(uuid,boolean,text,jsonb,jsonb,text,integer,uuid,boolean)', '26750969be5357237807a3a2af0ee541', '75cf15ce9dc4161ec8ba403a8cb1282e', 'authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE'),
    ('public.fn_complete_club_opening_setup(uuid,uuid,text,numeric,numeric,boolean,numeric,boolean,numeric,numeric,boolean,text,text,text,numeric,boolean,text,numeric,boolean)', '712c1ae90f947841bca28ff64bc0fb3e', '0ec0f9c3490d7c8ce3b42a1c37426401', 'authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE'),
    ('public.fn_payout_leaderboard(uuid,text,text,timestamptz,timestamptz)', 'b311250f543badd00a461b461cf2b591', '3457438a87f4aa704fe2d12152fe8914', 'postgres:EXECUTE,service_role:EXECUTE'),
    ('public.fn_get_leaderboard_reward_setup(uuid)', '632fcb71bf1c65b2ddcd1d42979ad73c', 'ce9b151f9cdbc8788c8a8d0b2bb4c5c4', 'authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE'),
    ('public.fn_get_leaderboard_settlement_status(uuid,text,date)', 'a76567ffe56b43407dd50267f8b25362', '0b7d6d13a78da9f3f541bb6401bb1fc8', 'authenticated:EXECUTE,postgres:EXECUTE,service_role:EXECUTE')
  ) v(sig, src_md5, def_md5, grants) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
       WHERE p.oid = to_regprocedure(r.sig)
         AND md5(p.prosrc) = r.src_md5
         AND md5(pg_get_functiondef(p.oid)) = r.def_md5
         AND pg_get_userbyid(p.proowner) = 'postgres'
         AND (SELECT string_agg(e.grant_text, ',' ORDER BY e.grant_text)
                FROM (SELECT CASE WHEN g.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(g.grantee) END
                             || ':' || g.privilege_type AS grant_text
                        FROM aclexplode(p.proacl) g) e) = r.grants
         AND p.prosecdef
         AND p.proconfig = ARRAY['search_path=public, pg_temp']::text[]
    ) THEN
      RAISE EXCEPTION 'LEADERBOARD_OPENING_SEED_POSTIMAGE_DRIFT: %', r.sig;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_catalog.pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('fn_publish_leaderboard_reward_program',
                           'fn_save_leaderboard_reward_setup',
                           'fn_complete_club_opening_setup')) <> 3 THEN
    RAISE EXCEPTION 'LEADERBOARD_OPENING_SEED_POSTIMAGE_DRIFT: an overload survived';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute a
      JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = 'public.leaderboard_reward_program_versions'::regclass
       AND a.attname = 'overlay_enabled' AND a.attnotnull
       AND pg_get_expr(d.adbin, d.adrelid) = 'false'
  ) OR EXISTS (
    SELECT 1 FROM public.leaderboard_reward_program_versions program
     WHERE program.overlay_enabled
  ) THEN
    RAISE EXCEPTION 'LEADERBOARD_OPENING_SEED_POSTIMAGE_DRIFT: an existing program is not OFF';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'public.leaderboard_payout_batches'::regclass
       AND c.conname = 'leaderboard_payout_batches_promo_only_check'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'public.leaderboard_payout_batches'::regclass
       AND c.conname = 'leaderboard_payout_batches_overlay_is_the_club_bank_only'
       AND c.convalidated
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
     WHERE c.conrelid = 'public.leaderboard_reward_program_versions'::regclass
       AND c.conname = 'leaderboard_reward_program_overlay_scope'
       AND c.convalidated
  ) THEN
    RAISE EXCEPTION 'LEADERBOARD_OPENING_SEED_POSTIMAGE_DRIFT: the funding checks are not in place';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_trigger t
     WHERE t.tgrelid = 'public.leaderboard_reward_program_versions'::regclass
       AND t.tgname = 'leaderboard_program_funding_gate'
       AND t.tgfoid = 'public.fn_enforce_leaderboard_program_funding()'::regprocedure
       AND t.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'LEADERBOARD_OPENING_SEED_POSTIMAGE_DRIFT: the funding gate trigger moved';
  END IF;
END
$post$;

COMMIT;
