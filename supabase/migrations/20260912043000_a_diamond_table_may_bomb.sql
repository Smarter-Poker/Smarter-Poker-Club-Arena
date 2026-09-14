-- A Diamond table may bomb.
--
-- A bomb pot is an equal forced ante from every dealt-in player and then a
-- showdown across one to three boards. Neither half needs anything from the
-- chip economy: the ante leaves a stack and enters the pot, and the multi-board
-- settlement in HandController has cut its shares in the table's own unit since
-- the tournament fix, so a Diamond bomb divides in whole Diamonds by the same
-- rule run it twice does. The award BREAKDOWN that a bomb hand must carry is
-- accepted by 20260912041500, which now asks of it what the commit already asks
-- of every other amount on the hand: that it is whole.
--
-- Two things about the ROW are still refused, because either one deals a hand
-- the rest of the boundary then rejects, and a table that deals a hand it cannot
-- settle is worse than a table that never deals:
--
--   - an ante that is not a whole Diamond. bomb_pot_ante_multiplier is an
--     INTEGER column, so the multiplier cannot itself be fractional here - that
--     risk lives on the engine side, where the slider steps by 0.5 - but
--     bomb_pot_ante_fixed is numeric and a multiplier of zero antes nothing.
--   - a bomb variant override. bomb_pot_variant lets an NLH table deal PLO
--     bombs, which is the classic bomb pot and is refused for the same reason
--     plo4 is refused on the table itself: no variant beyond NLH is certified
--     for Diamond yet. An override the scheduler would IGNORE is refused too,
--     because a column that says one game while the table deals another is a lie
--     whichever way the engine resolves it.
--
-- The body is not retyped. It is READ from the live function, two edits are made
-- in it, and the result is re-created, so the edit is exact by construction
-- rather than by proofreading. See 20260912041500 for why that is the safer
-- shape for a function this size.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';

INSERT INTO public.ca_money_rpc_registry (proname,status,notes) VALUES
 ('fn_poker_diamond_buyin','approved',
  'Diamond cash seat admission. Reserves settled Diamonds into custody and inserts the seat in one transaction.')
ON CONFLICT (proname) DO NOTHING;

DO $mig$
DECLARE
  v_oid regprocedure := 'public.fn_poker_diamond_buyin(uuid,uuid,integer,numeric,boolean,uuid,uuid)'::regprocedure;
  v_src text; v_def text; v_new text;
  v_drop CONSTANT text := '    OR coalesce(v_t.insurance_enabled,false) OR coalesce(v_t.bomb_pot_enabled,false)
';
  v_kept CONSTANT text := '    OR coalesce(v_t.insurance_enabled,false)
';
  v_anchor CONSTANT text := '   RAISE EXCEPTION ''diamond_cash_requires_whole_amounts'' USING ERRCODE=''23514'';
 END IF;
';
  v_added CONSTANT text := '   RAISE EXCEPTION ''diamond_cash_requires_whole_amounts'' USING ERRCODE=''23514'';
 END IF;
 IF coalesce(v_t.bomb_pot_enabled,false) THEN
   IF coalesce(lower(v_t.bomb_pot_variant),'''') NOT IN ('''',''nlh'') THEN
     RAISE EXCEPTION ''diamond_bomb_pot_requires_the_table_game'' USING ERRCODE=''23514'';
   END IF;
   IF NOT EXISTS(SELECT 1 FROM (SELECT CASE
          WHEN coalesce(v_t.bomb_pot_ante_fixed,0)>0 THEN v_t.bomb_pot_ante_fixed
          ELSE v_t.big_blind*coalesce(v_t.bomb_pot_ante_multiplier,2) END AS a) x
        WHERE x.a IS NOT NULL AND x.a BETWEEN 1 AND 2147483647 AND x.a=trunc(x.a)) THEN
     RAISE EXCEPTION ''diamond_bomb_pot_requires_a_whole_ante'' USING ERRCODE=''23514'';
   END IF;
 END IF;
';
  v_hits integer;
BEGIN
  SELECT prosrc, pg_get_functiondef(oid) INTO v_src, v_def FROM pg_proc WHERE oid=v_oid;
  IF md5(v_src) IS DISTINCT FROM '6f09434018748c5afd7865cc9ef711c0' THEN
    RAISE EXCEPTION 'diamond_bomb_pot_prerequisite_changed:fn_poker_diamond_buyin';
  END IF;

  v_hits := (length(v_def) - length(replace(v_def, v_drop, ''))) / length(v_drop);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'diamond_bomb_drop_clause_matched_% times', v_hits; END IF;
  v_hits := (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor);
  IF v_hits <> 1 THEN RAISE EXCEPTION 'diamond_bomb_anchor_matched_% times', v_hits; END IF;

  v_new := replace(replace(v_def, v_drop, v_kept), v_anchor, v_added);
  EXECUTE v_new;

  SELECT prosrc INTO v_src FROM pg_proc WHERE oid=v_oid;
  IF position('bomb_pot_enabled,false) OR' in v_src) <> 0
     OR position('diamond_bomb_pot_requires_a_whole_ante' in v_src) = 0
     OR position('diamond_bomb_pot_requires_the_table_game' in v_src) = 0 THEN
    RAISE EXCEPTION 'diamond_bomb_pot_replacement_is_not_the_one_written_here';
  END IF;
  -- Everything else the door refused must still be in it: this migration
  -- admitted one feature, it did not open the door.
  IF position('diamond_plain_cash_table_required' in v_src) = 0
     OR position('v_t.run_it_twice IS NULL' in v_src) = 0
     OR position('coalesce(v_t.seven_deuce_enabled,false)' in v_src) = 0
     OR position('v_t.rake_cap_bb IS DISTINCT FROM 0' in v_src) = 0 THEN
    RAISE EXCEPTION 'diamond_bomb_pot_replacement_lost_a_refusal';
  END IF;
END $mig$;

-- The staff door, the third of its family.
INSERT INTO public.ca_money_rpc_registry (proname,status,notes) VALUES
 ('fn_poker_diamond_set_table_bomb_pot','system',
  'Moves no money. Writes the bomb pot columns on one platform Diamond cash table, staff only, and refuses a table or an ante the Diamond boundary would not admit.')
ON CONFLICT (proname) DO UPDATE SET status=EXCLUDED.status,notes=EXCLUDED.notes;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_set_table_bomb_pot(
 p_table_id uuid,p_enabled boolean,p_ante_multiplier integer DEFAULT 2,p_board_count smallint DEFAULT 1
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_t public.tables%ROWTYPE;
BEGIN
 IF auth.uid() IS NULL THEN
  RAISE EXCEPTION 'authentication required' USING ERRCODE='28000';
 END IF;
 IF NOT public.fn_is_platform_admin() THEN
  RAISE EXCEPTION 'diamond_table_staff_only' USING ERRCODE='42501';
 END IF;
 IF p_table_id IS NULL OR p_enabled IS NULL THEN
  RAISE EXCEPTION 'diamond_bomb_pot_requires_an_explicit_flag' USING ERRCODE='22023';
 END IF;
 IF p_enabled AND (p_ante_multiplier IS NULL OR p_ante_multiplier < 1
    OR p_board_count IS NULL OR p_board_count NOT BETWEEN 1 AND 3) THEN
  RAISE EXCEPTION 'diamond_bomb_pot_requires_a_real_ante_and_board_count' USING ERRCODE='22023';
 END IF;
 SELECT t.* INTO v_t FROM public.tables t
   JOIN public.clubs c ON c.id=t.club_id
 WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
   AND c.union_id IS NULL AND t.union_id IS NULL
 FOR UPDATE OF t;
 IF NOT FOUND THEN
  RAISE EXCEPTION 'diamond_table_not_found' USING ERRCODE='P0002';
 END IF;
 IF v_t.game_variant IS DISTINCT FROM 'nlh' OR v_t.tournament_id IS NOT NULL
    OR v_t.cluster_id IS NOT NULL OR coalesce(v_t.is_template,false)
    OR v_t.rake_percent IS DISTINCT FROM 0 OR v_t.rake_cap_bb IS DISTINCT FROM 0
    OR v_t.bbj_percent IS DISTINCT FROM 0
    OR coalesce(v_t.insurance_enabled,false)
    OR coalesce(v_t.seven_deuce_enabled,false) OR coalesce(v_t.nit_game,false)
    OR coalesce(v_t.all_in_or_fold,false) OR coalesce(v_t.pineapple_holdem,false)
    OR coalesce(v_t.cap_enabled,false) THEN
  RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
 END IF;
 -- The ante this would produce has to be a whole Diamond, checked here so the
 -- refusal costs nobody a table they thought they had configured.
 IF p_enabled AND (v_t.big_blind*p_ante_multiplier) IS DISTINCT FROM
    trunc(v_t.big_blind*p_ante_multiplier) THEN
  RAISE EXCEPTION 'diamond_bomb_pot_requires_a_whole_ante' USING ERRCODE='23514';
 END IF;
 UPDATE public.tables
   SET bomb_pot_enabled=p_enabled,
       bomb_pot_ante_multiplier=CASE WHEN p_enabled THEN p_ante_multiplier ELSE 2 END,
       bomb_pot_ante_fixed=0,
       bomb_pot_board_count=CASE WHEN p_enabled THEN p_board_count ELSE 1 END,
       bomb_pot_double_board=CASE WHEN p_enabled THEN p_board_count>=2 ELSE false END,
       bomb_pot_variant=NULL
 WHERE id=p_table_id;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_set_table_bomb_pot(uuid,boolean,integer,smallint)
 FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_set_table_bomb_pot(uuid,boolean,integer,smallint)
 TO authenticated;
COMMENT ON FUNCTION public.fn_poker_diamond_set_table_bomb_pot(uuid,boolean,integer,smallint) IS
 'Turns bomb pots on or off for one platform Diamond cash table. Platform staff only. Writes every bomb column so nothing is inherited, clears any variant override, refuses an ante that would not be a whole Diamond, and moves no money.';

COMMIT;
