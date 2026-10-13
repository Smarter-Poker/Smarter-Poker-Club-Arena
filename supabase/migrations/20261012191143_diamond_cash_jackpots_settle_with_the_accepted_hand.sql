-- Diamond Arena BBJ and Mini BBJ settle with their accepted hand.
-- Measured 2026-10-12: installed rake work overwrote the Diamond jackpot
-- settler/arena-float integration; engine/client callers were absent, switch
-- no, and the jackpot ledger held no money. No historic payout is owed.
-- Main payout also announced105 but paid104 in its qualifying fixture.
-- Repair the authoritative hand transaction; never route a Diamond into a
-- chip pool, seed from house money, add a reconciliation loop or replay history.
-- Mini prices are copied once from observed chip tier UNIT COUNTS and then
-- live independently in the append-only Diamond economics table. Both hole
-- cards must play, main precedes mini, and unfunded reserves promise nothing.
-- Installation is rolling-compatible and keeps bbj_enabled=no. Activation
-- is a separate appended answer after the exact engine is serving, drained,
-- and qualified. Native PostgreSQL proof must pass before this is installed.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';

DO $preimage$
BEGIN
  IF md5((SELECT prosrc FROM pg_proc WHERE oid=
    'public.fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric)'::regprocedure))
       IS DISTINCT FROM 'd43ba74b3bafa19b8c4ee5de25790886'
    OR md5((SELECT prosrc FROM pg_proc WHERE oid=
    'public.fn_poker_diamond_jackpot_pay(uuid,bigint,numeric,integer,uuid,uuid,uuid[])'::regprocedure))
       IS DISTINCT FROM '24b540141853cc8c246cd4dfc121ebc4'
    OR md5((SELECT prosrc FROM pg_proc WHERE oid=
    'public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb)'::regprocedure))
       IS DISTINCT FROM '55a7bc02ffdf0fc1935fac60ff608743' THEN
    RAISE EXCEPTION 'Diamond jackpot preimage changed or this migration already ran';
  END IF;
  IF public.fn_ca_diamond_economic_on('bbj_enabled') THEN
    RAISE EXCEPTION 'Install compatibility before activating the Diamond jackpot';
  END IF;
END $preimage$;

-- Extend the existing closed vocabulary while preserving every existing case.
DO $questions$
DECLARE v_old text; v_new text; v_expr text;
BEGIN
  v_old:=pg_get_functiondef('public.fn_ca_diamond_economics_units_of(text)'::regprocedure);
  v_new:=replace(v_old,'    -- Line (c)',
    E'    WHEN ''mini_bbj_enabled'' THEN ''boolean''\n    WHEN ''mini_bbj_amount'' THEN ''diamonds''\n    WHEN ''mini_bbj_reserve_floor'' THEN ''diamonds''\n    -- Line (c)');
  IF v_new=v_old OR position('WHEN ''mini_bbj_enabled''' IN v_old)>0 THEN
    RAISE EXCEPTION 'Diamond economics units vocabulary changed or already extended';
  END IF;
  EXECUTE v_new;
  SELECT pg_get_expr(conbin,conrelid) INTO v_expr FROM pg_constraint
    WHERE conrelid='public.ca_diamond_economics'::regclass
      AND conname='ca_diamond_economics_name_is_a_question';
  IF v_expr IS NULL THEN RAISE EXCEPTION 'Diamond economics closed vocabulary absent'; END IF;
  ALTER TABLE public.ca_diamond_economics DROP CONSTRAINT ca_diamond_economics_name_is_a_question;
  EXECUTE format('ALTER TABLE public.ca_diamond_economics ADD CONSTRAINT ca_diamond_economics_name_is_a_question CHECK ((%s) OR name=ANY(ARRAY[''mini_bbj_enabled'',''mini_bbj_amount'',''mini_bbj_reserve_floor''])) NOT VALID',v_expr);
END $questions$;

INSERT INTO public.ca_diamond_economics(name,scope,value,value_text,units,
 approved_quote,approved_on,basis,recorded_by)
VALUES
 ('mini_bbj_enabled','all',NULL,'yes','boolean',
 'finish up everything thats still pending and not finished',CURRENT_DATE,
 'Diamond clone of the existing Mini BBJ. Its independent switch is prepared now; the main BBJ switch remains no until qualified engine activation.',
 'Codex Diamond Arena completion'),
 ('mini_bbj_reserve_floor','all',5000,NULL,'diamonds',
 'finish up everything thats still pending and not finished',CURRENT_DATE,
 'Every active chip BBJ pool read2026-10-12 had reserve floor5000. Copy its unit count into whole Diamonds, with no seed; the mini refuses whenever backup minus payout would breach this floor.',
 'Codex Diamond Arena completion');

INSERT INTO public.ca_diamond_economics(name,scope,value,value_text,units,
 approved_quote,approved_on,basis,recorded_by)
SELECT 'mini_bbj_amount',d.scope,m.amount,NULL,'diamonds',
 'finish up everything thats still pending and not finished',CURRENT_DATE,
 'Copied from existing chip Mini BBJ tier '||m.tier_id||' at the same big-blind unit count, read2026-10-12; whole Diamonds held independently thereafter. No chip balance is used or changed.',
 'Codex Diamond Arena completion'
FROM (SELECT DISTINCT scope FROM public.ca_diamond_economics
      WHERE name='bbj_drop_per_hand' AND scope LIKE 'bb:%') d
JOIN public.bbj_stakes_tiers t ON split_part(d.scope,':',2)::numeric BETWEEN t.min_bb AND t.max_bb
JOIN public.bbj_mini_tiers m ON m.tier_id=t.id;
DO $prices$
BEGIN
 IF EXISTS (SELECT 1 FROM public.ca_diamond_economics d
    WHERE d.name='bbj_drop_per_hand'
      AND NOT EXISTS (SELECT 1 FROM public.ca_diamond_economics m
        WHERE m.name='mini_bbj_amount' AND m.scope=d.scope))
    OR EXISTS (SELECT 1 FROM public.ca_diamond_economics m
      WHERE m.name IN ('mini_bbj_amount','mini_bbj_reserve_floor')
        AND (m.value IS NULL OR m.value<0 OR m.value<>trunc(m.value))) THEN
   RAISE EXCEPTION 'A Diamond mini stake has no whole independent price';
 END IF;
END $prices$;

CREATE TABLE public.poker_diamond_jackpot_hits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 arena_id uuid NOT NULL,
 table_id uuid NOT NULL,
 hand_number bigint NOT NULL,
 hand_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('main','mini')),
 paid boolean NOT NULL,
 verdict jsonb NOT NULL,
 receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(table_id,hand_number)
);
ALTER TABLE public.poker_diamond_jackpot_hits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.poker_diamond_jackpot_hits FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.poker_diamond_jackpot_hits TO authenticated;
CREATE POLICY diamond_jackpot_paid_hits ON public.poker_diamond_jackpot_hits
 FOR SELECT TO authenticated USING(auth.uid() IS NOT NULL AND paid);
CREATE TRIGGER poker_diamond_jackpot_hits_append_only BEFORE UPDATE OR DELETE
 ON public.poker_diamond_jackpot_hits FOR EACH ROW
 EXECUTE FUNCTION public.fn_poker_diamond_append_only();

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_settle_cash_hand(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_arena uuid;
  v_bb bigint;
  v_request jsonb;
  v_stacks jsonb;
  v_prior public.poker_diamond_hand_receipts%ROWTYPE;
  v_c public.poker_diamond_custody%ROWTYPE;
  v_seat public.table_seats%ROWTYPE;
  v_e jsonb;
  v_lot record;
  v_before bigint;
  v_after bigint;
  v_loss bigint;
  v_take bigint;
  v_written jsonb := '{}'::jsonb;
  v_result jsonb;
  -- The rake arithmetic, all of it integer.
  v_rake_on boolean;
  v_rake bigint;
  v_facts jsonb := NULL;
  v_pot bigint;
  v_dealt integer;
  v_saw_flop boolean;
  v_dealt_key text;
  v_pct numeric;
  v_cap numeric;
  v_min_pot numeric;
  v_no_drop boolean;
  v_rounding text;
  v_expected bigint;
  v_attributed bigint;
  v_bbj bigint;
  v_bbj_on boolean;
  v_bbj_due bigint;
  v_pool uuid;
  v_double_board boolean;
BEGIN
  IF p_table_id IS NULL OR p_hand_number IS NULL OR p_hand_number < 1000000
     OR COALESCE(p_inflow,0) <> 0 THEN
    -- Insurance remains refused. Jackpot price is recomputed below.
    RAISE EXCEPTION 'diamond_plain_cash_hand_required' USING ERRCODE='22023';
  END IF;
  IF COALESCE(p_rake,0) < 0 OR COALESCE(p_rake,0) <> trunc(COALESCE(p_rake,0)) THEN
    RAISE EXCEPTION 'diamond_plain_cash_hand_required' USING ERRCODE='22023';
  END IF;
  v_rake := COALESCE(p_rake,0)::bigint;
  IF COALESCE(p_bbj,0) < 0 OR COALESCE(p_bbj,0) <> trunc(COALESCE(p_bbj,0)) THEN
    RAISE EXCEPTION 'diamond_bbj_must_be_whole_diamonds' USING ERRCODE='22023';
  END IF;
  v_bbj := COALESCE(p_bbj,0)::bigint;
  v_bbj_on := public.fn_ca_diamond_economic_on('bbj_enabled','all');
  IF NOT v_bbj_on AND v_bbj <> 0 THEN
    RAISE EXCEPTION 'diamond_bad_beat_jackpot_not_open' USING ERRCODE='22023';
  END IF;

  -- THE SWITCH IS AN ANSWER (design 3.2). Absent or off means the amount is
  -- exactly zero and this door keeps refusing anything else; on with a required
  -- value unset refuses by name, never "on with a default".
  BEGIN
    v_rake_on := public.fn_ca_diamond_economic_on('cash_rake_enabled','all');
  EXCEPTION WHEN SQLSTATE 'PDE01' THEN
    -- Switch ABSENT is the same answer as off (design 3.2): the amount is
    -- exactly zero and this door keeps refusing anything else. Only the ABSENCE
    -- is caught. A name the list does not know (PDE02) is a programming error
    -- in this door and must not be swallowed into "off".
    v_rake_on := false;
  END;
  IF NOT v_rake_on AND v_rake <> 0 THEN
    RAISE EXCEPTION 'diamond_cash_rake_not_open' USING ERRCODE='22023';
  END IF;

  IF jsonb_typeof(p_stacks) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'diamond_hand_roster_required' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_stacks) < 2 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_stacks) x
    WHERE jsonb_typeof(x) IS DISTINCT FROM 'object'
       OR jsonb_typeof(x->'user_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
       OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
       OR jsonb_typeof(x->'stack_before') IS DISTINCT FROM 'number'
       OR jsonb_typeof(x->'stack') IS DISTINCT FROM 'number'
  ) THEN
    RAISE EXCEPTION 'diamond_exact_hand_roster_required' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_stacks) x
    WHERE NOT pg_input_is_valid(x->>'user_id','uuid')
       OR NOT pg_input_is_valid(x->>'seat_id','uuid')
       OR NOT pg_input_is_valid(x->>'seat_joined_at','timestamp with time zone')
       OR (x->>'stack')::numeric NOT BETWEEN 0 AND 2147483647
       OR (x->>'stack_before')::numeric NOT BETWEEN 0 AND 2147483647
       OR (x->>'stack')::numeric <> trunc((x->>'stack')::numeric)
       OR (x->>'stack_before')::numeric <> trunc((x->>'stack_before')::numeric)
  ) OR (SELECT count(*) <> count(DISTINCT (x->>'user_id')::uuid)
         OR count(*) <> count(DISTINCT (x->>'seat_id')::uuid)
        FROM jsonb_array_elements(p_stacks) x) THEN
    RAISE EXCEPTION 'diamond_invalid_hand_amount_or_generation' USING ERRCODE='22023';
  END IF;

  -- CONSERVATION, RESTATED. The stacks after the hand are short by exactly the
  -- rake and the jackpot drop, and by nothing else. With both zero this is the
  -- rule that ran before this migration, unchanged.
  IF (SELECT sum((x->>'stack')::numeric - (x->>'stack_before')::numeric)
      FROM jsonb_array_elements(p_stacks) x) <> -(v_rake + COALESCE(p_bbj,0)) THEN
    RAISE EXCEPTION 'diamond_hand_does_not_conserve' USING ERRCODE='23514';
  END IF;

  SELECT t.club_id, t.big_blind INTO v_arena, v_bb FROM public.tables t
  JOIN public.clubs c ON c.id=t.club_id
  WHERE t.id=p_table_id AND c.asset='diamonds' AND c.is_platform IS TRUE
    AND c.union_id IS NULL AND t.union_id IS NULL
    AND t.tournament_id IS NULL AND public.fn_poker_diamond_cash_variant(t.game_variant)
    AND t.big_blind = trunc(t.big_blind) AND t.big_blind > 0
  FOR UPDATE OF t;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE='23514';
  END IF;

  -- THE RECOMPUTE. With the switch on, every hand carries its facts and the
  -- rake is recomputed from the Diamond schedule. A hand whose facts are
  -- missing, malformed or self-contradictory is refused, not resolved.
  IF v_rake_on OR v_bbj_on THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_stacks) x
      WHERE jsonb_typeof(x->'contributed') IS DISTINCT FROM 'number'
         OR jsonb_typeof(x->'dealt_in') IS DISTINCT FROM 'boolean'
         OR jsonb_typeof(x->'hand_saw_flop') IS DISTINCT FROM 'boolean'
         OR (x->>'contributed')::numeric < 0
         OR (x->>'contributed')::numeric <> trunc((x->>'contributed')::numeric)
         OR (x->>'contributed')::numeric > 2147483647
    ) THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_required' USING ERRCODE='22023';
    END IF;
    IF (SELECT count(DISTINCT (x->>'hand_saw_flop')) FROM jsonb_array_elements(p_stacks) x) <> 1 THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_disagree' USING ERRCODE='22023';
    END IF;
    SELECT sum((x->>'contributed')::bigint),
           count(*) FILTER (WHERE (x->>'dealt_in')::boolean),
           bool_or((x->>'hand_saw_flop')::boolean)
      INTO v_pot, v_dealt, v_saw_flop
      FROM jsonb_array_elements(p_stacks) x;
    -- A player who contributed cannot have been sitting out.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x
                WHERE (x->>'contributed')::bigint > 0 AND NOT (x->>'dealt_in')::boolean) THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_disagree' USING ERRCODE='22023';
    END IF;
    -- TWO BOUNDS THAT TIE THE CLAIMED CONTRIBUTIONS TO THE STACKS THAT MOVED.
    -- Without them "contributed" is a number the engine asserts about itself and
    -- the attribution rests on nothing.
    --   A player cannot lose more than they put in. This is what makes the
    --   per-player weights trustworthy, and summed it also gives pot >= losses.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x
                WHERE greatest((x->>'stack_before')::bigint-(x->>'stack')::bigint,0)
                      > (x->>'contributed')::bigint) THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_disagree' USING ERRCODE='22023';
    END IF;
    --   Nobody contributes Diamonds they did not bring to the hand.
    IF v_pot > (SELECT COALESCE(sum((x->>'stack_before')::bigint),0)
                  FROM jsonb_array_elements(p_stacks) x) THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_disagree' USING ERRCODE='22023';
    END IF;

    -- The dealt-in bracket is part of the NAME, not the scope: the settings
    -- table's scope grammar is 'all' or '^bb:[0-9]+$' and nothing else, so a
    -- stake key stays a stake key.
    IF v_rake_on THEN
    v_dealt_key := CASE WHEN v_dealt <= 2 THEN '_heads_up'
                        WHEN v_dealt = 3 THEN '_three_handed'
                        ELSE '' END;
    -- EVERY NUMBER IS READ, NONE IS A LITERAL, AND NONE FALLS BACK. An unset
    -- name raises diamond_economics_unset:<name>/<scope> out of this door and on
    -- to the client, which is the design's rule: "the settler refuses a raked
    -- hand with the unset name of B5", and the reader's SQLSTATE PDE01 travels
    -- out of here untouched. A Diamond stake with no published cap row therefore
    -- refuses by name rather than being raked at some other stake's cap: the
    -- A-lane's reader "never falls back from a stake to all".
    v_pct      := public.fn_ca_diamond_economic('cash_rake_percent'||v_dealt_key, 'all');
    v_cap      := public.fn_ca_diamond_economic('cash_rake_cap'||v_dealt_key, 'bb:'||v_bb::text);
    v_min_pot  := public.fn_ca_diamond_economic('cash_rake_min_pot','all');
    v_no_drop  := public.fn_ca_diamond_economic_on('cash_rake_no_flop_no_drop','all');
    v_rounding := public.fn_ca_diamond_economic_text('cash_rake_rounding','all');
    -- Only "down" is implemented. A row that says something else is an answer
    -- this door cannot honour, and honouring it approximately would be worse
    -- than refusing: the refusal names the value it cannot apply.
    IF v_rounding <> 'down' THEN
      RAISE EXCEPTION 'diamond_cash_rake_rounding_unsupported:%', v_rounding USING ERRCODE='22023';
    END IF;

    v_expected := CASE
      WHEN v_dealt < 2 THEN 0
      WHEN NOT v_saw_flop AND v_no_drop THEN 0
      WHEN v_pot < v_min_pot THEN 0
      ELSE least(trunc(v_pot::numeric * v_pct / 100), v_cap)::bigint END;

    IF v_rake <> v_expected THEN
      RAISE EXCEPTION 'diamond_cash_rake_disagrees (engine %, settings % at pot %, % dealt, flop %)',
        v_rake, v_expected, v_pot, v_dealt, v_saw_flop USING ERRCODE='23514';
    END IF;
    IF v_rake > v_pot THEN
      RAISE EXCEPTION 'diamond_cash_rake_facts_disagree' USING ERRCODE='22023';
    END IF;
    END IF;
  ELSIF v_rake <> 0 THEN
    RAISE EXCEPTION 'diamond_cash_rake_not_open' USING ERRCODE='22023';
  END IF;

  IF v_bbj_on THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x
        WHERE jsonb_typeof(x->'hand_double_board') IS DISTINCT FROM 'boolean')
      OR (SELECT count(DISTINCT x->>'hand_double_board') FROM jsonb_array_elements(p_stacks) x) <> 1 THEN
      RAISE EXCEPTION 'diamond_jackpot_board_facts_required' USING ERRCODE='22023';
    END IF;
    SELECT bool_or((x->>'hand_double_board')::boolean) INTO v_double_board
      FROM jsonb_array_elements(p_stacks) x;
    v_bbj_due := CASE WHEN v_saw_flop AND NOT v_double_board
       AND v_dealt >= public.fn_ca_diamond_economic('bbj_min_dealt_in')
       THEN public.fn_poker_diamond_jackpot_drop_due(p_table_id) ELSE 0 END;
    IF v_bbj IS DISTINCT FROM v_bbj_due OR v_rake + v_bbj > v_pot THEN
      RAISE EXCEPTION 'diamond_bbj_amount_disagrees_with_the_schedule' USING ERRCODE='23514';
    END IF;
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'user_id',(x->>'user_id')::uuid, 'seat_id',(x->>'seat_id')::uuid,
    'seat_joined_at',(x->>'seat_joined_at')::timestamptz,
    'stack_before',(x->>'stack_before')::bigint, 'stack',(x->>'stack')::bigint)
    ORDER BY (x->>'user_id')::uuid) INTO v_stacks
    FROM jsonb_array_elements(p_stacks) x;
  -- The facts are part of the request, so a replay that claims a different pot,
  -- a different flop or a different roster is a payload mismatch rather than a
  -- second settlement. They are kept apart from the stacks so the stack shape
  -- the rest of this door reads is exactly what it was.
  IF v_rake_on OR v_bbj_on THEN
    SELECT jsonb_build_object('double_board',v_double_board,'pot',v_pot,'dealt',v_dealt,'saw_flop',v_saw_flop,
             'contributions', jsonb_agg(jsonb_build_object(
               'user_id',(x->>'user_id')::uuid,
               'contributed',(x->>'contributed')::bigint,
               'dealt_in',(x->>'dealt_in')::boolean)
               ORDER BY (x->>'user_id')::uuid))
      INTO v_facts FROM jsonb_array_elements(p_stacks) x;
  END IF;
  v_request := jsonb_build_object('stacks',v_stacks,'ref',p_ref,
    'rake',p_rake,'bbj',p_bbj,'inflow',p_inflow)
    || CASE WHEN v_facts IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('rake_facts',v_facts) END;

  -- A REPLAY MOVES NOTHING TWICE. The receipt is read before any write, so a
  -- redelivered hand returns the first receipt and touches no balance, no lot,
  -- no seat and no accrual row.
  SELECT * INTO v_prior FROM public.poker_diamond_hand_receipts
    WHERE table_id=p_table_id AND hand_number=p_hand_number;
  IF FOUND THEN
    IF v_prior.request IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'diamond_hand_payload_mismatch' USING ERRCODE='22023';
    END IF;
    RETURN v_prior.receipt || jsonb_build_object('replay',true);
  END IF;

  -- Own the player-side jackpot bank before wallet locks; the payout takes
  -- this same pool then wallet order inside the accepted-hand transaction.
  IF v_bbj_on THEN
    v_pool := public.fn_poker_diamond_jackpot_pool_for_table(p_table_id);
    IF v_pool IS NULL THEN RAISE EXCEPTION 'diamond_jackpot_pool_absent'; END IF;
    PERFORM 1 FROM public.poker_diamond_jackpot_pools WHERE id=v_pool FOR UPDATE;
  END IF;

  -- Match the wallet/refund lock order before touching purchase lots.
  PERFORM p.id FROM public.profiles p
    JOIN jsonb_array_elements(v_stacks) x ON (x->>'user_id')::uuid=p.id
    ORDER BY p.id FOR UPDATE OF p;
  -- Validate the entire roster while locks are held before changing one balance.
  FOR v_e IN SELECT value FROM jsonb_array_elements(v_stacks) LOOP
    SELECT * INTO v_seat FROM public.table_seats
      WHERE id=(v_e->>'seat_id')::uuid AND table_id=p_table_id
        AND user_id=(v_e->>'user_id')::uuid
        AND joined_at=(v_e->>'seat_joined_at')::timestamptz
        AND left_at IS NULL FOR UPDATE;
    IF NOT FOUND OR v_seat.stack IS DISTINCT FROM (v_e->>'stack_before')::numeric THEN
      RAISE EXCEPTION 'diamond_hand_stale_seat' USING ERRCODE='55000';
    END IF;
    SELECT * INTO v_c FROM public.poker_diamond_custody
      WHERE occupancy_id=v_seat.occupancy_id AND seat_id=v_seat.id
        AND seat_joined_at=v_seat.joined_at AND user_id=v_seat.user_id
        AND target_id=p_table_id AND arena_id=v_arena
        AND purpose='cash_seat' AND state='active' FOR UPDATE;
    IF NOT FOUND OR v_c.balance IS DISTINCT FROM (v_e->>'stack_before')::bigint THEN
      RAISE EXCEPTION 'diamond_hand_custody_mismatch' USING ERRCODE='23514';
    END IF;
  END LOOP;

  FOR v_e IN SELECT value FROM jsonb_array_elements(v_stacks) LOOP
    SELECT * INTO STRICT v_c FROM public.poker_diamond_custody
      WHERE seat_id=(v_e->>'seat_id')::uuid
        AND seat_joined_at=(v_e->>'seat_joined_at')::timestamptz
        AND user_id=(v_e->>'user_id')::uuid AND target_id=p_table_id AND state='active';
    v_before := (v_e->>'stack_before')::bigint;
    v_after := (v_e->>'stack')::bigint;
    v_loss := greatest(v_before-v_after,0);
    -- THE RAKE NEEDS NO CHANGE HERE (design section 5, step 4): the settler
    -- already consumes purchased lots for every loss, and every rake Diamond is
    -- part of some player's loss.
    FOR v_lot IN
      SELECT l.id,r.amount-r.consumed AS held,
        greatest(l.issued-l.consumed-l.refunded,0) AS outstanding
      FROM public.poker_diamond_lot_reservations r
      JOIN public.diamond_purchase_lots l ON l.id=r.lot_id
      WHERE r.custody_id=v_c.id AND r.released_at IS NULL
      ORDER BY l.created_at,l.id FOR UPDATE OF l,r
    LOOP
      EXIT WHEN v_loss=0;
      v_take := least(v_loss,v_lot.held);
      IF v_take>0 THEN
        -- A provider reversal may already have retired this liability.
        -- Remove the hold once; consume only liability still outstanding.
        UPDATE public.diamond_purchase_lots
          SET arena_reserved=arena_reserved-v_take,
              consumed=consumed+least(v_take,v_lot.outstanding)::integer
          WHERE id=v_lot.id;
        UPDATE public.poker_diamond_lot_reservations
          SET consumed=consumed+v_take
          WHERE custody_id=v_c.id AND lot_id=v_lot.id;
        v_loss := v_loss-v_take;
      END IF;
    END LOOP;
    UPDATE public.poker_diamond_custody SET balance=v_after WHERE id=v_c.id;
    UPDATE public.table_seats SET stack=v_after
      WHERE id=v_c.seat_id AND joined_at=v_c.seat_joined_at
        AND occupancy_id=v_c.occupancy_id AND left_at IS NULL;
    IF NOT EXISTS (SELECT 1 FROM public.table_seats
      WHERE id=v_c.seat_id AND joined_at=v_c.seat_joined_at
        AND occupancy_id=v_c.occupancy_id AND left_at IS NULL AND stack=v_after) THEN
      RAISE EXCEPTION 'diamond_hand_seat_write_failed' USING ERRCODE='23514';
    END IF;
    v_written := v_written || jsonb_build_object(v_c.user_id::text,v_after);
  END LOOP;

  -- ATTRIBUTION AND ACCRUAL (design section 5, steps 4 and 5)
  --
  -- WEIGHTED_CONTRIBUTED, the method the commit door already requires for chip
  -- rake: each contributor's share of the rake is in proportion to what they put
  -- into the pot. This moves no Diamond - the Diamonds already left the stacks
  -- when the pot was cut. It decides WHOSE spend row records each Diamond of
  -- rake, which is what the register needs at the sweep and what a rakeback
  -- would need if B12 were ever yes.
  --
  -- THE REMAINDER RULE, STATED SO IT CAN BE PINNED. A proportional split of a
  -- whole number of Diamonds almost never divides evenly, so:
  --   1. each contributor takes floor(rake * contributed / pot);
  --   2. the Diamonds left over go one each to the contributors with the largest
  --      remainder (rake * contributed) mod pot, largest first;
  --   3. ties on that remainder are broken by user_id ascending.
  -- It is deterministic, it is total (the shares sum to the rake exactly, which
  -- the assertion below proves on every hand), and it never gives a contributor
  -- more than one extra Diamond.
  --
  -- NO is_horse ANYWHERE. A horse contributes and is attributed like anyone.
  IF v_rake > 0 THEN
    INSERT INTO public.ca_diamond_rake_accrual
      (table_id, hand_number, arena_id, user_id, kind, amount)
    WITH c AS (
      SELECT (x->>'user_id')::uuid AS uid, (x->>'contributed')::bigint AS contributed
        FROM jsonb_array_elements(p_stacks) x
       WHERE (x->>'contributed')::bigint > 0
    ), b AS (
      SELECT uid,
             div(v_rake * contributed, v_pot) AS base,
             (v_rake * contributed) % v_pot AS frac
        FROM c
    ), r AS (
      SELECT v_rake - COALESCE(sum(base),0) AS rem FROM b
    ), o AS (
      SELECT uid, base, row_number() OVER (ORDER BY frac DESC, uid ASC) AS rn FROM b
    )
    SELECT p_table_id, p_hand_number, v_arena, o.uid, 'rake',
           o.base + CASE WHEN o.rn <= r.rem THEN 1 ELSE 0 END
      FROM o CROSS JOIN r
     WHERE o.base + CASE WHEN o.rn <= r.rem THEN 1 ELSE 0 END > 0;

    SELECT COALESCE(sum(amount),0) INTO v_attributed
      FROM public.ca_diamond_rake_accrual
     WHERE table_id=p_table_id AND hand_number=p_hand_number AND kind='rake';
    IF v_attributed IS DISTINCT FROM v_rake THEN
      RAISE EXCEPTION 'diamond_cash_rake_attribution_does_not_sum (% of %)', v_attributed, v_rake
        USING ERRCODE='23514';
    END IF;
  END IF;

  IF v_bbj > 0 THEN
    PERFORM public.fn_poker_diamond_jackpot_drop(p_table_id,p_hand_number,v_bbj,v_stacks);
  END IF;

  v_result := jsonb_build_object('success',true,'asset','diamonds',
    'players',jsonb_array_length(v_stacks),'table_id',p_table_id,
    'hand_id',md5('ca-hand:'||p_table_id||':'||p_hand_number
      ||CASE WHEN p_ref IS NULL OR p_ref='' THEN '' ELSE ':'||p_ref END)::uuid,
    'hand_number',p_hand_number,'net_deltas',-(v_rake + COALESCE(p_bbj,0)),
    'rake',p_rake,'bbj',p_bbj,
    'inflow',p_inflow,'mode','delta','rebased','{}'::jsonb,
    'written',v_written,'departed','[]'::jsonb,'conservation_checked',true,
    'rake_accrued',COALESCE(v_attributed,0),
    'request',v_request);
  INSERT INTO public.poker_diamond_hand_receipts(table_id,hand_number,request,receipt)
    VALUES(p_table_id,p_hand_number,v_request,v_result);
  RETURN v_result;
END $function$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_pay(p_table_id uuid, p_hand_number bigint, p_pot numeric, p_players_dealt integer, p_loser_user_id uuid, p_winner_user_id uuid, p_table_user_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pool uuid; v_ref text; v_bb numeric; v_variant text; v_scope text;
  v_main bigint; v_pct numeric; v_paid bigint; v_shares text;
  v_loser bigint; v_winner bigint; v_table_total bigint;
  v_others uuid[]; v_n integer; v_each bigint; v_remainder bigint;
  v_rec record; v_credit jsonb; v_key text; v_inserted integer;
  v_paid_out bigint := 0; v_legs jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.fn_ca_diamond_economic_on('bbj_enabled') THEN
    RAISE EXCEPTION 'diamond_bad_beat_jackpot_not_open' USING ERRCODE = '55000';
  END IF;
  IF p_loser_user_id IS NULL OR p_winner_user_id IS NULL
     OR p_loser_user_id = p_winner_user_id THEN
    RAISE EXCEPTION 'diamond_jackpot_needs_a_loser_and_a_winner' USING ERRCODE = '23514';
  END IF;

  SELECT t.big_blind, t.game_variant INTO v_bb, v_variant
    FROM public.tables t JOIN public.clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id AND c.asset = 'diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL AND t.tournament_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE = '23514';
  END IF;
  v_scope := public.fn_poker_diamond_jackpot_stake_scope(v_bb);

  -- B16: a game with no jackpot can never win one.
  IF NOT public.fn_poker_diamond_jackpot_game_qualifies(v_variant) THEN
    RAISE EXCEPTION 'diamond_jackpot_game_has_no_jackpot:%', v_variant USING ERRCODE = '23514';
  END IF;
  -- B15's symmetry: a stake that drops nothing can never hit.
  IF public.fn_ca_diamond_economic('bbj_drop_per_hand', v_scope) <= 0 THEN
    RAISE EXCEPTION 'diamond_jackpot_stake_drops_nothing:%', v_scope USING ERRCODE = '23514';
  END IF;
  -- B17, the payout gates. The pot floor is a payout floor and only ever that.
  IF p_players_dealt IS NULL
     OR p_players_dealt < public.fn_ca_diamond_economic('bbj_min_dealt_in') THEN
    RAISE EXCEPTION 'diamond_jackpot_too_few_dealt_in:%', p_players_dealt USING ERRCODE = '23514';
  END IF;
  -- bbj_min_pot is recorded in DIAMONDS, per stake: ten big blinds of a
  -- whole-Diamond blind is a whole number of Diamonds, so the floor is stored
  -- as the figure the door compares against rather than as a multiplier the
  -- door would have to apply.
  IF p_pot IS NULL
     OR p_pot <= public.fn_ca_diamond_economic('bbj_min_pot', v_scope) THEN
    RAISE EXCEPTION 'diamond_jackpot_pot_below_the_payout_floor:%', p_pot USING ERRCODE = '23514';
  END IF;

  v_pool := public.fn_poker_diamond_jackpot_pool_for_table(p_table_id);
  IF v_pool IS NULL THEN
    RAISE EXCEPTION 'diamond_jackpot_pool_absent' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.poker_diamond_jackpot_pools WHERE id = v_pool FOR UPDATE;
  v_ref := 'bbjpay:' || p_table_id::text || ':' || p_hand_number::text;

  -- A REPLAY RETURNS WHAT IT PAID THE FIRST TIME AND PAYS NOTHING.
  IF EXISTS (SELECT 1 FROM public.poker_diamond_jackpot_ledger
              WHERE ref = v_ref AND kind = 'payout') THEN
    SELECT jsonb_build_object('replay', true, 'pool_id', v_pool, 'ref', v_ref,
             'paid', -COALESCE(sum(amount), 0),
             'legs', COALESCE(jsonb_agg(jsonb_build_object('role', recipient_role,
                        'user_id', recipient_user_id, 'amount', -amount) ORDER BY id), '[]'::jsonb))
      INTO v_credit FROM public.poker_diamond_jackpot_ledger
     WHERE ref = v_ref AND kind = 'payout';
    RETURN v_credit;
  END IF;

  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f
      WHERE f.scope IN ('bbj_payouts','arena_withdrawals') AND f.cleared_at IS NULL) THEN
    RAISE EXCEPTION 'payout_frozen: Diamond jackpot payout is held' USING ERRCODE='P0404';
  END IF;
  v_main := public.fn_poker_diamond_jackpot_bank(v_pool, 'main');
  -- B19 is one shares answer per stake: what is paid, and how it divides.
  v_shares := public.fn_ca_diamond_economic_text('bbj_hit_shares', v_scope);
  v_pct  := public.fn_poker_diamond_jackpot_share(v_shares, 1, 'paid');
  -- B19, in whole Diamonds. Every division floors; what no floor could
  -- allocate is paid to the losing hand, so the announced total is exact.
  -- No money is taken from a player to round another player's share.
  v_paid   := floor(v_main * v_pct / 100)::bigint;
  IF v_paid <= 0 THEN
    RAISE EXCEPTION 'diamond_jackpot_pool_pays_nothing_yet:main=%', v_main USING ERRCODE = '23514';
  END IF;
  v_loser  := floor(v_paid * public.fn_poker_diamond_jackpot_share(v_shares, 1, 'loser')  / 100)::bigint;
  v_winner := floor(v_paid * public.fn_poker_diamond_jackpot_share(v_shares, 1, 'winner') / 100)::bigint;
  v_table_total := floor(v_paid * public.fn_poker_diamond_jackpot_share(v_shares, 1, 'table') / 100)::bigint;

  -- The rest of the table: everybody dealt in who is neither the loser nor the
  -- winner. Horses among them, on the same terms, never filtered out.
  SELECT COALESCE(array_agg(DISTINCT u ORDER BY u), '{}'::uuid[]) INTO v_others
    FROM unnest(COALESCE(p_table_user_ids, '{}'::uuid[])) u
   WHERE u IS DISTINCT FROM p_loser_user_id AND u IS DISTINCT FROM p_winner_user_id;
  v_n := COALESCE(array_length(v_others, 1), 0);
  IF v_n > 0 THEN
    v_each := (v_table_total / v_n)::bigint;
  ELSE
    v_each := 0;
  END IF;
  v_remainder := v_paid - v_loser - v_winner - v_each * v_n;
  v_loser := v_loser + v_remainder;

  -- One credit and one ledger leg per recipient.
  FOR v_rec IN
    SELECT p_loser_user_id AS user_id, 'loser'::text AS role, v_loser AS amount
    UNION ALL SELECT p_winner_user_id, 'winner', v_winner
    UNION ALL SELECT u, 'table', v_each FROM unnest(v_others) u
  LOOP
    CONTINUE WHEN v_rec.amount <= 0;
    v_key := v_ref || ':' || v_rec.role || ':' || v_rec.user_id::text;
    INSERT INTO public.wallet_credit_idempotency(key, user_id, amount)
    VALUES (v_key, v_rec.user_id, v_rec.amount) ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN
      RAISE EXCEPTION 'diamond_jackpot_credit_key_already_claimed:%', v_key USING ERRCODE = '23505';
    END IF;
    v_credit := public.add_diamonds_to_balance(
      v_rec.user_id, v_rec.amount::integer, 'arena_withdraw',
      'Diamond Arena Bad Beat Jackpot', v_key);
    IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE
       OR NULLIF(v_credit->>'transaction_id', '') IS NULL THEN
      RAISE EXCEPTION 'diamond_jackpot_credit_failed:%', v_credit->>'error' USING ERRCODE = 'P0404';
    END IF;
    INSERT INTO public.poker_diamond_jackpot_ledger(
      pool_id, bank, kind, amount, table_id, hand_number,
      recipient_user_id, recipient_role, wallet_journal_id, ref, note)
    VALUES (v_pool, 'main', 'payout', -v_rec.amount, p_table_id, p_hand_number,
            v_rec.user_id, v_rec.role, (v_credit->>'transaction_id')::uuid, v_ref,
            'bad beat jackpot hit, ' || v_rec.role || ' share');
    v_paid_out := v_paid_out + v_rec.amount;
    v_legs := v_legs || jsonb_build_object('role', v_rec.role, 'user_id', v_rec.user_id,
                                           'amount', v_rec.amount);
  END LOOP;

  IF v_paid_out <> v_paid THEN
    RAISE EXCEPTION 'diamond_jackpot_paid_total_disagrees' USING ERRCODE = '23514';
  END IF;
  IF public.fn_poker_diamond_jackpot_bank(v_pool, 'main') < 0 THEN
    RAISE EXCEPTION 'diamond_jackpot_main_bank_went_negative' USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_build_object(
    'pool_id', v_pool, 'ref', v_ref, 'main_before', v_main, 'payout_percent', v_pct,
    'paid_total', v_paid, 'paid_out', v_paid_out,
    'left_in_main_pool', 0,
    'loser', v_loser, 'winner', v_winner, 'table_total', v_table_total,
    'table_each', v_each, 'table_remainder_left_in_pool', 0,
    'qualifying_hand', public.fn_poker_diamond_jackpot_qualifying_hand(v_variant),
    'legs', v_legs);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_pay_mini(p_table_id uuid, p_hand_number bigint, p_pot numeric, p_players_dealt integer, p_loser_user_id uuid, p_winner_user_id uuid, p_table_user_ids uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_pool uuid; v_ref text; v_bb numeric; v_variant text; v_scope text;
  v_main bigint; v_pct numeric; v_paid bigint; v_shares text;
  v_loser bigint; v_winner bigint; v_table_total bigint;
  v_others uuid[]; v_n integer; v_each bigint; v_remainder bigint;
  v_rec record; v_credit jsonb; v_key text; v_inserted integer;
  v_paid_out bigint := 0; v_legs jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.fn_ca_diamond_economic_on('bbj_enabled')
     OR NOT public.fn_ca_diamond_economic_on('mini_bbj_enabled') THEN
    RAISE EXCEPTION 'diamond_bad_beat_jackpot_not_open' USING ERRCODE = '55000';
  END IF;
  IF p_loser_user_id IS NULL OR p_winner_user_id IS NULL
     OR p_loser_user_id = p_winner_user_id THEN
    RAISE EXCEPTION 'diamond_jackpot_needs_a_loser_and_a_winner' USING ERRCODE = '23514';
  END IF;

  SELECT t.big_blind, t.game_variant INTO v_bb, v_variant
    FROM public.tables t JOIN public.clubs c ON c.id = t.club_id
   WHERE t.id = p_table_id AND c.asset = 'diamonds' AND c.is_platform IS TRUE
     AND c.union_id IS NULL AND t.union_id IS NULL AND t.tournament_id IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'diamond_plain_cash_table_required' USING ERRCODE = '23514';
  END IF;
  v_scope := public.fn_poker_diamond_jackpot_stake_scope(v_bb);

  -- B16: a game with no jackpot can never win one.
  IF NOT public.fn_poker_diamond_jackpot_game_qualifies(v_variant) THEN
    RAISE EXCEPTION 'diamond_jackpot_game_has_no_jackpot:%', v_variant USING ERRCODE = '23514';
  END IF;
  -- B15's symmetry: a stake that drops nothing can never hit.
  IF public.fn_ca_diamond_economic('bbj_drop_per_hand', v_scope) <= 0 THEN
    RAISE EXCEPTION 'diamond_jackpot_stake_drops_nothing:%', v_scope USING ERRCODE = '23514';
  END IF;
  -- B17, the payout gates. The pot floor is a payout floor and only ever that.
  IF p_players_dealt IS NULL
     OR p_players_dealt < public.fn_ca_diamond_economic('bbj_min_dealt_in') THEN
    RAISE EXCEPTION 'diamond_jackpot_too_few_dealt_in:%', p_players_dealt USING ERRCODE = '23514';
  END IF;
  -- bbj_min_pot is recorded in DIAMONDS, per stake: ten big blinds of a
  -- whole-Diamond blind is a whole number of Diamonds, so the floor is stored
  -- as the figure the door compares against rather than as a multiplier the
  -- door would have to apply.
  IF p_pot IS NULL
     OR p_pot <= public.fn_ca_diamond_economic('bbj_min_pot', v_scope) THEN
    RAISE EXCEPTION 'diamond_jackpot_pot_below_the_payout_floor:%', p_pot USING ERRCODE = '23514';
  END IF;

  v_pool := public.fn_poker_diamond_jackpot_pool_for_table(p_table_id);
  IF v_pool IS NULL THEN
    RAISE EXCEPTION 'diamond_jackpot_pool_absent' USING ERRCODE = '23514';
  END IF;
  PERFORM 1 FROM public.poker_diamond_jackpot_pools WHERE id = v_pool FOR UPDATE;
  v_ref := 'bbjpay:' || p_table_id::text || ':' || p_hand_number::text;

  -- A REPLAY RETURNS WHAT IT PAID THE FIRST TIME AND PAYS NOTHING.
  IF EXISTS (SELECT 1 FROM public.poker_diamond_jackpot_ledger
              WHERE ref = v_ref AND kind = 'payout') THEN
    SELECT jsonb_build_object('replay', true, 'pool_id', v_pool, 'ref', v_ref,
             'paid', -COALESCE(sum(amount), 0),
             'legs', COALESCE(jsonb_agg(jsonb_build_object('role', recipient_role,
                        'user_id', recipient_user_id, 'amount', -amount) ORDER BY id), '[]'::jsonb))
      INTO v_credit FROM public.poker_diamond_jackpot_ledger
     WHERE ref = v_ref AND kind = 'payout';
    RETURN v_credit;
  END IF;

  IF EXISTS (SELECT 1 FROM public.ca_payout_freeze f
      WHERE f.scope IN ('bbj_payouts','arena_withdrawals') AND f.cleared_at IS NULL) THEN
    RAISE EXCEPTION 'payout_frozen: Diamond jackpot payout is held' USING ERRCODE='P0404';
  END IF;
  v_main := public.fn_poker_diamond_jackpot_bank(v_pool, 'backup');
  -- B19 is one shares answer per stake: what is paid, and how it divides.
  v_shares := public.fn_ca_diamond_economic_text('bbj_hit_shares', v_scope);
  v_pct  := public.fn_poker_diamond_jackpot_share(v_shares, 1, 'paid');
  -- B19, in whole Diamonds. Every division floors; what no floor could
  -- allocate is paid to the losing hand, so the announced total is exact.
  -- No money is taken from a player to round another player's share.
  v_paid := public.fn_ca_diamond_economic('mini_bbj_amount',v_scope)::bigint;
  IF v_main-v_paid < public.fn_ca_diamond_economic('mini_bbj_reserve_floor') THEN
    RETURN jsonb_build_object('paid',false,'reason','reserve_at_floor');
  END IF;
  IF v_paid <= 0 THEN
    RAISE EXCEPTION 'diamond_jackpot_pool_pays_nothing_yet:main=%', v_main USING ERRCODE = '23514';
  END IF;
  v_loser  := floor(v_paid * public.fn_poker_diamond_jackpot_share(v_shares, 1, 'loser')  / 100)::bigint;
  v_winner := floor(v_paid * public.fn_poker_diamond_jackpot_share(v_shares, 1, 'winner') / 100)::bigint;
  v_table_total := floor(v_paid * public.fn_poker_diamond_jackpot_share(v_shares, 1, 'table') / 100)::bigint;

  -- The rest of the table: everybody dealt in who is neither the loser nor the
  -- winner. Horses among them, on the same terms, never filtered out.
  SELECT COALESCE(array_agg(DISTINCT u ORDER BY u), '{}'::uuid[]) INTO v_others
    FROM unnest(COALESCE(p_table_user_ids, '{}'::uuid[])) u
   WHERE u IS DISTINCT FROM p_loser_user_id AND u IS DISTINCT FROM p_winner_user_id;
  v_n := COALESCE(array_length(v_others, 1), 0);
  IF v_n > 0 THEN
    v_each := (v_table_total / v_n)::bigint;
  ELSE
    v_each := 0;
  END IF;
  v_remainder := v_paid - v_loser - v_winner - v_each * v_n;
  v_loser := v_loser + v_remainder;

  -- One credit and one ledger leg per recipient.
  FOR v_rec IN
    SELECT p_loser_user_id AS user_id, 'loser'::text AS role, v_loser AS amount
    UNION ALL SELECT p_winner_user_id, 'winner', v_winner
    UNION ALL SELECT u, 'table', v_each FROM unnest(v_others) u
  LOOP
    CONTINUE WHEN v_rec.amount <= 0;
    v_key := v_ref || ':' || v_rec.role || ':' || v_rec.user_id::text;
    INSERT INTO public.wallet_credit_idempotency(key, user_id, amount)
    VALUES (v_key, v_rec.user_id, v_rec.amount) ON CONFLICT (key) DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    IF v_inserted = 0 THEN
      RAISE EXCEPTION 'diamond_jackpot_credit_key_already_claimed:%', v_key USING ERRCODE = '23505';
    END IF;
    v_credit := public.add_diamonds_to_balance(
      v_rec.user_id, v_rec.amount::integer, 'arena_withdraw',
      'Diamond Arena Mini Bad Beat Jackpot', v_key);
    IF COALESCE((v_credit->>'success')::boolean, false) IS NOT TRUE
       OR NULLIF(v_credit->>'transaction_id', '') IS NULL THEN
      RAISE EXCEPTION 'diamond_jackpot_credit_failed:%', v_credit->>'error' USING ERRCODE = 'P0404';
    END IF;
    INSERT INTO public.poker_diamond_jackpot_ledger(
      pool_id, bank, kind, amount, table_id, hand_number,
      recipient_user_id, recipient_role, wallet_journal_id, ref, note)
    VALUES (v_pool, 'backup', 'payout', -v_rec.amount, p_table_id, p_hand_number,
            v_rec.user_id, v_rec.role, (v_credit->>'transaction_id')::uuid, v_ref,
            'bad beat jackpot hit, ' || v_rec.role || ' share');
    v_paid_out := v_paid_out + v_rec.amount;
    v_legs := v_legs || jsonb_build_object('role', v_rec.role, 'user_id', v_rec.user_id,
                                           'amount', v_rec.amount);
  END LOOP;

  IF v_paid_out <> v_paid THEN
    RAISE EXCEPTION 'diamond_jackpot_paid_total_disagrees' USING ERRCODE = '23514';
  END IF;
  IF public.fn_poker_diamond_jackpot_bank(v_pool, 'backup') < public.fn_ca_diamond_economic('mini_bbj_reserve_floor') THEN
    RAISE EXCEPTION 'diamond_jackpot_main_bank_went_negative' USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_build_object(
    'pool_id', v_pool, 'ref', v_ref, 'backup_before', v_main, 'flat_amount', v_paid,
    'paid_total', v_paid, 'paid_out', v_paid_out,
    'left_in_main_pool', 0,
    'loser', v_loser, 'winner', v_winner, 'table_total', v_table_total,
    'table_each', v_each, 'table_remainder_left_in_pool', 0,
    'qualifying_hand', public.fn_poker_diamond_jackpot_qualifying_hand(v_variant),
    'legs', v_legs);
END $function$;

CREATE OR REPLACE FUNCTION public.fn_ca_commit_hand_settlement(p_table_id uuid, p_hand_number bigint, p_stacks jsonb, p_rake numeric, p_bbj numeric, p_ref text, p_inflow numeric, p_hand_row jsonb, p_units jsonb, p_instance_id text, p_lease_generation uuid, p_post_commit_obligations jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_result jsonb;
  v_diamond boolean := false;
  v_hand_id uuid;
  v_request_hash text;
  v_hash text;
  v_existing_request_hash text;
  v_existing_hash text;
  v_payload jsonb;
  v_club_id uuid;
  v_tournament_id uuid;
  v_item jsonb;
  v_expected integer;
  v_updated integer;
  v_row_count integer;
  v_exact_seat_generation boolean := false;
  -- LIGHTNING PHASE 6 (20261001154813): see fn_ca_settle_hand_stacks_absolute.
  v_lightning_seats jsonb := '{}'::jsonb;
  -- P14.2 (20261007024757): the accepted actor roster this result reports.
  v_accepted_roster jsonb;
  v_roster_state text;
BEGIN
  -- This public 12-argument door is the outermost accepted-hand authority.
  -- Take the lifecycle root before its preserved exact-generation core can
  -- lock a lease, tournament or table. The owner-only nine-argument core
  -- re-enters this shared transaction lock defensively; that acquisition is
  -- harmless and keeps the private core safe from future owner-only callers.
  PERFORM public.fn_ca_share_settlement_lane_for_table(p_table_id);
  PERFORM smarter_private.assert_retained_hand_submission(jsonb_build_object('p_table_id',p_table_id,'p_hand_number',p_hand_number,'p_stacks',p_stacks,'p_rake',p_rake,'p_bbj',p_bbj,'p_ref',p_ref,'p_inflow',p_inflow,'p_hand_row',p_hand_row,'p_units',p_units,'p_instance_id',p_instance_id,'p_lease_generation',p_lease_generation,'p_post_commit_obligations',p_post_commit_obligations));
  PERFORM smarter_private.f06_hand_dispatch_guard(p_table_id,p_hand_number);

  IF jsonb_typeof(p_post_commit_obligations) IS DISTINCT FROM 'object'
     OR p_post_commit_obligations->>'version' <> '1'
     OR jsonb_typeof(p_post_commit_obligations->'time_banks') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_post_commit_obligations->'promo_playthrough') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_post_commit_obligations->'insurance') IS DISTINCT FROM 'array'
     OR NOT (p_post_commit_obligations ? 'pending_addons')
     OR NOT (p_post_commit_obligations ? 'rake')
     OR NOT (p_post_commit_obligations ? 'bbj_contribution')
     OR p_post_commit_obligations ? 'accepted_hand_facts'
     /* P14.2: the accepted roster is produced by this transaction alone. */
     OR p_post_commit_obligations ? 'accepted_actor_roster'
     OR jsonb_typeof(p_post_commit_obligations->'rake') NOT IN ('object', 'null')
     OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') NOT IN ('object', 'null')
     OR jsonb_typeof(p_post_commit_obligations->'pending_addons') NOT IN ('object', 'null') THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_obligations)';
  END IF;

  -- Database-first expansion. The previous engine may send an entirely legacy
  -- roster while it drains, but exact and legacy identities never mix.
  IF jsonb_typeof(p_stacks) = 'array' AND jsonb_array_length(p_stacks) > 0 THEN
    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_stacks) x
       WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
          OR CASE WHEN x ? 'seat_id'
                  THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE false END
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (invalid_stack_seat_generation)';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE x ? 'seat_id')
       AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_stacks) x WHERE NOT (x ? 'seat_id')) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (mixed_stack_seat_generation_protocol)';
    END IF;
    SELECT COALESCE(bool_and(x ? 'seat_id' AND x ? 'seat_joined_at'), false)
      INTO v_exact_seat_generation
      FROM jsonb_array_elements(p_stacks) x;

    IF EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
       WHERE (x ? 'seat_id') IS DISTINCT FROM (x ? 'seat_joined_at')
          OR CASE WHEN x ? 'seat_id'
                  THEN jsonb_typeof(x->'seat_id') IS DISTINCT FROM 'string'
                    OR jsonb_typeof(x->'seat_joined_at') IS DISTINCT FROM 'string'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_id') = 'string'
                  THEN (x->>'seat_id') !~*
                    '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  ELSE false END
          OR CASE WHEN jsonb_typeof(x->'seat_joined_at') = 'string'
                  THEN NOT pg_input_is_valid(
                    x->>'seat_joined_at', 'timestamp with time zone'
                  )
                  ELSE false END
          OR (x ? 'seat_id') IS DISTINCT FROM v_exact_seat_generation
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (invalid_time_bank_seat_generation)';
    END IF;

    IF v_exact_seat_generation AND EXISTS (
      SELECT 1
        FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
       WHERE NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(p_stacks) s
          WHERE s->>'user_id' = x->>'user_id'
            AND s->>'seat_id' = x->>'seat_id'
            AND (s->>'seat_joined_at')::timestamptz =
                (x->>'seat_joined_at')::timestamptz
       )
    ) THEN
      RAISE EXCEPTION
        'atomic hand commit refused (time_bank_seat_generation_mismatch)';
    END IF;
  END IF;

  IF jsonb_typeof(p_hand_row->'_accepted_post_commit_facts') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'pot_size') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_hand_row->'big_blind') IS DISTINCT FROM 'number'
     OR COALESCE(p_rake, 0) < 0
     OR COALESCE(p_bbj, 0) < 0
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'contributions')
          IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled')
          IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_hand_row->'_accepted_post_commit_facts'->'insurance')
          IS DISTINCT FROM 'array'
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'contributions') e
        WHERE e.key !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(e.value) IS DISTINCT FROM 'number'
           OR CASE WHEN jsonb_typeof(e.value) = 'number'
                   THEN (e.value::text)::numeric < 0 ELSE false END
     )
     OR EXISTS (
       SELECT 1
         FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled') e
        WHERE e.key !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR jsonb_typeof(e.value) IS DISTINCT FROM 'number'
           OR CASE WHEN jsonb_typeof(e.value) = 'number'
                   THEN (e.value::text)::numeric < 0 ELSE false END
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_accepted_post_commit_facts)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     WHERE (x->>'user_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'uses_remaining') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'seconds_remaining') IS DISTINCT FROM 'number'
        OR (x->>'uses_remaining') !~ '^[0-9]+$'
        OR (x->>'seconds_remaining') !~ '^[0-9]+$'
        OR CASE WHEN (x->>'uses_remaining') ~ '^[0-9]+$'
                THEN (x->>'uses_remaining')::numeric > 2147483647 ELSE false END
        OR CASE WHEN (x->>'seconds_remaining') ~ '^[0-9]+$'
                THEN (x->>'seconds_remaining')::numeric > 2147483647 ELSE false END
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     WHERE (x->>'club_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR (x->>'user_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'wagered') IS DISTINCT FROM 'number'
        OR CASE WHEN jsonb_typeof(x->'wagered') = 'number'
                THEN (x->>'wagered')::numeric <= 0 ELSE false END
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     WHERE (x->>'club_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR (x->>'player_id') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR jsonb_typeof(x->'equity_percent') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'premium') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'insured_amount') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'payout') IS DISTINCT FROM 'number'
        OR jsonb_typeof(x->'player_won') IS DISTINCT FROM 'boolean'
        OR COALESCE(x->>'kind', '') NOT IN ('insurance', 'ev_cashout')
        OR CASE WHEN jsonb_typeof(x->'equity_percent') = 'number'
                THEN (x->>'equity_percent')::numeric NOT BETWEEN 0 AND 100 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'premium') = 'number'
                THEN (x->>'premium')::numeric < 0 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'insured_amount') = 'number'
                THEN (x->>'insured_amount')::numeric < 0 ELSE false END
        OR CASE WHEN jsonb_typeof(x->'payout') = 'number'
                THEN (x->>'payout')::numeric < 0 ELSE false END
  ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_item)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'rake'->'amount') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'bbj') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'pot') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'num_players') IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'contributions') IS DISTINCT FROM 'object'
       OR jsonb_typeof(p_post_commit_obligations->'rake'->'returned_uncalled') IS DISTINCT FROM 'object'
       OR (p_post_commit_obligations->'rake'->>'num_players') !~ '^[0-9]+$'
       OR COALESCE((p_post_commit_obligations->'rake'->>'amount')::numeric, 0) <= 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'bbj')::numeric, 0) < 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'pot')::numeric, -1) < 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'num_players')::numeric, 0) <= 0
       OR COALESCE((p_post_commit_obligations->'rake'->>'num_players')::numeric, 0)
            > 2147483647
       OR (p_post_commit_obligations->'rake'->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR COALESCE(p_post_commit_obligations->'rake'->>'method', '')
            <> 'WEIGHTED_CONTRIBUTED'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_rake)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'bbj_contribution'->'amount')
         IS DISTINCT FROM 'number'
       OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution'->'big_blind')
         IS DISTINCT FROM 'number'
       OR COALESCE((p_post_commit_obligations->'bbj_contribution'->>'amount')::numeric, 0)
            <= 0
       OR COALESCE((p_post_commit_obligations->'bbj_contribution'->>'big_blind')::numeric, 0)
            <= 0
       OR (p_post_commit_obligations->'bbj_contribution'->>'club_id') !~*
          '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_bbj)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'pending_addons') = 'object'
     AND (
       jsonb_typeof(p_post_commit_obligations->'pending_addons'->'enabled')
         IS DISTINCT FROM 'boolean'
       OR CASE
            WHEN jsonb_typeof(p_post_commit_obligations->'pending_addons'->'enabled') = 'boolean'
            THEN COALESCE(
              (p_post_commit_obligations->'pending_addons'->>'enabled')::boolean,
              false
            ) IS NOT TRUE
            ELSE false
          END
       OR jsonb_typeof(p_post_commit_obligations->'pending_addons'->'max_buy_in')
            IS DISTINCT FROM 'number'
       OR COALESCE(
            (p_post_commit_obligations->'pending_addons'->>'max_buy_in')::numeric,
            0
          ) <= 0
       OR p_post_commit_obligations->'pending_addons' ? 'ids'
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_addons)';
  END IF;

  IF p_hand_number > 2147483647
     AND (
       jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
       OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
       OR jsonb_array_length(p_post_commit_obligations->'insurance') > 0
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_hand_number_out_of_range)';
  END IF;

  -- DIAMOND PHASE 8: the Diamond cash rules below are cash rules; a Diamond
  -- tournament hand carries a tournament rake scope and no add-on lane, and
  -- is judged by the tournament rules exactly as a chip tournament hand is.
  SELECT EXISTS(SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
    WHERE t.id=p_table_id AND c.asset='diamonds' AND t.tournament_id IS NULL) INTO v_diamond;
  IF v_diamond AND (
    jsonb_array_length(p_post_commit_obligations->'promo_playthrough')<>0
    OR jsonb_array_length(p_post_commit_obligations->'insurance')<>0
    OR jsonb_typeof(p_post_commit_obligations->'rake') IS DISTINCT FROM 'null'
    OR jsonb_typeof(p_post_commit_obligations->'bbj_contribution') IS DISTINCT FROM 'null'
    OR jsonb_typeof(p_post_commit_obligations->'pending_addons') IS DISTINCT FROM 'null'
    -- DIAMOND PHASE 9, STEP 0: every game the arena deals, as the settler reads it.
    OR NOT public.fn_poker_diamond_cash_variant(p_hand_row->>'game_variant')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(p_units,'[]'::jsonb)) u
      WHERE (u->>'amount') IS NULL
         OR (u->>'amount')::numeric<>trunc((u->>'amount')::numeric))
    OR COALESCE(NULLIF(p_hand_row->'daily_mission_events','null'::jsonb),'[]'::jsonb)<>'[]'::jsonb
    OR (p_hand_row->>'pot_size')::numeric<>trunc((p_hand_row->>'pot_size')::numeric)
    OR EXISTS(SELECT 1 FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'contributions') e
      WHERE (e.value::text)::numeric<>trunc((e.value::text)::numeric))
    OR EXISTS(SELECT 1 FROM jsonb_each(p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled') e
      WHERE (e.value::text)::numeric<>trunc((e.value::text)::numeric))
  ) THEN
    RAISE EXCEPTION 'atomic hand commit refused (diamond_chip_obligation_or_fractional_fact)';
  END IF;

  v_request_hash := encode(
    extensions.digest(convert_to(p_post_commit_obligations::text, 'UTF8'), 'sha256'),
    'hex'
  );

  /* ONE SEAT WRITE PER HAND (2026-09-10). The time-bank items above are
     already proven well formed and bound to the exact stack roster. Publish
     them for this exact table+hand in a transaction-local setting so the
     stack core (fn_ca_settle_hand_stacks_absolute) can carry the two
     time-bank columns on its stack write instead of this door writing every
     seat row a second time. The setting is cleared as soon as the core
     returns; a stale value can only name a hand the core refuses as a
     replay. The loop below still proves the resulting seat state before it
     counts it, and still writes any seat the core did not carry. */
  PERFORM set_config(
    'app.ca_hand_time_banks',
    jsonb_build_object(
      'table_id', p_table_id,
      'hand_number', p_hand_number,
      'exact', v_exact_seat_generation,
      'items', p_post_commit_obligations->'time_banks'
    )::text,
    true
  );

  /* The owner-only exact-generation core locks and proves the cash-table or
     tournament generation, then runs the unchanged accepted-hand core. Its
     lease/table locks remain held until this outer transaction commits. */
  v_result := public.fn_ca_commit_hand_settlement_exact_before_obligations(
    p_table_id,
    p_hand_number,
    p_stacks,
    p_rake,
    p_bbj,
    p_ref,
    p_inflow,
    p_hand_row,
    p_units,
    p_instance_id,
    p_lease_generation
  );
  PERFORM set_config('app.ca_hand_time_banks', '', true);
  -- LIGHTNING PHASE 6 (20261001154813): the anchors a Lightning settlement in
  -- this transaction names, so the three time-bank statements below find each
  -- at its own table; '{}' for every physical hand.
  v_lightning_seats := public.fn_lightning_settlement_seats(p_table_id, p_hand_number);

  IF COALESCE((v_result->>'success')::boolean, false) IS NOT TRUE
     OR COALESCE((v_result->>'atomic_hand_commit')::boolean, false) IS NOT TRUE THEN
    RETURN v_result;
  END IF;

  BEGIN
    v_hand_id := (v_result->>'history_id')::uuid;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'atomic hand commit refused (invalid_post_commit_history_receipt)';
  END;
  IF v_hand_id IS NULL THEN
    RAISE EXCEPTION
      'atomic hand commit refused (missing_post_commit_history_receipt)';
  END IF;

  SELECT t.club_id, t.tournament_id
    INTO v_club_id, v_tournament_id
    FROM public.tables t
   WHERE t.id = p_table_id;
  IF NOT FOUND OR v_club_id IS NULL THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_table_scope_missing)';
  END IF;

  /* The envelope cannot contradict the accepted hand. Amounts bind to the
     settlement arguments; every per-player item binds to its authoritative
     stack roster; every money item binds to the table's club. */
  IF (NOT v_diamond AND (
       (COALESCE(p_rake, 0) > 0) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'rake') = 'object')
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'amount')::numeric
             IS DISTINCT FROM p_rake
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'bbj')::numeric
             IS DISTINCT FROM COALESCE(p_bbj, 0)
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'pot')::numeric
             IS DISTINCT FROM (p_hand_row->>'pot_size')::numeric
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND (p_post_commit_obligations->'rake'->>'num_players')::integer
             IS DISTINCT FROM (
               SELECT count(*)::integer
                 FROM jsonb_object_keys(
                   p_hand_row->'_accepted_post_commit_facts'->'contributions'
                 )
             )
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND p_post_commit_obligations->'rake'->'contributions'
             IS DISTINCT FROM
             p_hand_row->'_accepted_post_commit_facts'->'contributions'
     )
     OR (
       COALESCE(p_rake, 0) > 0
       AND p_post_commit_obligations->'rake'->'returned_uncalled'
             IS DISTINCT FROM
             p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled'
     )))
     /* A RAKED DIAMOND CASH HAND IS NOT A CHIP RAKE OBLIGATION (2026-10-06).
        The seven clauses above bind a CHIP rake to the chip post-commit leg
        that pays it out, and they bind it unchanged. A Diamond cash hand has
        no such leg: fn_poker_diamond_settle_cash_hand recomputes its rake
        from the owner's settings and accrues it per payer inside this same
        transaction, and the Diamond refusal above requires its chip rake
        object to be null. Bound to a chip object as well, every raked
        Diamond hand refused here as post_commit_fee_mismatch. Its own rule,
        the null object, is stated again here so this check stays total. */
     OR (v_diamond
         AND jsonb_typeof(p_post_commit_obligations->'rake') IS DISTINCT FROM 'null')
     OR (NOT v_diamond AND (
       (COALESCE(p_bbj, 0) > 0) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object')
     OR (
       COALESCE(p_bbj, 0) > 0
       AND (p_post_commit_obligations->'bbj_contribution'->>'amount')::numeric
             IS DISTINCT FROM p_bbj
     )
     OR (
       COALESCE(p_bbj, 0) > 0
       AND (p_post_commit_obligations->'bbj_contribution'->>'big_blind')::numeric
             IS DISTINCT FROM (p_hand_row->>'big_blind')::numeric
     )))
     OR (v_diamond AND jsonb_typeof(p_post_commit_obligations->'bbj_contribution') IS DISTINCT FROM 'null') THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_fee_mismatch)';
  END IF;

  IF p_post_commit_obligations->'insurance' IS DISTINCT FROM
       p_hand_row->'_accepted_post_commit_facts'->'insurance' THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_insurance_fact_mismatch)';
  END IF;

  IF (
       v_tournament_id IS NULL AND NOT v_diamond
       AND (
         jsonb_array_length(p_post_commit_obligations->'promo_playthrough')
           IS DISTINCT FROM (
             SELECT count(*)::integer
               FROM jsonb_each(
                 p_hand_row->'_accepted_post_commit_facts'->'contributions'
               ) e
              WHERE (e.value::text)::numeric > 0
           )
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
            WHERE (x->>'wagered')::numeric IS DISTINCT FROM
                  (
                    p_hand_row->'_accepted_post_commit_facts'->'contributions'->>
                    (x->>'user_id')
                  )::numeric
         )
       )
     ) OR (
       (v_tournament_id IS NOT NULL OR v_diamond)
       AND jsonb_array_length(p_post_commit_obligations->'promo_playthrough') <> 0
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_promo_fact_mismatch)';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
        WHERE s->>'user_id' = x->>'user_id'
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_object_keys(
        p_hand_row->'_accepted_post_commit_facts'->'contributions'
      ) uid
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_stacks) s
        WHERE s->>'user_id' = uid
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_object_keys(
        p_hand_row->'_accepted_post_commit_facts'->'returned_uncalled'
      ) uid
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(p_stacks) s
        WHERE s->>'user_id' = uid
     )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     WHERE x->>'club_id' IS DISTINCT FROM v_club_id::text
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
           WHERE s->>'user_id' = x->>'user_id'
        )
  ) OR EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     WHERE x->>'club_id' IS DISTINCT FROM v_club_id::text
        OR NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(COALESCE(p_stacks, '[]'::jsonb)) s
           WHERE s->>'user_id' = x->>'player_id'
        )
  ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_player_or_club_mismatch)';
  END IF;

  /* Repeated recipients would turn one accepted-hand fact into two additive
     mutations. Time-bank rows are exhaustive because omitting one would make
     the accepted seat state depend on whichever process ran before this one. */
  IF jsonb_array_length(p_post_commit_obligations->'time_banks')
       IS DISTINCT FROM jsonb_array_length(p_stacks)
     OR (
       SELECT count(DISTINCT x->>'user_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'time_banks') x
     ) IS DISTINCT FROM jsonb_array_length(p_stacks)
     OR (
       SELECT count(DISTINCT x->>'user_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'promo_playthrough') x
     ) IS DISTINCT FROM jsonb_array_length(p_post_commit_obligations->'promo_playthrough')
     OR (
       /* The durable insurance writer is unique per table/hand/player. Two
          different kinds for one player would look like two obligations here
          but collapse to one receipt downstream. Refuse that ambiguity. */
       SELECT count(DISTINCT x->>'player_id')
         FROM jsonb_array_elements(p_post_commit_obligations->'insurance') x
     ) IS DISTINCT FROM jsonb_array_length(p_post_commit_obligations->'insurance') THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_duplicate_or_missing_recipient)';
  END IF;

  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       EXISTS (
         SELECT 1
           FROM jsonb_object_keys(
             COALESCE(p_post_commit_obligations->'rake'->'contributions', '{}'::jsonb)
           ) uid
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_stacks) s
             WHERE s->>'user_id' = uid
          )
       )
       OR EXISTS (
         SELECT 1
           FROM jsonb_object_keys(
             COALESCE(p_post_commit_obligations->'rake'->'returned_uncalled', '{}'::jsonb)
           ) uid
          WHERE NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p_stacks) s
             WHERE s->>'user_id' = uid
          )
       )
     ) THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_rake_recipient_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND p_post_commit_obligations->'rake'->>'club_id' IS DISTINCT FROM v_club_id::text THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_rake_club_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'bbj_contribution') = 'object'
     AND p_post_commit_obligations->'bbj_contribution'->>'club_id'
           IS DISTINCT FROM v_club_id::text THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_bbj_club_mismatch)';
  END IF;
  IF jsonb_typeof(p_post_commit_obligations->'rake') = 'object'
     AND (
       COALESCE(p_post_commit_obligations->'rake'->>'tournament_id', '')
         IS DISTINCT FROM COALESCE(v_tournament_id::text, '')
       OR COALESCE(p_post_commit_obligations->'rake'->>'method', '')
            <> 'WEIGHTED_CONTRIBUTED'
     ) THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_rake_scope_mismatch)';
  END IF;
  IF (v_tournament_id IS NULL AND NOT v_diamond) IS DISTINCT FROM
       (jsonb_typeof(p_post_commit_obligations->'pending_addons') = 'object') THEN
    RAISE EXCEPTION 'atomic hand commit refused (post_commit_addon_scope_mismatch)';
  END IF;

  SELECT c.post_commit_request_hash, c.post_commit_payload_hash
    INTO v_existing_request_hash, v_existing_hash
    FROM public.hand_atomic_commits c
   WHERE c.table_id = p_table_id
     AND c.hand_number = p_hand_number
     AND c.hand_id = v_hand_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'atomic hand commit refused (missing_post_commit_atomic_receipt)';
  END IF;
  IF v_existing_request_hash IS NOT NULL
     AND v_existing_request_hash IS DISTINCT FROM v_request_hash THEN
    RAISE EXCEPTION
      'atomic hand commit refused (post_commit_payload_conflict)';
  END IF;

  IF v_existing_request_hash IS NULL THEN
    /* A rolling 11-argument engine may already have committed this hand and
       run its legacy post-commit steps. Never attach a new additive envelope
       to that receipt. A response-loss replay from this 12-argument door
       always finds the request hash written by its first transaction. */
    IF COALESCE((v_result->>'replay')::boolean, false) IS TRUE THEN
      RAISE EXCEPTION
        'atomic hand commit refused (legacy_receipt_has_no_post_commit_envelope)';
    END IF;

    /* Copy the independently accepted facts into the immutable stored envelope.
       The caller is forbidden from supplying this key itself. Besides the core
       hand hash, the durable processor/audit row can therefore show exactly
       which first-narrative facts every derived obligation was checked against. */
    v_payload := jsonb_set(
      p_post_commit_obligations,
      '{accepted_hand_facts}',
      p_hand_row->'_accepted_post_commit_facts',
      true
    );
    IF jsonb_typeof(v_payload->'pending_addons') = 'object' THEN
      /* Own the exact eligible rows through commit. A legacy/manual resolver
         cannot consume one after it was frozen but before the obligation
         transaction gets its causal wake. */
      PERFORM 1
        FROM public.table_pending_addons a
       WHERE a.table_id = p_table_id
         AND a.resolved_at IS NULL
         AND a.created_at <= transaction_timestamp()
       ORDER BY a.created_at, a.id
       FOR UPDATE;
      v_payload := jsonb_set(
        v_payload,
        '{pending_addons,ids}',
        COALESCE((
          SELECT jsonb_agg(a.id ORDER BY a.created_at, a.id)
            FROM public.table_pending_addons a
           WHERE a.table_id = p_table_id
             AND a.resolved_at IS NULL
             AND a.created_at <= transaction_timestamp()
        ), '[]'::jsonb),
        true
      );
    END IF;
    v_hash := encode(
      extensions.digest(convert_to(v_payload::text, 'UTF8'), 'sha256'),
      'hex'
    );

    /* Time-bank state belongs to the accepted-hand boundary itself. Apply it
       while the exact lease/table/seat locks inherited from the owner-only
       exact-generation core are still held, never later from a stale envelope. */
    v_expected := jsonb_array_length(v_payload->'time_banks');
    v_updated := 0;
    FOR v_item IN
      SELECT value FROM jsonb_array_elements(v_payload->'time_banks')
       ORDER BY value->>'user_id'
    LOOP
      IF (v_item->>'user_id') !~*
           '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         OR (v_item->>'uses_remaining') !~ '^[0-9]+$'
         OR (v_item->>'seconds_remaining') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION
          'atomic hand commit refused (invalid_time_bank_obligation)';
      END IF;
      IF smarter_private.retired_cash_original_time_bank(p_table_id,p_hand_number,v_item) THEN
        v_updated:=v_updated+1;
        CONTINUE;
      END IF;
      /* ONE SEAT WRITE PER HAND (2026-09-10). The stack core carried these
         two columns on its stack write from the envelope published above.
         Prove that exact state on the exact row first (the same predicate
         the lawful-noop rule below has always used) and count it without a
         second write. Only a seat the core did not carry - a cash seat that
         left during the hand is settled against its wallet and gets no stack
         write - takes the UPDATE, exactly as before. */
      SELECT count(*)::integer INTO v_row_count
        FROM public.table_seats s
       WHERE s.table_id = COALESCE((v_lightning_seats->>(v_item->>'user_id'))::uuid, p_table_id)
         AND s.user_id = (v_item->>'user_id')::uuid
         AND s.time_bank_uses_remaining = (v_item->>'uses_remaining')::integer
         AND s.time_bank_remaining = (v_item->>'seconds_remaining')::integer
         AND (
           (v_exact_seat_generation
             AND s.id = (v_item->>'seat_id')::uuid
             AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
           OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
         );
      IF v_row_count = 0 THEN
      UPDATE public.table_seats s
         SET time_bank_uses_remaining = (v_item->>'uses_remaining')::integer,
             time_bank_remaining = (v_item->>'seconds_remaining')::integer
       WHERE s.table_id = COALESCE((v_lightning_seats->>(v_item->>'user_id'))::uuid, p_table_id)
         AND s.user_id = (v_item->>'user_id')::uuid
         AND (
           (v_exact_seat_generation
             AND s.id = (v_item->>'seat_id')::uuid
             AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
           OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
         );
      GET DIAGNOSTICS v_row_count = ROW_COUNT;
      /* Preserve the stack writer's lawful-noop rule. If a redundant-update
         suppressor is installed, ROW_COUNT may be zero even though the exact
         row already stores the requested state. Prove that exact state before
         counting it; a missing or replaced generation still refuses whole. */
      IF v_row_count = 0 AND EXISTS (
        SELECT 1
          FROM public.table_seats s
         WHERE s.table_id = COALESCE((v_lightning_seats->>(v_item->>'user_id'))::uuid, p_table_id)
           AND s.user_id = (v_item->>'user_id')::uuid
           AND s.time_bank_uses_remaining = (v_item->>'uses_remaining')::integer
           AND s.time_bank_remaining = (v_item->>'seconds_remaining')::integer
           AND (
             (v_exact_seat_generation
               AND s.id = (v_item->>'seat_id')::uuid
               AND s.joined_at = (v_item->>'seat_joined_at')::timestamptz)
             OR (NOT v_exact_seat_generation AND (
           s.left_at IS NULL
           OR (
             v_tournament_id IS NOT NULL
             AND s.stack = 0
             AND lower(COALESCE(s.status, '')) = 'left'
             AND s.left_at =
                   (v_result->>'tournament_zero_stack_vacated_at')::timestamptz
             AND EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(
                        v_result->'tournament_zero_stack_seat_generations'
                      ) generation(value)
                WHERE (generation.value->>'seat_id')::uuid = s.id
                  AND (generation.value->>'user_id')::uuid = s.user_id
                  AND (generation.value->>'seat_number')::integer = s.seat_number
                  AND (generation.value->>'joined_at')::timestamptz = s.joined_at
             )
           )
         ))
           )
      ) THEN
        v_row_count := 1;
      END IF;
      END IF;
      v_updated := v_updated + v_row_count;
    END LOOP;
    IF v_updated IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION
        'atomic hand commit refused (time_bank_seat_mismatch)';
    END IF;

    UPDATE public.hand_atomic_commits c
       SET post_commit_payload = v_payload,
           post_commit_request_hash = v_request_hash,
           post_commit_payload_hash = v_hash
     WHERE c.table_id = p_table_id
       AND c.hand_number = p_hand_number
       AND c.hand_id = v_hand_id
       AND c.post_commit_request_hash IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_receipt_raced)';
    END IF;

    /* THE ACCEPTED ROSTER (P14.2, 20261007024757). First acceptance only,
       under the locks already held, from the exact seat generations the stack
       core proved and profiles read now. It never changes the envelope, its
       hashes, money or stacks, and it can never fail the hand: any error here
       is reported as 'unavailable' and the hand settles as before. */
    BEGIN
      v_accepted_roster := smarter_private.accepted_hand_roster_first(
        p_table_id, p_hand_number, v_hand_id, p_stacks,
        v_exact_seat_generation, v_lightning_seats, v_hash);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_roster_state = RETURNED_SQLSTATE;
      v_accepted_roster := jsonb_build_object('version', 1, 'status', 'unavailable',
        'reasons', jsonb_build_array('roster_producer_error:' || v_roster_state),
        'payloadDigest', v_hash, 'producerVersion', 'accepted_hand_roster_v1',
        'roster', NULL);
    END;
  ELSE
    v_hash := v_existing_hash;
    IF v_hash IS NULL THEN
      RAISE EXCEPTION
        'atomic hand commit refused (post_commit_payload_hash_missing)';
    END IF;
    /* P14.2: a replay returns the stored roster exactly; today's profiles
       are never consulted again. */
    BEGIN
      v_accepted_roster := smarter_private.accepted_hand_roster_replay(
        p_table_id, p_hand_number, v_hand_id, v_hash);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_roster_state = RETURNED_SQLSTATE;
      v_accepted_roster := jsonb_build_object('version', 1, 'status', 'unavailable',
        'reasons', jsonb_build_array('roster_replay_error:' || v_roster_state),
        'payloadDigest', v_hash, 'producerVersion', 'accepted_hand_roster_v1',
        'roster', NULL);
    END;
  END IF;

  RETURN v_result || jsonb_build_object(
    'post_commit_obligations', true,
    'post_commit_payload_hash', v_hash,
    'accepted_roster', v_accepted_roster,
    'diamond_jackpot_receipt', CASE WHEN v_diamond THEN (
      SELECT j.receipt FROM public.poker_diamond_jackpot_hits j
      WHERE j.table_id=p_table_id AND j.hand_number=p_hand_number
    ) ELSE NULL END
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.fn_poker_diamond_jackpot_pay(uuid,bigint,numeric,integer,uuid,uuid,uuid[]) FROM service_role;
-- Replaced definitions retain their installed ACLs. State the same closed
-- boundary explicitly so this migration is self-contained for qualification.
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_pay(uuid,bigint,numeric,integer,uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_settle_cash_hand(uuid,bigint,jsonb,numeric,numeric,text,numeric) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_commit_hand_settlement(uuid,bigint,jsonb,numeric,numeric,text,numeric,jsonb,jsonb,text,uuid,jsonb) TO service_role;

-- One causal accepted-hand event owns the payout and its immutable receipt.
CREATE FUNCTION public.fn_poker_diamond_jackpot_accept_hand()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE
 v_verdict jsonb; v_facts jsonb; v_ids uuid[]; v_expected_ids uuid[];
 v_loser uuid; v_winner uuid; v_pool uuid; v_pay jsonb; v_receipt jsonb;
 v_total bigint; v_table_share bigint; v_each bigint; v_loser_share bigint; v_winner_share bigint;
 v_main bigint; v_paid bigint; v_scope text; v_kind text; v_id uuid:=gen_random_uuid();
 v_variant text; v_bb numeric; v_arena uuid; v_paid_flag boolean:=false; v_leg jsonb; v_name text;
BEGIN
 IF OLD.post_commit_payload IS NOT NULL OR NEW.post_commit_payload IS NULL THEN RETURN NEW; END IF;
 v_verdict:=NEW.post_commit_payload->'accepted_hand_facts'->'diamond_jackpot';
 IF v_verdict IS NULL THEN
   IF EXISTS (SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id=t.club_id
      WHERE t.id=NEW.table_id AND c.asset='diamonds' AND t.tournament_id IS NULL)
      AND public.fn_ca_diamond_economic_on('bbj_enabled') THEN
     RAISE EXCEPTION 'diamond_jackpot_accepted_verdict_required';
   END IF;
   RETURN NEW;
 END IF; -- previous engine remains compatible while switch is no
 IF jsonb_typeof(v_verdict) IS DISTINCT FROM 'object'
    OR v_verdict->>'version' IS DISTINCT FROM '1'
    OR COALESCE(v_verdict->>'kind','') NOT IN ('none','main','mini') THEN
   RAISE EXCEPTION 'diamond_jackpot_invalid_accepted_verdict' USING ERRCODE='22023';
 END IF;
 v_kind:=v_verdict->>'kind';
 SELECT t.game_variant,t.big_blind,t.club_id INTO v_variant,v_bb,v_arena FROM public.tables t
   JOIN public.clubs c ON c.id=t.club_id
   WHERE t.id=NEW.table_id AND t.tournament_id IS NULL AND c.asset='diamonds'
     AND c.is_platform IS TRUE AND c.union_id IS NULL AND t.union_id IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'diamond_jackpot_wrong_hand_scope'; END IF;
 IF v_kind='none' THEN RETURN NEW; END IF;
 SELECT request->'rake_facts' INTO v_facts FROM public.poker_diamond_hand_receipts
   WHERE table_id=NEW.table_id AND hand_number=NEW.hand_number;
 IF v_facts IS NULL OR jsonb_typeof(v_verdict->'pot') IS DISTINCT FROM 'number'
    OR jsonb_typeof(v_verdict->'dealt') IS DISTINCT FROM 'number'
    OR jsonb_typeof(v_verdict->'saw_flop') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(v_verdict->'double_board') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(v_verdict->'big_blind') IS DISTINCT FROM 'number'
    OR jsonb_typeof(v_verdict->'dealt_user_ids') IS DISTINCT FROM 'array'
    OR v_verdict->'pot' IS DISTINCT FROM v_facts->'pot'
    OR v_verdict->'dealt' IS DISTINCT FROM v_facts->'dealt'
    OR v_verdict->'saw_flop' IS DISTINCT FROM v_facts->'saw_flop'
    OR v_verdict->'double_board' IS DISTINCT FROM v_facts->'double_board'
    OR v_verdict->>'variant' IS DISTINCT FROM v_variant
    OR (v_verdict->>'big_blind')::numeric IS DISTINCT FROM v_bb
    OR (v_verdict->>'saw_flop')::boolean IS NOT TRUE
    OR (v_verdict->>'double_board')::boolean IS NOT FALSE THEN
   RAISE EXCEPTION 'diamond_jackpot_verdict_disagrees_with_accepted_hand';
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_verdict->'dealt_user_ids') x
      WHERE jsonb_typeof(x) IS DISTINCT FROM 'string' OR NOT pg_input_is_valid(x#>>'{}','uuid'))
   OR pg_input_is_valid(v_verdict->>'loser_user_id','uuid') IS DISTINCT FROM true
   OR pg_input_is_valid(v_verdict->>'winner_user_id','uuid') IS DISTINCT FROM true
   OR NULLIF(v_verdict->>'loser_hand','') IS NULL OR NULLIF(v_verdict->>'winner_hand','') IS NULL THEN
   RAISE EXCEPTION 'diamond_jackpot_recipient_identity_required';
 END IF;
 SELECT array_agg(DISTINCT (x#>>'{}')::uuid ORDER BY (x#>>'{}')::uuid) INTO v_ids
   FROM jsonb_array_elements(v_verdict->'dealt_user_ids') x;
 SELECT array_agg((x->>'user_id')::uuid ORDER BY (x->>'user_id')::uuid) INTO v_expected_ids
   FROM jsonb_array_elements(v_facts->'contributions') x WHERE (x->>'dealt_in')::boolean;
 v_loser:=(v_verdict->>'loser_user_id')::uuid;
 v_winner:=(v_verdict->>'winner_user_id')::uuid;
 IF v_ids IS DISTINCT FROM v_expected_ids OR cardinality(v_ids)<>(v_verdict->>'dealt')::integer
    OR cardinality(v_ids)<>jsonb_array_length(v_verdict->'dealt_user_ids')
    OR v_loser=v_winner OR NOT(v_loser=ANY(v_ids)) OR NOT(v_winner=ANY(v_ids)) THEN
   RAISE EXCEPTION 'diamond_jackpot_recipients_disagree_with_dealt_roster';
 END IF;
 v_pool:=public.fn_poker_diamond_jackpot_pool_for_table(NEW.table_id);
 IF v_pool IS NULL THEN RAISE EXCEPTION 'diamond_jackpot_pool_absent'; END IF;
 PERFORM 1 FROM public.poker_diamond_jackpot_pools WHERE id=v_pool FOR UPDATE;
 v_scope:=public.fn_poker_diamond_jackpot_stake_scope(v_bb);
 IF v_kind='main' THEN
   v_main:=public.fn_poker_diamond_jackpot_bank(v_pool,'main');
   v_paid:=floor(v_main*public.fn_poker_diamond_jackpot_share(
       public.fn_ca_diamond_economic_text('bbj_hit_shares',v_scope),1,'paid')/100)::bigint;
   IF v_paid>0 THEN
     v_pay:=public.fn_poker_diamond_jackpot_pay(NEW.table_id,NEW.hand_number,
       (v_verdict->>'pot')::numeric,(v_verdict->>'dealt')::integer,v_loser,v_winner,v_ids);
     v_paid_flag:=true;
   ELSE
     v_pay:=jsonb_build_object('paid',false,'reason','pool_funding');
   END IF;
 ELSE
   v_pay:=public.fn_poker_diamond_jackpot_pay_mini(NEW.table_id,NEW.hand_number,
     (v_verdict->>'pot')::numeric,(v_verdict->>'dealt')::integer,v_loser,v_winner,v_ids);
   v_paid_flag:=v_pay ? 'legs';
 END IF;
 IF v_paid_flag THEN
   SELECT COALESCE(sum((x->>'amount')::bigint),0),
     COALESCE(sum((x->>'amount')::bigint) FILTER(WHERE x->>'role'='table'),0),
     COALESCE(max((x->>'amount')::bigint) FILTER(WHERE x->>'role'='table'),0),
     COALESCE(sum((x->>'amount')::bigint) FILTER(WHERE x->>'role'='loser'),0),
     COALESCE(sum((x->>'amount')::bigint) FILTER(WHERE x->>'role'='winner'),0)
   INTO v_total,v_table_share,v_each,v_loser_share,v_winner_share
   FROM jsonb_array_elements(v_pay->'legs') x;
   IF v_total<=0 OR v_total IS DISTINCT FROM (v_pay->>'paid_out')::bigint THEN
     RAISE EXCEPTION 'diamond_jackpot_paid_receipt_incomplete';
   END IF;
 ELSE v_total:=0; v_table_share:=0; v_each:=0; v_loser_share:=0; v_winner_share:=0;
 END IF;
 v_receipt:=jsonb_build_object('id',v_id,'paid',v_paid_flag,'kind',v_kind,'asset','diamonds',
   'pool_id',v_pool,'table_id',NEW.table_id,'hand_number',NEW.hand_number,'hand_id',NEW.hand_id,'total',v_total,
   'loser',jsonb_build_object('userId',v_loser,'share',v_loser_share),
   'winner',jsonb_build_object('userId',v_winner,'share',v_winner_share),
   'tableShare',v_table_share,'perPlayerShare',v_each,
   'tablePlayerIds',to_jsonb(array_remove(array_remove(v_ids,v_loser),v_winner)),
   'reason',v_pay->>'reason','payment',v_pay);
 IF v_paid_flag THEN
   v_name:=CASE WHEN v_kind='mini' THEN 'Mini Bad Beat Jackpot' ELSE 'Bad Beat Jackpot' END;
   FOR v_leg IN SELECT value FROM jsonb_array_elements(v_pay->'legs') LOOP
     IF (v_leg->>'amount')::bigint>0 AND COALESCE((SELECT diamond_rewards
       FROM public.user_notification_preferences WHERE user_id=(v_leg->>'user_id')::uuid),true) THEN
       PERFORM public.fn_raise_notification((v_leg->>'user_id')::uuid,'bonus',
         v_name||' - You Got Paid!',
         'Your '||v_name||' Share Of '||to_char((v_leg->>'amount')::numeric,'FM999G999G999G999G999')||
           ' Diamonds Was Credited To Your Diamond Wallet On Hand #'||NEW.hand_number::text||'.',
         '/hub/club-arena/table/'||NEW.table_id::text,
         jsonb_build_object('asset','diamonds','kind',v_kind,'payout_id',v_id,
           'table_id',NEW.table_id,'hand_number',NEW.hand_number,'share',(v_leg->>'amount')::bigint));
     END IF;
   END LOOP;
 END IF;
 INSERT INTO public.poker_diamond_jackpot_hits(id,arena_id,table_id,hand_number,hand_id,kind,paid,verdict,receipt)
 VALUES(v_id,v_arena,NEW.table_id,NEW.hand_number,NEW.hand_id,v_kind,v_paid_flag,v_verdict,v_receipt);
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_accept_hand() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER poker_diamond_jackpot_accept_hand AFTER UPDATE OF post_commit_payload
 ON public.hand_atomic_commits FOR EACH ROW EXECUTE FUNCTION public.fn_poker_diamond_jackpot_accept_hand();

REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_pay_mini(uuid,bigint,numeric,integer,uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
-- This payer is reached only inside the protected accepted-hand trigger.

-- Public facts about the player-side Diamond pool, never a chip fallback.
CREATE FUNCTION public.fn_poker_diamond_jackpot_for_club(p_club_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE v_pool uuid; v_enabled boolean; v_main bigint; v_backup bigint; v_floor bigint;
 v_mini boolean; v_stakes jsonb; v_hits jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication Required' USING ERRCODE='42501'; END IF;
 SELECT j.id INTO v_pool FROM public.clubs c
  JOIN public.poker_diamond_jackpot_pools j ON j.arena_id=c.id AND j.status='active'
  WHERE c.id=p_club_id AND c.asset='diamonds' AND c.is_platform IS TRUE AND c.union_id IS NULL;
 IF NOT FOUND THEN RAISE EXCEPTION 'Diamond Jackpot Pool Absent' USING ERRCODE='22023'; END IF;
 v_enabled:=public.fn_ca_diamond_economic_on('bbj_enabled');
 v_mini:=public.fn_ca_diamond_economic_on('mini_bbj_enabled');
 v_floor:=public.fn_ca_diamond_economic('mini_bbj_reserve_floor')::bigint;
 v_main:=public.fn_poker_diamond_jackpot_bank(v_pool,'main');
 v_backup:=public.fn_poker_diamond_jackpot_bank(v_pool,'backup');
 SELECT jsonb_agg(jsonb_build_object(
   'big_blind',split_part(d.scope,':',2)::numeric,
   'drop',public.fn_ca_diamond_economic('bbj_drop_per_hand',d.scope),
   'min_pot',public.fn_ca_diamond_economic('bbj_min_pot',d.scope),
   'payout_percent',public.fn_poker_diamond_jackpot_share(
       public.fn_ca_diamond_economic_text('bbj_hit_shares',d.scope),1,'paid'),
   'loser_percent',public.fn_poker_diamond_jackpot_share(public.fn_ca_diamond_economic_text('bbj_hit_shares',d.scope),1,'loser'),
   'winner_percent',public.fn_poker_diamond_jackpot_share(public.fn_ca_diamond_economic_text('bbj_hit_shares',d.scope),1,'winner'),
   'table_percent',public.fn_poker_diamond_jackpot_share(public.fn_ca_diamond_economic_text('bbj_hit_shares',d.scope),1,'table'),
   'mini_amount',public.fn_ca_diamond_economic('mini_bbj_amount',d.scope),
   'mini_payable',v_enabled AND v_mini
      AND public.fn_ca_diamond_economic('bbj_drop_per_hand',d.scope)>0
      AND v_backup-public.fn_ca_diamond_economic('mini_bbj_amount',d.scope)>=v_floor)
   ORDER BY split_part(d.scope,':',2)::numeric) INTO v_stakes
 FROM (SELECT DISTINCT scope FROM public.ca_diamond_economics
       WHERE name='bbj_drop_per_hand' AND scope LIKE 'bb:%') d;
 SELECT COALESCE(jsonb_agg(x ORDER BY x.created_at DESC),'[]'::jsonb) INTO v_hits
 FROM (SELECT j.id,j.table_id,j.hand_number,j.hand_id,j.kind,j.created_at,
        j.receipt AS receipt,j.verdict AS verdict,
        COALESCE(l.username,'Player') AS loser_name,COALESCE(w.username,'Player') AS winner_name,
        l.arena_avatar_url AS loser_avatar_url,l.player_number::text AS loser_player_number
       FROM public.poker_diamond_jackpot_hits j
       LEFT JOIN public.profiles l ON l.id=(j.verdict->>'loser_user_id')::uuid
       LEFT JOIN public.profiles w ON w.id=(j.verdict->>'winner_user_id')::uuid
       WHERE j.arena_id=p_club_id AND j.paid
         AND j.id IN (SELECT ranked.id FROM (SELECT q.id, row_number() OVER
           (PARTITION BY q.kind ORDER BY q.created_at DESC,q.id DESC) AS position
           FROM public.poker_diamond_jackpot_hits q WHERE q.arena_id=p_club_id AND q.paid) ranked
           WHERE ranked.position<=5) ORDER BY j.created_at DESC) x;
 RETURN jsonb_build_object('version',1,'pool_id',v_pool,'enabled',v_enabled,
   'main_balance',v_main,'mini_enabled',v_mini,'backup_balance',v_backup,'reserve_floor',v_floor,
   'stakes',COALESCE(v_stakes,'[]'::jsonb),'hits',v_hits);
END $fn$;
REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_for_club(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_jackpot_for_club(uuid) TO authenticated,service_role;

DO $events$
BEGIN
 IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
   ALTER PUBLICATION supabase_realtime ADD TABLE public.poker_diamond_jackpot_hits;
 END IF;
END $events$;

DO $float_preimage$
BEGIN
 IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_ca_arena_diamonds()'::regprocedure)) IS DISTINCT FROM '4ab3270d2613cb5407aca2ab173a7fb1' THEN
 RAISE EXCEPTION 'Diamond arena float preimage changed'; END IF;
END $float_preimage$;
CREATE OR REPLACE FUNCTION public.fn_ca_arena_diamonds()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT (SELECT COALESCE(sum(balance),0)::numeric FROM public.poker_diamond_custody)
   +(SELECT COALESCE(sum(pending_diamonds),0)::numeric FROM public.diamond_spin_days WHERE status='open')
   +(SELECT COALESCE(sum(amount),0)::numeric FROM public.ca_diamond_rake_accrual WHERE swept_at IS NULL)
   +public.fn_poker_diamond_jackpot_diamonds();
$function$;
REVOKE ALL ON FUNCTION public.fn_ca_arena_diamonds() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_ca_arena_diamonds() TO service_role;


-- The existing main-pool feed also serves the Diamond arena. This preserves
-- cached clients and every chip caller while never reading a chip bank for it.
DO $feed_preimage$
BEGIN
 IF md5((SELECT prosrc FROM pg_proc WHERE oid='public.fn_bbj_pool_for_club(uuid)'::regprocedure))
    IS DISTINCT FROM 'd6c793b7024df9d031cb93c9879ead75' THEN
   RAISE EXCEPTION 'Main jackpot feed preimage changed';
 END IF;
END $feed_preimage$;
CREATE OR REPLACE FUNCTION public.fn_bbj_pool_for_club(p_club_id uuid)
RETURNS TABLE(pool_id uuid,main_balance numeric,backup_balance numeric,promo_balance numeric,
 is_union_pool boolean,union_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
 WITH club AS (
  SELECT c.id,c.union_id,c.asset,c.is_platform FROM public.clubs c WHERE c.id=p_club_id
 ), pools AS (
  SELECT bp.id AS pool_id,bp.main_balance,bp.backup_balance,bp.promo_balance,
    bp.union_id IS NOT NULL AS is_union_pool,bp.union_id
  FROM public.bbj_pools bp,club
  WHERE bp.status='active' AND club.asset IS DISTINCT FROM 'diamonds'
    AND ((club.union_id IS NOT NULL AND bp.union_id=club.union_id)
      OR (club.union_id IS NULL AND bp.club_id=club.id))
  UNION ALL
  SELECT j.id,public.fn_poker_diamond_jackpot_bank(j.id,'main')::numeric,
    public.fn_poker_diamond_jackpot_bank(j.id,'backup')::numeric,
    public.fn_poker_diamond_jackpot_bank(j.id,'promotional')::numeric,false,NULL::uuid
  FROM public.poker_diamond_jackpot_pools j,club
  WHERE club.asset='diamonds' AND club.is_platform IS TRUE AND club.union_id IS NULL
    AND j.arena_id=club.id AND j.status='active'
    AND public.fn_ca_diamond_economic_on('bbj_enabled')
 )
 SELECT p.pool_id,p.main_balance,p.backup_balance,p.promo_balance,p.is_union_pool,p.union_id
 FROM pools p ORDER BY p.is_union_pool DESC LIMIT 1;
$fn$;
REVOKE ALL ON FUNCTION public.fn_bbj_pool_for_club(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_bbj_pool_for_club(uuid) TO authenticated,service_role;


-- Jackpot hands retain their actual rundown, under the existing awarded-hand exception.
DO $guard$
DECLARE v_source text;
BEGIN
 IF md5(pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure))<>'379f83a598ff822ce30f25647bcf9bd1' THEN
   RAISE EXCEPTION 'diamond_jackpot_retention_source_changed';
 END IF;
 v_source:=pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure);
 v_source:=replace(v_source,'         AND hh.reported IS NOT true',
 E'         AND NOT EXISTS (SELECT 1 FROM public.poker_diamond_jackpot_hits dj\n           WHERE dj.table_id=hh.table_id AND dj.hand_number=hh.hand_number AND dj.paid)\n         AND hh.reported IS NOT true');
 IF v_source=pg_get_functiondef('public.sp_prune_hand_history(integer)'::regprocedure) THEN
   RAISE EXCEPTION 'diamond_jackpot_retention_anchor_missing';
 END IF;
 IF position(E'SELECT greatest(coalesce(horse_retention_days,8),1)\n    INTO v_days FROM public.hand_history_retention_policy LIMIT 1;' IN v_source)=0 THEN
   RAISE EXCEPTION 'diamond_jackpot_configured_retention_window_changed';
 END IF;
 EXECUTE v_source;
END $guard$;

CREATE OR REPLACE FUNCTION public.fn_poker_diamond_jackpot_hand_detail(p_payout_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH pay AS (
    SELECT j.id,j.table_id,j.hand_number,j.hand_id,j.kind,j.created_at,
      (j.receipt->>'total')::numeric AS total_amount,
      (j.verdict->>'loser_user_id')::uuid AS winner_user_id,
      (j.verdict->>'winner_user_id')::uuid AS loser_user_id,
      (j.verdict->>'dealt')::integer AS table_player_count,
      j.verdict,j.receipt
    FROM public.poker_diamond_jackpot_hits j
    WHERE j.id=p_payout_id AND j.paid AND auth.uid() IS NOT NULL),
  hh AS (
    SELECT h.* FROM public.hand_history h
    JOIN pay ON h.table_id = pay.table_id AND h.hand_number = pay.hand_number
    ORDER BY h.created_at DESC LIMIT 1
  ),
  win AS (
    SELECT COALESCE(l.username,'Player') AS winner_display_name,
      COALESCE(w.username,'Player') AS loser_display_name,
      p.verdict->>'loser_hand' AS winner_hand,p.verdict->>'winner_hand' AS loser_hand,
      (p.receipt#>>'{payment,main_before}')::numeric AS pool_amount_at_hit
    FROM pay p LEFT JOIN public.profiles l ON l.id=p.winner_user_id
      LEFT JOIN public.profiles w ON w.id=p.loser_user_id),
  seats AS (
    SELECT e.value AS p FROM hh, LATERAL jsonb_array_elements(COALESCE(hh.players, '[]'::jsonb)) e
  ),
  players_out AS (
    SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'userId',       s.p->>'userId',
          'username',     COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), pr.username, s.p->>'username', 'Player'),
          'playerNumber', pr.player_number::text,
          -- The CLUB avatar. profiles.avatar_url is the social media photo and
          -- is not Club Arena's to display.
          'avatarUrl',    NULLIF(pr.arena_avatar_url, ''),
          'seat',         NULLIF(s.p->>'seat', '')::int,
          'stack',        NULLIF(s.p->>'stack', '')::numeric,
          'cards', CASE WHEN EXISTS (SELECT 1 FROM hh,
             LATERAL jsonb_array_elements(COALESCE(hh.showdown,'[]'::jsonb)) shown
             WHERE shown->>'user_id'=s.p->>'userId' AND shown->'mucked'='false'::jsonb)
             THEN COALESCE((SELECT hh.hole_cards -> (s.p->>'userId') FROM hh),'null'::jsonb)
             ELSE 'null'::jsonb END
        ) ORDER BY NULLIF(s.p->>'seat', '')::int), '[]'::jsonb) AS v
    FROM seats s LEFT JOIN public.profiles pr ON pr.id::text = s.p->>'userId'
  ),
  board_out AS (
    SELECT CASE
      WHEN (SELECT community_cards FROM hh) IS NULL THEN '[]'::jsonb
      ELSE COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'rank', regexp_replace(c, '(hearts|diamonds|clubs|spades)$', ''),
                 'suit', substring(c from '(hearts|diamonds|clubs|spades)$')) ORDER BY ord)
        FROM unnest((SELECT community_cards FROM hh)) WITH ORDINALITY AS t(c, ord)
        WHERE substring(c from '(hearts|diamonds|clubs|spades)$') IS NOT NULL
      ), '[]'::jsonb)
    END AS v
  ),
  extra_boards AS (
    SELECT COALESCE(jsonb_agg(b ORDER BY ord), '[]'::jsonb) AS v
    FROM (
      SELECT e.value AS b, e.ordinality AS ord
      FROM hh, LATERAL jsonb_array_elements(COALESCE(hh.rit_boards, '[]'::jsonb))
                       WITH ORDINALITY e(value, ordinality)
      UNION ALL
      SELECT to_jsonb(hh.community_cards2), 1000
      FROM hh WHERE hh.community_cards2 IS NOT NULL
                AND array_length(hh.community_cards2, 1) > 0
    ) t
  ),
  recips AS (
    SELECT COALESCE(jsonb_agg(
             jsonb_build_object(
               'userId', r.user_id,
               'name',   COALESCE(public.fn_arena_name(pr.alias, pr.username, pr.display_name, pr.first_name, pr.last_name, pr.full_name), pr.username, 'Player'),
               -- The summary card has no seat roster to look a number up in,
               -- so it travels with the recipient.
               'playerNumber', pr.player_number::text,
               'amount', r.amount,
               'role',   CASE
                           WHEN r.user_id = (SELECT winner_user_id FROM pay) THEN 'bad_beat'
                           WHEN r.user_id = (SELECT loser_user_id  FROM pay) THEN 'hand_winner'
                           ELSE 'table'
                         END) ORDER BY r.amount DESC), '[]'::jsonb) AS v
    FROM (SELECT l.recipient_user_id AS user_id,(-l.amount)::numeric AS amount
      FROM public.poker_diamond_jackpot_ledger l JOIN pay p ON p.table_id=l.table_id
        AND p.hand_number=l.hand_number
      WHERE l.kind='payout' AND l.wallet_journal_id IS NOT NULL) r
    LEFT JOIN public.profiles pr ON pr.id = r.user_id

  ),
  jackpot AS (
    SELECT jsonb_build_object(
             'payoutId',         p_payout_id,
             -- 2026-09-11: which jackpot this was. A mini hand opened looking
             -- exactly like a main one; the row always knew.
             'kind',             COALESCE((SELECT kind FROM pay), 'main'),
             'total',            (SELECT total_amount FROM pay),
             'badBeatUserId',    (SELECT winner_user_id FROM pay),
             'handWinnerUserId', (SELECT loser_user_id FROM pay),
             'recipients',       (SELECT v FROM recips)) AS v
  )
  SELECT CASE
    -- No such payout. A genuine nothing, and still a NULL.
    WHEN (SELECT count(*) FROM pay) = 0 THEN NULL

    -- THE HAND IS GONE. Everything the payout ledger knows, and an honest flag
    -- saying the street-by-street part is not coming.
    WHEN (SELECT count(*) FROM hh) = 0 THEN jsonb_build_object(
      'handAvailable', false,
      'kind',          COALESCE((SELECT kind FROM pay), 'main'),
      'handNumber',    (SELECT hand_number FROM pay),
      'playedAt',      (SELECT created_at FROM pay),
      'gameVariant',   NULL,
      'tablePlayerCount', (SELECT table_player_count FROM pay),
      -- bbj_winners names the two hands. Note the deliberate inversion the
      -- rest of this feature lives with: in bbj_winners, "winner" is the
      -- winner OF THE JACKPOT (the bad-beat holder, who LOST the hand).
      'badBeatName',   (SELECT COALESCE(NULLIF(winner_display_name,''), 'Player') FROM win),
      'badBeatHand',   (SELECT NULLIF(winner_hand, 'Unknown') FROM win),
      'handWinnerName',(SELECT COALESCE(NULLIF(loser_display_name,''), 'Player') FROM win),
      'handWinnerHand',(SELECT NULLIF(loser_hand, 'Unknown') FROM win),
      'poolAtHit',     (SELECT pool_amount_at_hit FROM win),
      'jackpot',       (SELECT v FROM jackpot)
    )

    ELSE jsonb_build_object(
      'handAvailable', true,
      'kind',        COALESCE((SELECT kind FROM pay), 'main'),
      'handNumber',  (SELECT hand_number FROM hh),
      'playedAt',    COALESCE((SELECT started_at FROM hh), (SELECT created_at FROM hh)),
      'gameVariant', (SELECT game_variant FROM hh),
      'smallBlind',  (SELECT small_blind FROM hh),
      'bigBlind',    (SELECT big_blind FROM hh),
      'potSize',     (SELECT pot_size FROM hh),
      'rakeAmount',  (SELECT rake_amount FROM hh),
      'bbjAmount',   (SELECT bbj_amount FROM hh),
      'buttonSeat',  (SELECT button_seat FROM hh),
      'board',       (SELECT v FROM board_out),
      'extraBoards', (SELECT v FROM extra_boards),
      'players',     (SELECT v FROM players_out),
      'actions',     COALESCE((SELECT jsonb_agg(a ORDER BY ord)
                        FROM jsonb_array_elements((SELECT COALESCE(actions, '[]'::jsonb) FROM hh))
                             WITH ORDINALITY AS t(a, ord)
                        WHERE COALESCE(a->>'userId', '') <> 'system'), '[]'::jsonb),
      'winners',     (SELECT COALESCE(winners, '[]'::jsonb) FROM hh),
      'showdown',    (SELECT COALESCE(jsonb_agg(jsonb_build_object(
         'user_id',shown->>'user_id','seat',shown->'seat','mucked',shown->'mucked',
         'reveal_order',shown->'reveal_order','hand_name',CASE WHEN shown->'mucked'='false'::jsonb
            THEN shown->>'hand_name' ELSE NULL END)), '[]'::jsonb)
         FROM hh,LATERAL jsonb_array_elements(COALESCE(hh.showdown,'[]'::jsonb)) shown),
      'pots',        (SELECT COALESCE(pots, '[]'::jsonb) FROM hh),
      'jackpot',     (SELECT v FROM jackpot)
    )
  END;
$function$;

REVOKE ALL ON FUNCTION public.fn_poker_diamond_jackpot_hand_detail(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.fn_poker_diamond_jackpot_hand_detail(uuid) TO authenticated,service_role;

-- Move the existing watched settlement baseline in this same transaction.
SELECT public.fn_ca_declare_guard_redefinition(
  'fn_poker_diamond_settle_cash_hand',
  'migration 20261012191143_diamond_cash_jackpots_settle_with_the_accepted_hand'
);

COMMIT;
