-- Reserved by scripts/new-migration.mjs. A short all-in call is not a raise.
-- Repair both maintained action readers without replacing their financial math,
-- authorization, range/keyset access paths or amount/dead-money reconstruction.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='8s';
DO $patch$
DECLARE r record; d text; original text; changed integer:=0;
BEGIN
 FOR r IN SELECT p.oid FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
 AND p.proname IN ('ca_hand_player_facts_one','ca_hand_player_facts_range') LOOP
  d:=pg_get_functiondef(r.oid); original:=d;
  IF position('raises_bet_level' in d)>0 THEN RAISE EXCEPTION 'Bet-level patch already installed'; END IF;
  IF position('acts AS MATERIALIZED (' in d)=0 OR position('players_all AS (' in d)=0
  THEN RAISE EXCEPTION 'Action reader source anchors changed'; END IF;
  d:=replace(d,chr(10)||'acts AS MATERIALIZED (',chr(10)||'raw_acts AS MATERIALIZED (');
  d:=replace(d,'players_all AS (',$sql$acts AS MATERIALIZED (
  SELECT a.*,a.action IN ('bet','raise','all_in','allin') AND NOT a.dead_flag AND a.amount>
   greatest(CASE WHEN a.stage='preflop' THEN coalesce(mh.big_blind,0) ELSE 0 END,
    coalesce(max(CASE WHEN NOT a.dead_flag AND a.action IN
     ('bet','raise','all_in','allin','sb','bb','post','post_sb','post_bb','blind','small_blind','big_blind','straddle','kill_blind')
     THEN a.amount END) OVER(PARTITION BY a.hand_id,a.stage ORDER BY a.ord
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)) raises_bet_level
  FROM raw_acts a JOIN my_hands mh ON mh.id=a.hand_id
),
players_all AS ($sql$);
  -- Only tendency predicates change. Action names, amounts and original
  -- investment/refund reconstruction remain byte-for-byte intact.
  d:=replace(d,$text$stage = 'preflop' AND action IN ('raise','all_in','allin')$text$,
   $text$stage = 'preflop' AND raises_bet_level$text$);
  d:=replace(d,$text$a.stage = 'preflop' AND a.action IN ('raise','all_in','allin')$text$,
   $text$a.stage = 'preflop' AND a.raises_bet_level$text$);
  d:=replace(d,$text$count(*) FILTER (WHERE a.action IN ('bet','raise','all_in','allin'))::int AS aggro_cnt$text$,
   $text$count(*) FILTER (WHERE a.raises_bet_level)::int AS aggro_cnt$text$);
  d:=replace(d,$text$count(*) FILTER (WHERE a.action = 'call')::int AS call_cnt$text$,
   $text$count(*) FILTER (WHERE a.action = 'call' OR (a.action IN ('all_in','allin') AND NOT a.raises_bet_level))::int AS call_cnt$text$);
  IF d=original OR position('a.raises_bet_level)::int AS aggro_cnt' in d)=0
  THEN RAISE EXCEPTION 'Action tendency predicate anchors changed'; END IF;
  EXECUTE d; changed:=changed+1;
 END LOOP;
 IF changed<>2 THEN RAISE EXCEPTION 'Expected both action readers, found %',changed; END IF;
END $patch$;

-- Two independently inspected Burls hands contain calls below an earlier
-- shove. The exact settled facts already say PFR=false; only the recent
-- action cache says true. Correct those named booleans, never any money field.
UPDATE public.ca_hand_player_stat s SET pfr=false
WHERE s.user_id='7e616640-58dd-4d8d-a18e-2f37f057bcd9'
 AND s.hand_id IN ('4aae2afb-0385-4241-a03f-76bb2ae21915','6da7a410-a466-4355-8e14-3feee5ca74eb')
 AND s.pfr AND EXISTS(SELECT 1 FROM public.ca_hand_facts f
  WHERE f.user_id=s.user_id AND f.hand_id=s.hand_id AND NOT f.pfr);
COMMIT;
