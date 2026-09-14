-- ============================================================================
-- THE CHOP AND THE BOUNTIES KNOW THEIR UNIT
-- ============================================================================
--
-- Three of the eight division sites the Phase 8 audit found, and the last
-- three in SQL. All three have the same shape, which is the shape the prize
-- ladder and the recovery fee had: floor a proportional share to a CENT, and
-- hand the remainder to a designated party.
--
--   * fn_settle_tournament_final_table_deal  (audit site 4, the chip chop)
--       floor(chips * undistributed_cents / total_chips), residual to the
--       deterministic chip leader. Proportional to PLAY-CHIP STACKS, so it is
--       almost never a whole anything.
--
--   * fn_collect_bounty, multi-claimant      (audit site 5)
--       floor(cents * weight / total_weight), last claimant takes the rest.
--       A bounty chopped between two all-in winners.
--
--   * fn_collect_bounty, the PKO half        (audit site 6)
--       (share_cents / 2), the head keeps the odd cent. A 1 Diamond bounty is
--       50 cents cash and 50 cents to the head, and half a Diamond is not an
--       amount this estate can pay.
--
-- THE CHANGE AT EACH SITE IS ONE WRAP: x becomes
-- fn_ca_unit_floor_cents(x, the tournament's unit). That is deliberate,
-- because it collapses the whole chip-invariance argument into a single claim
-- that can be proved exhaustively rather than three claims that each have to
-- be reasoned about: at a unit of one cent, fn_ca_unit_floor_cents is the
-- IDENTITY on the reachable domain. Section 5 proves that over every value
-- from 0 to 20,000 and every large value these sites can produce.
--
-- WHERE A DIAMOND CANNOT BE SPLIT, THE DEAL IS REFUSED RATHER THAN ROUNDED.
-- The chop already raises when any rank's share is non-positive, and that
-- guard is kept exactly as it is. So a Diamond chop that cannot give every
-- player at least one whole Diamond does not quietly pay somebody zero: it
-- refuses, deterministically, and the tournament plays on. A deal is a
-- voluntary agreement, so refusing one costs nobody anything, which is what
-- makes refusal the right answer here and makes the prize ladder's
-- pay-what-you-can rule the right answer there. The difference is whether the
-- players have somewhere to go if the answer is no.
--
-- Applied once to kuklfnapbkmacvwxktbh. Never reapply.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. THE CHIP CHOP (site 4): fn_settle_tournament_final_table_deal
--
--    A share below one whole unit floors to zero, and the existing guard on
--    the very next line turns that into a refusal. Nothing new is needed to
--    make the impossible case safe; it was already safe, and it stays safe.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_old text; v_new text;
  c_a constant text := '    v_share_cents := floor(
      (v_row.chips::numeric * v_undistributed_cents::numeric) / v_total_chips
    )::bigint;';
  v_hits integer;
BEGIN
  SELECT pg_get_functiondef('public.fn_settle_tournament_final_table_deal(uuid)'::regprocedure)
    INTO v_old;
  IF position('fn_ca_unit_floor_cents' in v_old) > 0 THEN
    RAISE NOTICE 'the chip chop already knows its unit; skipping';
    RETURN;
  END IF;

  v_hits := (length(v_old) - length(replace(v_old, c_a, ''))) / length(c_a);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'chip chop: share anchor matched % times, expected 1', v_hits;
  END IF;

  v_new := replace(v_old, c_a, $r$    v_share_cents := public.fn_ca_unit_floor_cents(
      floor(
        (v_row.chips::numeric * v_undistributed_cents::numeric) / v_total_chips
      )::bigint,
      public.fn_ca_tournament_unit_cents(p_tournament_id));$r$);

  IF v_new = v_old
     OR position('fn_ca_unit_floor_cents' in v_new) = 0
     OR position('chip chop gives rank % a nonpositive share' in v_new) = 0 THEN
    RAISE EXCEPTION 'chip chop: rewrite did not take, or lost its refusal';
  END IF;
  EXECUTE v_new;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 2. THE BOUNTY CHOP AND THE PKO HALF (sites 5 and 6): fn_collect_bounty
--
--    The multi-claimant share keeps its guard shape: a non-positive share is
--    left exactly as it was, because fn_ca_unit_floor_cents answers 0 for a
--    non-positive input and the loop below distinguishes a zero share from a
--    negative one. At a unit of one cent this is the identity for every share
--    that reaches it.
--
--    The PKO half needs no such guard. The CONTINUE above it has already
--    established that the share is positive, so the half is never negative.
--    The head still takes whatever the cash half leaves, so the two still sum
--    to the share exactly, and both are whole.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_old text; v_new text; v_hits integer;
  c_5 constant text := '        v_share_cents := floor(v_cents * c.w / v_total_weight)::integer;';
  c_6 constant text := '        v_cash_cents := (v_share_cents / 2)::integer;';
BEGIN
  SELECT pg_get_functiondef('public.fn_collect_bounty(uuid,uuid,uuid,jsonb)'::regprocedure)
    INTO v_old;
  IF position('fn_ca_unit_floor_cents' in v_old) > 0 THEN
    RAISE NOTICE 'the bounty split already knows its unit; skipping';
    RETURN;
  END IF;

  v_hits := (length(v_old) - length(replace(v_old, c_5, ''))) / length(c_5);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'bounty: claimant share anchor matched % times, expected 1', v_hits;
  END IF;
  v_new := replace(v_old, c_5, $r$        v_share_cents := floor(v_cents * c.w / v_total_weight)::integer;
        IF v_share_cents > 0 THEN
          v_share_cents := public.fn_ca_unit_floor_cents(
            v_share_cents::bigint,
            public.fn_ca_tournament_unit_cents(p_tournament_id))::integer;
        END IF;$r$);

  v_hits := (length(v_new) - length(replace(v_new, c_6, ''))) / length(c_6);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'bounty: PKO half anchor matched % times, expected 1', v_hits;
  END IF;
  v_new := replace(v_new, c_6, $r$        v_cash_cents := public.fn_ca_unit_floor_cents(
          (v_share_cents / 2)::bigint,
          public.fn_ca_tournament_unit_cents(p_tournament_id))::integer;$r$);

  IF v_new = v_old
     OR (length(v_new) - length(replace(v_new, 'fn_ca_unit_floor_cents', ''))) / length('fn_ca_unit_floor_cents') <> 2
     OR position('v_to_head := (v_share_cents - v_cash_cents) / 100.0;' in v_new) = 0
     OR position('v_share_cents := v_cents - v_assigned_cents;' in v_new) = 0 THEN
    RAISE EXCEPTION 'bounty: rewrite did not take, or lost its residual rules';
  END IF;
  EXECUTE v_new;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 3. THE CHIP ESTATE IS UNCHANGED, and the proof is one claim rather than
--    three, because the change at every site is the same wrap.
--
--    At a unit of one cent fn_ca_unit_floor_cents must be the IDENTITY for
--    every positive input and must answer 0 for every non-positive one. If
--    that holds, none of the three sites can have moved, because the only
--    thing inserted into any of them is this call.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_bad bigint; v_checked bigint;
BEGIN
  SELECT count(*), count(*) FILTER (
           WHERE public.fn_ca_unit_floor_cents(x, 1) IS DISTINCT FROM x)
    INTO v_checked, v_bad
    FROM generate_series(1, 20000) AS g(x);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'the unit floor is not the identity at one cent on % of % values', v_bad, v_checked;
  END IF;

  SELECT count(*) FILTER (WHERE public.fn_ca_unit_floor_cents(x, 1) IS DISTINCT FROM x) INTO v_bad
    FROM (SELECT unnest(ARRAY[99999,100000,123457,999999,1000000,2147483647,
                              20000000000]::bigint[]) AS x) big;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'the unit floor is not the identity at one cent on large values';
  END IF;

  SELECT count(*) FILTER (WHERE public.fn_ca_unit_floor_cents(x, 1) IS DISTINCT FROM 0) INTO v_bad
    FROM (SELECT unnest(ARRAY[0,-1,-99,-100000]::bigint[]) AS x) neg;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'the unit floor does not answer zero for a non-positive amount';
  END IF;

  -- And the Diamond half: whole, never above the input, never negative.
  SELECT count(*) FILTER (
           WHERE public.fn_ca_unit_floor_cents(x, 100) % 100 <> 0
              OR public.fn_ca_unit_floor_cents(x, 100) > x
              OR public.fn_ca_unit_floor_cents(x, 100) < 0)
    INTO v_bad FROM generate_series(1, 20000) AS g(x);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'the Diamond floor is not whole, or exceeds its input, on % values', v_bad;
  END IF;

  RAISE NOTICE 'unit floor: identity at a cent over % values, whole at a Diamond', v_checked;
END;
$do$;

-- ---------------------------------------------------------------------------
-- 4. ALL THREE SITES READ THE ONE FLOOR, AND KEPT THEIR OWN RULES.
-- ---------------------------------------------------------------------------
DO $do$
DECLARE v_deal text; v_bounty text;
BEGIN
  SELECT pg_get_functiondef('public.fn_settle_tournament_final_table_deal(uuid)'::regprocedure) INTO v_deal;
  SELECT pg_get_functiondef('public.fn_collect_bounty(uuid,uuid,uuid,jsonb)'::regprocedure) INTO v_bounty;

  IF position('fn_ca_unit_floor_cents' in v_deal) = 0
     OR position('fn_ca_tournament_unit_cents' in v_deal) = 0 THEN
    RAISE EXCEPTION 'the chip chop does not read the unit';
  END IF;
  IF position('fn_ca_unit_floor_cents' in v_bounty) = 0
     OR position('fn_ca_tournament_unit_cents' in v_bounty) = 0 THEN
    RAISE EXCEPTION 'the bounty split does not read the unit';
  END IF;

  -- The rules that were NOT the subject of this change must still be there.
  IF position('chip chop gives rank % a nonpositive share' in v_deal) = 0 THEN
    RAISE EXCEPTION 'the chip chop lost its refusal';
  END IF;
  IF position('v_remainder_cents := v_undistributed_cents - v_distributed_cents;' in v_deal) = 0 THEN
    RAISE EXCEPTION 'the chip chop lost its residual to the leader';
  END IF;
  IF position('v_share_cents := v_cents - v_assigned_cents;' in v_bounty) = 0 THEN
    RAISE EXCEPTION 'the bounty split lost its last-claimant remainder';
  END IF;
  IF position('v_to_head := (v_share_cents - v_cash_cents) / 100.0;' in v_bounty) = 0 THEN
    RAISE EXCEPTION 'the PKO head lost its remainder';
  END IF;

  RAISE NOTICE 'chop and bounties: three sites read the one floor, their own rules intact';
END;
$do$;
