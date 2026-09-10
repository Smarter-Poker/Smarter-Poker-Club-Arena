-- a_player_id_is_a_uuid_not_a_uuid_version
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- HORSES ARE PLAYERS (CLAUDE.md 10.5), AND SO ARE 33 HUMANS WITH OLD IDS.
--
-- Two bounty doors validate a player id with a regular expression that checks
-- the UUID *version* and *variant* nibbles:
--
--     '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
--                                 ^^^^^          ^^^^^^
--
-- A horse's identity is 00000000-0000-0000-0000-0000000000NN. Its version
-- nibble is 0 and its variant nibble is 0, so it fails - and the failure is not
-- "this horse is unusual", it is `invalid_claimants`, which refuses the whole
-- bounty claim.
--
-- Measured on production 2026-09-10: of 1,198 profiles, **95 fail that pattern
-- and all 1,198 are valid uuids** - 62 horses and, because the estate has ids
-- older than the v4 generator, **33 humans**. Any knockout whose claimant set
-- contains one of those 95 is refused; `eliminatePlayer` returns false; the
-- bust assignment pass aborts on the first refusal; and the event freezes with
-- its escrow undistributed. At 12:35 that was bb179b59 (Midnight Bounty,
-- 157.50 held, 20 busted players, every one of them a horse), 5e1f17e4
-- (Midweek Bounty, 485.00) and 7d240805 (Midweek Mystery, 939.00), each
-- retrying the same refusal about every fifteen seconds.
--
-- fn_exact_tournament_knockout_claimants uses the same pattern to decide who
-- is a claimant at all, so a horse that knocked somebody out was silently
-- dropped from the claim set before the door ever saw it. That is the same
-- shortcut 10.5 was written about: a horse pays the same buy-in and wins the
-- same bounty.
--
-- THE FIX: validate that a player id is a UUID, not that it is a UUID of a
-- particular version. The column it lands in is `uuid` typed and Postgres
-- accepts every one of these; the version nibble carries no authority here and
-- never did. Four predicates, two functions, patched by asserted substitution.
--
-- The three remaining uses of the version-checked pattern
-- (fn_attach_bounty_award_obligation, fn_attach_bounty_ledger_obligation,
-- fn_collect_bounty, fn_purchase_club_shop_item_diamonds) validate an
-- OBLIGATION or PURCHASE id that the platform itself generates with
-- gen_random_uuid(), never a player id, so they are left alone deliberately.
--
-- Wrap ALL DDL for one change in ONE transaction: every DDL statement fires
-- Supabase's schema-cache reload, which takes ~28s on this database, and ten
-- loose statements mean ten reloads (club-arena CLAUDE.md, production DDL policy).

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $body$
DECLARE
  v_def text;
  v_n integer;
  v_old CONSTANT text := '''^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$''';
  v_new CONSTANT text := '''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$''';
  v_rejected integer;
BEGIN
  -- the measurement this migration is built on, asserted before it acts
  SELECT count(*) INTO v_rejected FROM public.profiles p
   WHERE p.id::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  IF v_rejected = 0 THEN
    RAISE EXCEPTION 'no profile fails the version-checked pattern; this migration is being applied against a database it does not describe';
  END IF;

  -- 1. the bounty claim door: the claimant array and the hand payload
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_claim_bounty_legacy_candidate_20260907';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_claim_bounty_legacy_candidate_20260907 is missing'; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'bounty claim door carries % version-checked player-id pattern(s), expected 2', v_n;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);

  -- 2. the claimant resolver: who is counted as a claimant at all
  SELECT pg_get_functiondef(p.oid) INTO v_def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'fn_exact_tournament_knockout_claimants';
  IF v_def IS NULL THEN RAISE EXCEPTION 'fn_exact_tournament_knockout_claimants is missing'; END IF;
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'claimant resolver carries % version-checked player-id pattern(s), expected 2', v_n;
  END IF;
  EXECUTE replace(v_def, v_old, v_new);

  -- post-condition: neither function may still refuse a player for the shape
  -- of their id, and both must still refuse something that is not a uuid
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_claim_bounty_legacy_candidate_20260907',
                       'fn_exact_tournament_knockout_claimants')
     AND position(v_old IN pg_get_functiondef(p.oid)) > 0;
  IF v_n <> 0 THEN
    RAISE EXCEPTION '% player-id door(s) still carry the version-checked pattern', v_n;
  END IF;
  SELECT count(*) INTO v_n
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_claim_bounty_legacy_candidate_20260907',
                       'fn_exact_tournament_knockout_claimants')
     AND position(v_new IN pg_get_functiondef(p.oid)) > 0;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'expected both player-id doors to carry the uuid-shape pattern, found %', v_n;
  END IF;

  RAISE NOTICE 'a_player_id_is_a_uuid: % profile(s) were being refused by the version check', v_rejected;
END
$body$;

COMMIT;
