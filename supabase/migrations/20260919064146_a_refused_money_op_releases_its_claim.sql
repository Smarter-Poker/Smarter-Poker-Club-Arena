-- 20260919064146_a_refused_money_op_releases_its_claim
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-09-19 06:41:46 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHAT WAS WRONG
--
-- fn_ca_mint and fn_ca_burn take the idempotency claim BEFORE they do the
-- work:
--
--     INSERT INTO public.ca_op_claims (op_id, fn_name, claimed_by) VALUES ...
--     PERFORM pg_advisory_xact_lock(...);
--     ... the work ...
--     UPDATE public.ca_op_claims SET result = v_result, finalized_at = now() ...
--
-- Everything between those two statements that says no says it with a plain
-- plpgsql RETURN, not an exception. A RETURN rolls nothing back, so the claim
-- row commits with result NULL and finalized_at NULL and stays that way for
-- good. The operation never happened; the row says somebody is still doing it.
--
-- MEASURED IN PRODUCTION, 2026-09-19 06:20-06:35 UTC. Every figure below was
-- read, not assumed.
--
--   289 rows in public.ca_op_claims have finalized_at NULL and were claimed
--   more than an hour ago. All 289 are fn_ca_mint. All were claimed between
--   2026-09-08 06:20:44 and 2026-09-09 06:09:53 and none since; fn_ca_mint has
--   run and finalized normally ever since, most recently 2026-09-19 04:13:23.
--   260 carry a 'signup:<uid>' op id and 29 a
--   'daily-missions-historical-fixture:<...>' one. All 289 have result NULL
--   and claimed_by NULL, which is the trigger door: handle_new_user mints
--   inside a trigger where auth.uid() is NULL.
--
--   NO MONEY MOVED FOR ANY OF THEM. Of the 289: 0 have a ca_mint_ledger row
--   under their op id, 0 have a chip_ledger leg under 'mint:<op id>', and 0
--   have a diamond_transactions row under reference_id = op id. A crash cannot
--   produce one of these rows - a dead backend takes the claim INSERT down
--   with the rest of its transaction - so a committed claim with no result is
--   always a refusal that returned, and these are.
--
--   The refusal was the ceiling. In the 24 hours ending at one of those claims
--   (signup:43b13734-bbd8-4f95-aecd-5a481a7d0fbc, 2026-09-08 18:32:56)
--   diamond issuance was 2,784,110 over 36,816 mint rows, against
--   ca_mint_policy.rolling_24h_cap_diamonds of 2,000,000. The ceiling did
--   exactly its job and refused. The claim it had already taken is what stayed
--   behind.
--
-- WHY IT MATTERS EVEN THOUGH NOTHING IS STUCK
--
-- A stranded claim does not block a retry: both doors DELETE an unfinalized
-- claim for the same op id and take it again, so idempotency still holds. What
-- it does is hold an alarm red for ever. scripts/ci/check-chip-conservation.mjs
-- fails when ANY claim has been open longer than an hour, and that check is
-- the only thing watching for a money operation that stopped half way. With
-- 289 permanent rows under it, it can never go green, so it can never go red
-- at anyone. An alarm that is always red is not an alarm.
--
-- fn_ca_burn has the same shape and has simply not been asked yet: seven of
-- its refusals sit after the claim, four of them the "that would take it below
-- zero" guards an operator meets first. It has 0 open claims today by luck,
-- not by construction.
--
-- WHAT THIS CHANGES
--
--   1. public.fn_ca_release_claim(fn, op_id, refusal) releases an UNFINALIZED
--      claim and hands the refusal straight back. A refusal site cannot return
--      without releasing, because the refusal value only exists on the far
--      side of the release. It never touches a finalized claim, so a settled
--      result cannot be erased through it, and it is executable by nobody: the
--      two doors call it as their own definer.
--   2. Every refusal that sits after the claim returns through it - 4 in
--      fn_ca_mint, 7 in fn_ca_burn. Patched by marker against the live bodies,
--      each marker asserted to appear exactly once, so a sibling agent's
--      concurrent change elsewhere in either body survives this migration
--      instead of being overwritten by a stale CREATE OR REPLACE.
--   3. The 289 rows are removed - and ONLY rows carrying no money anywhere. A
--      claim with a register row, a journal leg or a diamond journal row under
--      its op id is left exactly where it is, and the audit stays red at it,
--      which is what a genuinely half-finished operation should look like.
--   4. It proves itself against the live catalog before it commits: it raises
--      if either body still has a refusal after the claim that returns
--      without releasing it, and it reports what is left open. A claim that
--      survives section 5 does so because it carries money evidence, and that
--      is a real half-finished operation - it is reported loudly and left
--      alone, not rolled back over.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- It issues nothing. One of the 260 refused signup grants belongs to a player
-- who still exists: 43b13734-bbd8-4f95-aecd-5a481a7d0fbc, profile created
-- 2026-09-08 18:31:39, refused 77 seconds later, first diamond credit at
-- 18:49:13 from training rewards. The other 259 profiles are gone. Whether
-- that one grant is made good is a decision about a player's balance, not a
-- defect in a door, and it is not taken here.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. The release.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_ca_release_claim(
  p_fn text, p_op_id text, p_refusal jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn_ca_release_claim$
BEGIN
  -- Only ever an UNFINALIZED claim. A finalized row carries the result the
  -- door already returned once and every later call replays it; deleting one
  -- would turn a replay back into a second live operation.
  DELETE FROM public.ca_op_claims
   WHERE op_id = p_op_id AND fn_name = p_fn AND finalized_at IS NULL;
  RETURN p_refusal;
END
$fn_ca_release_claim$;

COMMENT ON FUNCTION public.fn_ca_release_claim(text, text, jsonb) IS
  'Releases the unfinalized idempotency claim a money door took before it refused, and returns the refusal unchanged. Called only from inside fn_ca_mint and fn_ca_burn, which run as their own definer. Never touches a finalized claim.';

REVOKE ALL ON FUNCTION public.fn_ca_release_claim(text, text, jsonb) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The apply-time patcher, exactly as 20260908021452 used it: patch the LIVE
--    body by marker so a concurrent change elsewhere in it is not lost.
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
-- 3. fn_ca_mint: the four refusals that sit after the claim.
-- ---------------------------------------------------------------------------

-- 3a. The rolling 24h ceiling. This is the one that actually fired, 289 times.
SELECT pg_temp.ca_patch('fn_ca_mint',
$ca_from$    RETURN jsonb_build_object('ok', false, 'reason', 'over_the_rolling_24h_issuance_ceiling',
                              'ceiling', v_roll, 'issued_24h', v_24h - p_amount, 'requested', p_amount);$ca_from$,
$ca_to$    RETURN public.fn_ca_release_claim('fn_ca_mint', p_op_id,
             jsonb_build_object('ok', false, 'reason', 'over_the_rolling_24h_issuance_ceiling',
                              'ceiling', v_roll, 'issued_24h', v_24h - p_amount, 'requested', p_amount));$ca_to$, 1);

-- 3b. The target lookups. All three read with FOR UPDATE and write nothing
--     before they refuse, so the claim is the only thing to give back.
SELECT pg_temp.ca_patch('fn_ca_mint',
$ca_from$        RETURN jsonb_build_object('ok', false, 'reason', 'player_not_found');$ca_from$,
$ca_to$        RETURN public.fn_ca_release_claim('fn_ca_mint', p_op_id,
                 jsonb_build_object('ok', false, 'reason', 'player_not_found'));$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_mint',
$ca_from$        RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');$ca_from$,
$ca_to$        RETURN public.fn_ca_release_claim('fn_ca_mint', p_op_id,
                 jsonb_build_object('ok', false, 'reason', 'club_not_found'));$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_mint',
$ca_from$        RETURN jsonb_build_object('ok', false, 'reason', 'union_not_found');$ca_from$,
$ca_to$        RETURN public.fn_ca_release_claim('fn_ca_mint', p_op_id,
                 jsonb_build_object('ok', false, 'reason', 'union_not_found'));$ca_to$, 1);

-- ---------------------------------------------------------------------------
-- 4. fn_ca_burn: the seven refusals that sit after the claim.
-- ---------------------------------------------------------------------------

SELECT pg_temp.ca_patch('fn_ca_burn',
$ca_from$        RETURN jsonb_build_object('ok', false, 'reason', 'that_would_take_the_house_below_zero',
                                  'balance', v_before, 'requested', p_amount);$ca_from$,
$ca_to$        RETURN public.fn_ca_release_claim('fn_ca_burn', p_op_id,
                 jsonb_build_object('ok', false, 'reason', 'that_would_take_the_house_below_zero',
                                  'balance', v_before, 'requested', p_amount));$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_burn',
$ca_from$        RETURN jsonb_build_object('ok', false, 'reason', 'player_not_found');$ca_from$,
$ca_to$        RETURN public.fn_ca_release_claim('fn_ca_burn', p_op_id,
                 jsonb_build_object('ok', false, 'reason', 'player_not_found'));$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_burn',
$ca_from$        RETURN jsonb_build_object('ok', false, 'reason', 'that_would_take_the_balance_below_zero',
                                  'balance', v_before, 'requested', p_amount);$ca_from$,
$ca_to$        RETURN public.fn_ca_release_claim('fn_ca_burn', p_op_id,
                 jsonb_build_object('ok', false, 'reason', 'that_would_take_the_balance_below_zero',
                                  'balance', v_before, 'requested', p_amount));$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_burn',
$ca_from$        RETURN jsonb_build_object('ok', false, 'reason', 'club_not_found');$ca_from$,
$ca_to$        RETURN public.fn_ca_release_claim('fn_ca_burn', p_op_id,
                 jsonb_build_object('ok', false, 'reason', 'club_not_found'));$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_burn',
$ca_from$        RETURN jsonb_build_object('ok', false, 'reason', 'that_would_take_the_treasury_below_zero',
                                  'balance', v_before, 'requested', p_amount);$ca_from$,
$ca_to$        RETURN public.fn_ca_release_claim('fn_ca_burn', p_op_id,
                 jsonb_build_object('ok', false, 'reason', 'that_would_take_the_treasury_below_zero',
                                  'balance', v_before, 'requested', p_amount));$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_burn',
$ca_from$        RETURN jsonb_build_object('ok', false, 'reason', 'union_wallet_not_found');$ca_from$,
$ca_to$        RETURN public.fn_ca_release_claim('fn_ca_burn', p_op_id,
                 jsonb_build_object('ok', false, 'reason', 'union_wallet_not_found'));$ca_to$, 1);

SELECT pg_temp.ca_patch('fn_ca_burn',
$ca_from$        RETURN jsonb_build_object('ok', false, 'reason', 'that_would_take_the_union_bank_below_zero',
                                  'balance', v_before, 'requested', p_amount);$ca_from$,
$ca_to$        RETURN public.fn_ca_release_claim('fn_ca_burn', p_op_id,
                 jsonb_build_object('ok', false, 'reason', 'that_would_take_the_union_bank_below_zero',
                                  'balance', v_before, 'requested', p_amount));$ca_to$, 1);

-- ---------------------------------------------------------------------------
-- 5. The 289 rows, and only rows that carry no money anywhere.
-- ---------------------------------------------------------------------------
DO $release_the_residue$
DECLARE
  v_before integer;
  v_deleted integer;
  v_kept integer;
BEGIN
  SELECT count(*) INTO v_before FROM public.ca_op_claims
   WHERE finalized_at IS NULL AND claimed_at < now() - interval '1 hour';

  WITH gone AS (
    DELETE FROM public.ca_op_claims c
     WHERE c.finalized_at IS NULL
       AND c.result IS NULL
       AND c.claimed_at < now() - interval '1 hour'
       -- The register.
       AND NOT EXISTS (SELECT 1 FROM public.ca_mint_ledger m WHERE m.op_id = c.op_id)
       -- The chip journal, under either door's key.
       AND NOT EXISTS (SELECT 1 FROM public.chip_ledger l
                        WHERE l.idempotency_key IN ('mint:' || c.op_id, 'burn:' || c.op_id))
       -- The diamond journal, under the op id as reference.
       AND NOT EXISTS (SELECT 1 FROM public.diamond_transactions d WHERE d.reference_id = c.op_id)
    RETURNING 1)
  SELECT count(*) INTO v_deleted FROM gone;

  SELECT count(*) INTO v_kept FROM public.ca_op_claims
   WHERE finalized_at IS NULL AND claimed_at < now() - interval '1 hour';

  RAISE NOTICE 'ca_op_claims: % open over an hour, % released as carrying no money, % kept',
    v_before, v_deleted, v_kept;
END
$release_the_residue$;

-- ---------------------------------------------------------------------------
-- 6. The assertions. Both read the live catalog, not this file.
-- ---------------------------------------------------------------------------
DO $prove_it$
DECLARE
  v_fn text;
  v_def text;
  v_tail text;
  v_bare integer;
  v_released integer;
  v_open integer;
BEGIN
  FOREACH v_fn IN ARRAY ARRAY['fn_ca_mint', 'fn_ca_burn'] LOOP
    SELECT pg_get_functiondef(p.oid) INTO v_def
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = v_fn;

    -- Everything after the door takes its claim.
    IF position('INSERT INTO public.ca_op_claims' in v_def) = 0 THEN
      RAISE EXCEPTION '% no longer takes a claim - this migration is reasoning about a body that has changed', v_fn;
    END IF;
    v_tail := substr(v_def, position('INSERT INTO public.ca_op_claims' in v_def));

    v_bare := (length(v_tail) - length(replace(v_tail, 'RETURN jsonb_build_object(''ok'', false', '')))
              / length('RETURN jsonb_build_object(''ok'', false');
    IF v_bare <> 0 THEN
      RAISE EXCEPTION '% still has % refusal(s) after the claim that return without releasing it', v_fn, v_bare;
    END IF;

    v_released := (length(v_tail) - length(replace(v_tail, 'RETURN public.fn_ca_release_claim(', '')))
                 / length('RETURN public.fn_ca_release_claim(');
    IF v_released < 1 THEN
      RAISE EXCEPTION '% has no released refusal after the claim - the patch did not land', v_fn;
    END IF;
    RAISE NOTICE '%: % refusals after the claim, all released', v_fn, v_released;
  END LOOP;

  -- A claim still open here carries money evidence, so section 5 left it alone
  -- on purpose. That is a real half-finished operation and it must stay
  -- visible: check-chip-conservation.mjs keeps failing at it until a human has
  -- looked. It is not a reason to roll back the door fix above, so this warns
  -- rather than raises.
  SELECT count(*) INTO v_open FROM public.ca_op_claims
   WHERE finalized_at IS NULL AND claimed_at < now() - interval '1 hour';
  IF v_open <> 0 THEN
    RAISE WARNING 'ca_op_claims still holds % claim(s) open over an hour, each carrying money evidence under its op id - look at them by hand', v_open;
  ELSE
    RAISE NOTICE 'ca_op_claims: no claim open over an hour';
  END IF;
END
$prove_it$;

COMMIT;
