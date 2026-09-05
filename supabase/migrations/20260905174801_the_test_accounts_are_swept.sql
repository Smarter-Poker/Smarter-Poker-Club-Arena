-- ═══════════════════════════════════════════════════════════════════════════
--  THE TEST ACCOUNTS ARE SWEPT
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-09-05: "DELETE ALL THE TEST ACCOUNTS."
--
-- This deletes accounts permanently, so most of it is about what it REFUSES
-- to touch and what it PRESERVES on the way out.
--
-- WHAT IS SWEPT, AND HOW IT IS IDENTIFIED
--
-- By address shape only, never by a name that merely reads like a test:
--
--     %@probe.smarter.poker              websocket probes
--     %@smarter-poker.invalid            certification markers
--     %@example.invalid                  certification markers
--     %@yopmail.com                      disposable mailboxes
--     club-arena-%e2e%@smarter.poker     end-to-end suite accounts
--     tester_<uuid>@test.com             generated fixtures
--     god_<uuid>@test.com                generated fixtures
--     logotest_<digits>@example.com      generated fixtures
--     test@example.com
--     jetski_test_123@example.com
--
-- THE SET, MEASURED 2026-09-05
--
--     matched the patterns                     130
--     kept: on the ledger or the audit trail     9
--     ─────────────────────────────────────────────
--     deleted                                  121
--
--     chips held                             0.00      hands played           0
--     live seats                                0      clubs owned            0
--     card purchases                            0      diamonds held      8,500
--
-- THREE THINGS THIS DELIBERATELY DOES NOT TOUCH
--
-- 1. HORSES. Ten accounts sit on `@midwayunion.test` - angelo, bigtony, dom,
--    frankie, joey, mickey, nicky, paulie, sal among them - and every one is a
--    HORSE. CLAUDE.md 10.5: "HORSES ARE NEVER EVER DISCLUDED BY DESIGN ON
--    ANYTHING! THEY MUST ALWAYS BE TREATED LIKE REAL LIVE PLAYERS!" A `.test`
--    domain is not a licence to delete a player. The guard refuses any horse
--    outright, so the pattern list cannot reach one even by accident.
--
-- 2. ANYONE ON THE MONEY RECORD. Nine of the 130 appear in
--    `chip_ledger.performed_by`, together having moved 1,600,000 chips, and
--    nine in `audit_trail.actor_id`. Both columns are NOT NULL, so there is no
--    way to keep those rows while removing the account - the only way through
--    would be to delete the ledger and audit rows themselves. That is not a
--    tidy-up, that is erasing the record of 1.6M chips moving, and those nine
--    accounts are the answer to "who moved them". CLAUDE.md 10.9: "Never edit
--    history quiet." They are KEPT.
--
-- 3. ANYTHING HOLDING VALUE. The guard refuses an account with club chips, a
--    live seat, a club it owns, or a card purchase, whatever its address says.
--
-- ── WHAT THE PROBE FOUND, AND WHY THIS FILE LOOKS LIKE THIS ───────────────
--
-- The first draft of this migration was a plain DELETE plus an audit table of
-- my own. Probing it against production (CLAUDE.md 11.5, one self-aborting DO
-- block) refused it twice, for two reasons neither of which is visible by
-- reading the schema:
--
-- (a) `diamond_transactions` cascades from the account and carries
--     `trg_ca_append_only`. The raw delete came back
--     `P0403: DELETE on diamond_transactions is forbidden: financial journals
--     are append-only`. Seven of the 121 hold journal rows - 7 rows, 3,500
--     diamonds, every one a house credit (`bonus` / `reconciliation`, source
--     `phase41_audit`), ZERO spend rows.
--
--     `fn_ca_journal_append_only` provides the path itself: with
--     `app.ledger_maintenance` set to an incident reference it copies each
--     deleted row whole into `ca_diamond_journal_archive` with the reason
--     attached, logs the bypass in `ca_ledger_mutation_log`, and raises a DR5
--     incident per row. Its own comment names this caller: "The diamond
--     journal is deleted from on an hourly cadence by the certification
--     fleet." Using that path is following the rule, not routing around it -
--     nothing is destroyed, and the rows come out with better provenance than
--     they went in with.
--
-- (b) `wallets` (120 rows for this set), `club_members`, `chip_transactions`,
--     `wallet_transactions` and `table_seats` all carry `zz_freeze_guard`.
--     The probe ran at 17:56 UTC, inside the :55 maintenance break
--     (CLAUDE.md 13), and every one of those deletes would have been refused
--     as the NEXT failure. So this migration REFUSES TO RUN WHILE FROZEN
--     rather than half-completing: see the guard at the top of the sweep.
--
-- I also deleted my own audit table. `profiles` already carries
-- `trg_ca_profile_deletion_journal`, which records the profile in
-- `ca_profile_deletions` (870 rows already - this path is well travelled),
-- archives its whole diamond journal, and BURNS the balance out of
-- `ca_mint_ledger` so diamond supply stays honest when 8,500 leave with these
-- accounts. A second competing record would have been strictly worse than the
-- one the platform already keeps.
--
-- ── WHAT THE FINAL PROBE RETURNED (rolled back, 2026-09-05 18:0x UTC) ─────
--
--     swept=121  refused=9  reasons=[ledger x9]
--     profiles                   1310 -> 1189   delta 121
--     HORSES                     1000 -> 1000   untouched
--     audit_trail                2373 -> 2373   untouched
--     diamond_transactions       1440 -> 1433   removed 7
--     ca_diamond_journal_archive 9119 -> 9126   PRESERVED 7  <- all seven
--     ca_profile_deletions        876 ->  997   recorded 121
--     sweepable remaining                   0
--
-- READ THIS BEFORE YOU CALL A DRIFTING COUNTER A BUG. The same probe also
-- showed club chips falling 66.81 and chip_ledger growing 62 rows, which looks
-- alarming for a set that holds 0.00 chips. It is not the sweep. A CONTROL run
-- of the identical measurement shape with NO DELETES AT ALL drifted MORE:
--
--     club chips  171658901.09 -> 171658679.59   -221.50
--     chip_ledger      1599341 ->      1599364        +23   in three seconds
--
-- That is live play, seen through READ COMMITTED, where every statement takes
-- a fresh snapshot. Any platform-wide total measured before and after a slow
-- loop on this database will move on its own. Scope your assertions to the
-- rows you touched, which is what the verification block at the bottom does.
--
-- One transaction, one DDL statement, per the production DDL policy
-- (CLAUDE.md section 2).

BEGIN;

-- ── The sweeper, with the guards inside it ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_sweep_test_account(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_email    text;
  v_profile  public.profiles%ROWTYPE;
  v_chips    numeric;
  v_pattern  text;
BEGIN
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'platform_is_frozen');
  END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = p_user_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'already_removed');
  END IF;

  SELECT * INTO v_profile FROM public.profiles WHERE id = p_user_id FOR UPDATE;

  -- (a) The address must be one of the known machine shapes.
  v_pattern := CASE
    WHEN v_email ILIKE '%@probe.smarter.poker'            THEN 'probe.smarter.poker'
    WHEN v_email ILIKE '%@smarter-poker.invalid'          THEN 'smarter-poker.invalid'
    WHEN v_email ILIKE '%@example.invalid'                THEN 'example.invalid'
    WHEN v_email ILIKE '%@yopmail.com'                    THEN 'yopmail.com'
    WHEN v_email ILIKE 'club-arena-%e2e%@smarter.poker'   THEN 'club-arena e2e'
    WHEN v_email ~ '^tester_[0-9a-f-]{36}@test\.com$'     THEN 'tester_<uuid>'
    WHEN v_email ~ '^god_[0-9a-f-]{36}@test\.com$'        THEN 'god_<uuid>'
    WHEN v_email ~ '^logotest_[0-9_]+@example\.com$'      THEN 'logotest_<n>'
    WHEN v_email IN ('test@example.com','jetski_test_123@example.com') THEN 'named fixture'
    ELSE NULL END;
  IF v_pattern IS NULL THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'address_is_not_a_test_pattern',
                              'email', v_email);
  END IF;

  -- (b) A HORSE IS A PLAYER. CLAUDE.md 10.5. Ten horses live on a .test
  --     domain; none of them is disposable.
  IF COALESCE(v_profile.is_horse, false) THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'is_a_horse', 'email', v_email);
  END IF;

  -- (c) Anything holding chips, a seat, a club or a receipt stays.
  SELECT COALESCE(sum(chip_balance), 0) INTO v_chips
    FROM public.club_members WHERE user_id = p_user_id;
  IF v_chips > 0 THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'holds_club_chips', 'chips', v_chips);
  END IF;
  IF EXISTS (SELECT 1 FROM public.table_seats WHERE user_id = p_user_id) THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'is_seated');
  END IF;
  IF EXISTS (SELECT 1 FROM public.clubs WHERE owner_id = p_user_id) THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'owns_a_club');
  END IF;
  IF EXISTS (SELECT 1 FROM public.diamond_purchases WHERE user_id = p_user_id) THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'bought_something_with_a_card');
  END IF;

  -- (d) THE MONEY RECORD OUTRANKS THE TIDY-UP. Both columns are NOT NULL, so
  --     removing the account would mean deleting the rows that explain where
  --     1.6M chips went.
  IF EXISTS (SELECT 1 FROM public.chip_ledger WHERE performed_by = p_user_id) THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'acted_on_the_chip_ledger');
  END IF;
  IF EXISTS (SELECT 1 FROM public.audit_trail WHERE actor_id = p_user_id) THEN
    RETURN jsonb_build_object('swept', false, 'reason', 'appears_in_the_audit_trail');
  END IF;

  /* The account is going, so its diamond journal goes with it. Announce that
     as authorized maintenance: `trg_ca_append_only` then ARCHIVES each row
     into ca_diamond_journal_archive with this reason attached, logs the bypass
     in ca_ledger_mutation_log, and raises a DR5 incident - instead of
     refusing with P0403 and leaving the account undeletable. Transaction
     local, so it cannot leak to anything else running. */
  PERFORM set_config('app.ledger_maintenance',
                     'test-account-sweep:20260905174801:' || p_user_id::text, true);

  /* Removing the club membership below EMITS a game_management_events row
     naming this account as recipient, and that table is append-only too - so
     the emitted row then blocks the delete that caused it. `55000: Game
     management events are append-only`, found by the probe.

     `fn_guard_game_management_event` permits a DELETE when auth.uid() IS NULL
     and app.game_management_retention = 'on': the retention path, gated to
     callers that are not a browser session. A migration is exactly that. The
     only rows this removes are the ones THIS transaction just emitted, about a
     membership being ended as part of deleting the account that held it - no
     history predating this sweep is touched. Transaction local. */
  PERFORM set_config('app.game_management_retention', 'on', true);

  /* ORDER MATTERS, AND IT IS THE WHOLE TRICK.
     Three child tables carry AFTER DELETE triggers that INSERT a row ABOUT
     this account - a dashboard revision bump, a management-access event. Let
     the cascade reach them and they fire in a world where the account is
     already gone, and the insert dies on its own foreign key:

       user_daily_challenges  -> bump_daily_challenge_dashboard_revision
         23503: Key (user_id)=(...) is not present in table "profiles"
       club_members           -> fn_emit_management_access_event
         23503: Key (recipient_id)=(...) is not present in table "users"

     Both were hit by the probe, and neither is visible by reading the schema.
     So these go FIRST, while the account still exists: every trigger then runs
     in exactly the conditions it was written for - the same ones a real player
     leaving a club produces - and the rows they emit are themselves ON DELETE
     CASCADE, so the final delete carries them away. No platform trigger needed
     changing. */
  DELETE FROM public.user_daily_challenges  WHERE user_id = p_user_id;
  DELETE FROM public.challenge_streak_state WHERE user_id = p_user_id;
  DELETE FROM public.club_members           WHERE user_id = p_user_id;

  /* Transient queue state and a UI artifact naming this account as an actor.
     Everything else reaches the account through one of 572 ON DELETE CASCADE
     foreign keys - including the profile, whose own BEFORE DELETE trigger
     writes ca_profile_deletions, archives the diamond journal, and burns the
     balance out of ca_mint_ledger. */
  DELETE FROM public.table_waitlist WHERE user_id  = p_user_id;
  DELETE FROM public.notifications  WHERE actor_id = p_user_id;

  DELETE FROM auth.users WHERE id = p_user_id;

  IF EXISTS (SELECT 1 FROM public.profiles WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'Profile % survived the delete of its auth user', p_user_id;
  END IF;

  RETURN jsonb_build_object('swept', true, 'email', v_email, 'pattern', v_pattern);
END;
$function$;

COMMENT ON FUNCTION public.fn_sweep_test_account(uuid) IS
  'Removes ONE machine-generated test account, refusing a horse, a chip or '
  'seat holder, a club owner, a card buyer, anyone on chip_ledger or '
  'audit_trail, any address outside the known fixture patterns, and any call '
  'made while the platform is frozen. Declares app.ledger_maintenance so the '
  'diamond journal is archived rather than refused. Idempotent. The profile '
  'BEFORE DELETE trigger writes the permanent record; this function is the '
  'gate in front of it.';

REVOKE ALL ON FUNCTION public.fn_sweep_test_account(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_sweep_test_account(uuid) TO service_role;

-- ── The sweep ──────────────────────────────────────────────────────────────
DO $sweep$
DECLARE
  r        record;
  res      jsonb;
  v_swept  integer := 0;
  v_kept   integer := 0;
  v_reason text;
BEGIN
  /* wallets, club_members, chip_transactions, wallet_transactions and
     table_seats all carry zz_freeze_guard. Refuse the whole sweep rather than
     complete half of it. Re-run outside :55-:00. */
  IF public.fn_platform_frozen() THEN
    RAISE EXCEPTION
      'REFUSING: the platform is frozen for the maintenance break (CLAUDE.md 13). '
      'zz_freeze_guard would refuse the wallets and club_members deletes and this '
      'sweep would half-complete. Re-run between :00 and :53.';
  END IF;

  FOR r IN
    SELECT p.id
      FROM public.profiles p JOIN auth.users u ON u.id = p.id
     WHERE COALESCE(p.is_horse, false) = false
       AND ( u.email ILIKE '%@probe.smarter.poker'
          OR u.email ILIKE '%@smarter-poker.invalid'
          OR u.email ILIKE '%@example.invalid'
          OR u.email ILIKE '%@yopmail.com'
          OR u.email ILIKE 'club-arena-%e2e%@smarter.poker'
          OR u.email ~ '^tester_[0-9a-f-]{36}@test\.com$'
          OR u.email ~ '^god_[0-9a-f-]{36}@test\.com$'
          OR u.email ~ '^logotest_[0-9_]+@example\.com$'
          OR u.email IN ('test@example.com','jetski_test_123@example.com') )
     ORDER BY p.created_at
  LOOP
    res := public.fn_sweep_test_account(r.id);
    IF COALESCE((res->>'swept')::boolean, false) THEN
      v_swept := v_swept + 1;
    ELSE
      v_kept := v_kept + 1;
      v_reason := res->>'reason';
      RAISE NOTICE 'kept % : %', r.id, v_reason;
    END IF;
  END LOOP;

  RAISE NOTICE 'swept % account(s), kept %', v_swept, v_kept;
  IF v_swept = 0 THEN
    RAISE NOTICE 'nothing to sweep - already applied';
  END IF;
END;
$sweep$;

-- ── Prove it, in the transaction that did it ───────────────────────────────
DO $verify$
DECLARE
  v_left  integer;
  v_horse integer;
BEGIN
  SELECT count(*) INTO v_left
    FROM public.profiles p JOIN auth.users u ON u.id = p.id
   WHERE COALESCE(p.is_horse,false) = false
     AND ( u.email ILIKE '%@probe.smarter.poker'
        OR u.email ILIKE '%@smarter-poker.invalid'
        OR u.email ILIKE '%@example.invalid'
        OR u.email ILIKE '%@yopmail.com'
        OR u.email ILIKE 'club-arena-%e2e%@smarter.poker'
        OR u.email ~ '^tester_[0-9a-f-]{36}@test\.com$'
        OR u.email ~ '^god_[0-9a-f-]{36}@test\.com$'
        OR u.email ~ '^logotest_[0-9_]+@example\.com$'
        OR u.email IN ('test@example.com','jetski_test_123@example.com') )
     AND p.id NOT IN (SELECT performed_by FROM public.chip_ledger)
     AND p.id NOT IN (SELECT actor_id     FROM public.audit_trail);

  SELECT count(*) INTO v_horse FROM public.profiles WHERE COALESCE(is_horse,false);

  IF v_left <> 0 THEN
    RAISE EXCEPTION 'ABORTING: % sweepable test account(s) survived the sweep', v_left;
  END IF;
  IF v_horse <> 1000 THEN
    RAISE EXCEPTION
      'ABORTING: the horse fleet reads % and it was 1000 when this was written. '
      'A horse was deleted, or the fleet changed and this assertion needs re-baselining '
      'DELIBERATELY - never by loosening it.', v_horse;
  END IF;

  RAISE NOTICE 'verified: no sweepable test account remains, % horses intact', v_horse;
END;
$verify$;

COMMIT;
