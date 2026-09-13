-- A Diamond bomb hand keeps its award units.
--
-- A bomb hand that paid anybody MUST carry its per-pot award breakdown: since
-- 20260906143315 the database refuses a bomb hand that distributed chips and
-- carries none. The Diamond branch of this function refused the opposite - any
-- hand that carried one - so the two rules together made a Diamond bomb pot a
-- hand that could be dealt and could never be committed.
--
-- bomb_pot_award_units is a BREAKDOWN, not a movement. It records which winner
-- took which slice of which pot on which board, for the client's ship sequence
-- and for audit; the money itself moves in the stacks, which this function
-- already holds to whole Diamonds. So the Diamond rule becomes the same rule it
-- applies to every other amount on the hand: each unit's amount must be whole.
--
-- WHY THIS MIGRATION EDITS THE LIVE DEFINITION INSTEAD OF RESTATING IT
--
-- fn_ca_commit_hand_settlement is 34,418 characters and every chip hand in the
-- estate settles through it. Restating the whole body to change three lines
-- means retyping 34KB by hand, and a single character wrong anywhere in it is
-- an estate-wide outage that no test on the changed clause would catch.
--
-- So the body is not retyped. It is READ from the live function, the one clause
-- is replaced in it, and the result is re-created. The preflight pins the md5 of
-- what it is allowed to start from, the replacement must match exactly once, and
-- the function must actually change - so the edit is exact by construction
-- rather than by proofreading. pg_get_functiondef carries every attribute the
-- function has (language, security, search_path, volatility), and
-- CREATE OR REPLACE keeps its owner and its grants.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';

DO $mig$
DECLARE
  v_oid regprocedure := 'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure;
  v_src text;
  v_def text;
  v_new text;
  v_old_clause CONSTANT text := '    OR COALESCE(p_units,''[]''::jsonb)<>''[]''::jsonb
';
  v_new_clause CONSTANT text := '    OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_units,''[]''::jsonb)) u
      WHERE (u->>''amount'') IS NULL
         OR (u->>''amount'')::numeric<>trunc((u->>''amount'')::numeric))
';
  v_hits integer;
BEGIN
  SELECT prosrc, pg_get_functiondef(oid) INTO v_src, v_def FROM pg_proc WHERE oid=v_oid;
  IF md5(v_src) IS DISTINCT FROM '0ef3c57a6a31acc383ce4b95a0f9519f' THEN
    RAISE EXCEPTION 'diamond_bomb_units_prerequisite_changed:fn_ca_commit_hand_settlement';
  END IF;

  v_hits := (length(v_def) - length(replace(v_def, v_old_clause, ''))) / length(v_old_clause);
  IF v_hits <> 1 THEN
    RAISE EXCEPTION 'diamond_bomb_units_clause_matched_% times', v_hits;
  END IF;

  v_new := replace(v_def, v_old_clause, v_new_clause);
  EXECUTE v_new;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid=v_oid;
  IF md5(v_src) = '0ef3c57a6a31acc383ce4b95a0f9519f' THEN
    RAISE EXCEPTION 'diamond_bomb_units_replacement_did_nothing';
  END IF;
  IF position('jsonb_array_elements(COALESCE(p_units' in v_src) = 0 THEN
    RAISE EXCEPTION 'diamond_bomb_units_replacement_is_not_the_one_written_here';
  END IF;
  -- Everything else the Diamond branch refused must still be in the body: this
  -- migration widened one clause, it did not open the branch.
  IF position('diamond_chip_obligation_or_fractional_fact' in v_src) = 0
     OR position('jsonb_array_length(p_post_commit_obligations->''promo_playthrough'')<>0' in v_src) = 0
     OR position('jsonb_array_length(p_post_commit_obligations->''insurance'')<>0' in v_src) = 0
  THEN
    RAISE EXCEPTION 'diamond_bomb_units_replacement_lost_a_refusal';
  END IF;
END $mig$;

COMMIT;
