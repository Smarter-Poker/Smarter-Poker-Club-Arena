-- 20261024225914_horse_commitment_review_grades_against_the_solver_charts.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- For 2026-10-23 every row in public.horse_commitment_reviews (one hour: NLH
-- 9,928, PLO4 2,110, PLO5 427, PLO6 395) read gto_verdict 'unverified' with
-- reasons {decision_replay_not_matched,reference_not_matched}. Nothing was
-- failing to match. The daily step never tried: 20260914161209 wrote
--   reasons:=ARRAY['decision_replay_not_matched','reference_not_matched'];
-- as a constant for every horse row, and the column carried
--   CHECK (gto_verdict='unverified')
-- so no other value could ever be stored. 20260917051350, 20261007075304
-- and 20261008041707 copied that line forward unchanged (20261008041707
-- line 524). The reasons named a replay and a reference match that no code
-- anywhere performs.
--
-- An exact replay of a horse decision cannot be rebuilt from stored data:
-- the live decision draws on the worker's fastRandom stream, the in-memory
-- opponent memory (HorseMind, maniac reads), the per-horse gtoAdherence roll
-- and the continuation layers' process state, none of which reach the
-- database (Phase 15's exact replay needs the private journal and the exact
-- runtime, docs/horse-brain-phase15-closure-2026-10-08.md). So this does not
-- pretend to replay. It grades what the stored data can honestly grade:
--
--   the horse's OWN accepted decision (hand_history.actions, origin
--   'horse_policy', with the public action node captured before the action
--   was applied) against the stored solver reference (memory_charts_gold,
--   the 240 PioSolver push/fold charts the live brain consults through
--   GtoCharts.ts), with the horse's hole cards from the digest-verified
--   accepted payload (accepted_hand_facts.stats_facts).
--
-- The reference answers two spots, exactly as GtoCharts.ts scopes it:
--   open_jam   no-limit hold'em preflop, folded to the horse (no raise, no
--              limp, nobody all in), not the big blind, depth <= 15 BB;
--   bb_defend  the big blind facing a small-blind all-in heads-up, effective
--              depth <= 25 BB.
-- A decision there is graded against the chart's mix for its hand class:
-- the chosen action's chart frequency <= 0.10 is 'reference_deviation' (the
-- same "pure miss" HorseSolverAgreement uses); otherwise it agrees. A row is
-- 'reference_agreed' only when EVERY chip-committing horse decision in the
-- hand was graded and agreed; one deviation makes it 'reference_deviation'.
-- Everything else stays 'unverified' and says exactly why, one reason per
-- ungraded decision: reference_domain_variant:<v>, reference_domain_street:<s>,
-- reference_domain_depth:<spot>, reference_domain_spot:<shape>,
-- reference_domain_structure:<s>, reference_domain_straddle,
-- reference_domain_bomb_pot, reference_chart_unavailable:<key>,
-- decision_public_node_unavailable, decision_origin_unavailable,
-- decision_fallback_not_graded, decision_hole_cards_unavailable,
-- decision_action_outside_reference_menu:<a>, decision_not_found,
-- reference_agreed_partial. A row whose commitment is unknown is named
-- reference_not_graded_commitment_unknown.
--
--   1. fn_horse_commitment_reference_hand_class, _position and _grade: the
--      grader. Private (no API role may execute them). _position is
--      HorseLogic.classifyPosition over the dealt seats.
--   2. horse_commitment_reviews.gto_verdict admits 'reference_agreed' and
--      'reference_deviation' (eligible rows only), added NOT VALID: every
--      existing row is 'unverified', which the new rule admits, and the
--      private table is not scanned under its lock.
--   3. fn_horse_commitment_audit_step, preimage-guarded on the live body md5
--      0f09e8b00b60a88a81452163fe76d097 (20261008041707's postimage), header
--      and ACL: it reads hand_history.actions, grades each eligible row and
--      writes the verdict. Every guard, cursor, counter, receipt, prune, the
--      batch size 256, lock_timeout 2s, statement_timeout 5s and the return
--      contract (whose batch-level gtoVerdict stays 'unverified': a batch
--      receipt is never a verdict) are unchanged.
--
-- WHAT THIS IS NOT. Not a backfill, sweep or repair job (CLAUDE.md 10.11,
-- 10.12): rows already written keep their first-write content, as every
-- earlier body promised; hands first reviewed after installation are graded.
-- Not policy or activation authority: a verdict is a diagnostic about one
-- recorded decision against one finite chart menu. Horses are players
-- (10.5): the roster classification is read only as identification.
--
-- No hot table is locked: ACCESS EXCLUSIVE is taken only on the private
-- horse_commitment_reviews table (written only by this step) with a 2s
-- lock_timeout. No foreign key. One transaction.
--
-- @live-proof: (SELECT md5(prosrc)='47003cf6071665e5f3dd4c176f1b8fa0' AND prosecdef AND proowner='postgres'::regrole AND proacl::text='{postgres=X/postgres,service_role=X/postgres}' FROM pg_proc WHERE oid='public.fn_horse_commitment_audit_step()'::regprocedure)
-- @live-proof: (SELECT pg_get_constraintdef(oid)='CHECK (((gto_verdict = ANY (ARRAY[''unverified''::text, ''reference_agreed''::text, ''reference_deviation''::text])) AND ((gto_verdict = ''unverified''::text) OR (eligibility = ''over_10bb''::text)))) NOT VALID' FROM pg_constraint WHERE conrelid='public.horse_commitment_reviews'::regclass AND conname='horse_commitment_reviews_gto_verdict_check')
-- @live-proof: NOT EXISTS(SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r WHERE has_function_privilege(r,'public.fn_horse_commitment_reference_grade(jsonb,uuid,jsonb)','EXECUTE'))

BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';

DO $preimage$
DECLARE existing record; role_name text; missing text;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'horse_commitment_reference_grade_owner_required';
  END IF;
  IF to_regprocedure('public.fn_horse_commitment_reference_grade(jsonb,uuid,jsonb)') IS NOT NULL
     OR to_regprocedure('public.fn_horse_commitment_reference_position(integer,integer,integer[])') IS NOT NULL
     OR to_regprocedure('public.fn_horse_commitment_reference_hand_class(jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION 'horse_commitment_reference_grade_already_installed';
  END IF;
  SELECT p.*, pg_get_userbyid(p.proowner) AS owner_name, l.lanname INTO existing
  FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
  WHERE p.oid = to_regprocedure('public.fn_horse_commitment_audit_step()');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'horse_commitment_reference_grade_preimage_missing';
  END IF;
  IF md5(existing.prosrc) <> '0f09e8b00b60a88a81452163fe76d097'
     OR existing.owner_name <> 'postgres'
     OR existing.prosecdef IS DISTINCT FROM true
     OR existing.lanname <> 'plpgsql'
     OR existing.prorettype <> 'jsonb'::regtype
     OR existing.proretset IS DISTINCT FROM false
     OR existing.prokind <> 'f'
     OR existing.provolatile <> 'v'
     OR existing.proisstrict IS DISTINCT FROM false
     OR existing.proleakproof IS DISTINCT FROM false
     OR existing.proparallel <> 'u'
     OR existing.procost <> 100
     OR existing.prorows <> 0
     OR existing.prosupport <> 0
     OR existing.proconfig IS DISTINCT FROM ARRAY[
       'search_path=pg_catalog, public, pg_temp', 'lock_timeout=2s', 'statement_timeout=5s'
     ]::text[]
     OR ARRAY(SELECT item::text FROM unnest(existing.proacl) item ORDER BY item::text)
       IS DISTINCT FROM ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]
  THEN
    RAISE EXCEPTION 'horse_commitment_reference_grade_preimage_changed';
  END IF;
  -- The verdict column still admits only the placeholder, exactly.
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.horse_commitment_reviews'::regclass
        AND contype='c' AND conname='horse_commitment_reviews_gto_verdict_check'
        AND pg_get_constraintdef(oid)='CHECK ((gto_verdict = ''unverified''::text))')<>1 THEN
    RAISE EXCEPTION 'horse_commitment_reference_grade_verdict_constraint_changed';
  END IF;
  -- The review table stays private.
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='public.horse_commitment_reviews'::regclass
      AND relrowsecurity AND relkind='r' AND pg_get_userbyid(relowner)='postgres') THEN
    RAISE EXCEPTION 'horse_commitment_reference_grade_private_schema_required';
  END IF;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF has_table_privilege(role_name,'public.horse_commitment_reviews','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      OR has_any_column_privilege(role_name,'public.horse_commitment_reviews','SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'horse_commitment_reference_grade_private_acl_changed';
    END IF;
  END LOOP;
  -- Every source column the grader and the new step read.
  SELECT string_agg(want.rel||'.'||want.col, ',') INTO missing
  FROM (VALUES ('public.hand_history','actions','jsonb'),
    ('public.memory_charts_gold','game_type',NULL),('public.memory_charts_gold','stack_depth',NULL),
    ('public.memory_charts_gold','hero_position',NULL),('public.memory_charts_gold','villain_action',NULL),
    ('public.memory_charts_gold','hand_matrix','jsonb')) want(rel,col,typ)
  WHERE to_regclass(want.rel) IS NULL OR NOT EXISTS (
    SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(want.rel)
      AND a.attname=want.col AND NOT a.attisdropped AND a.attnum>0
      AND (want.typ IS NULL OR format_type(a.atttypid,NULL)=want.typ));
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'horse_commitment_reference_grade_source_columns_changed: %', missing;
  END IF;
  -- The step runs as postgres: it must see every chart row.
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid='public.memory_charts_gold'::regclass
      AND (pg_get_userbyid(c.relowner)='postgres' OR NOT c.relrowsecurity
        OR (SELECT rolbypassrls FROM pg_roles WHERE rolname='postgres'))) THEN
    RAISE EXCEPTION 'horse_commitment_reference_grade_chart_rows_hidden';
  END IF;
END;
$preimage$;

-- ===========================================================================
-- 1. THE GRADER. Private, read-only helpers called by the step.
-- ===========================================================================
-- Two hole cards -> the 169-class label the charts key on (GtoCharts.handClass).
CREATE FUNCTION public.fn_horse_commitment_reference_hand_class(p_hole jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $hand$
DECLARE ranks CONSTANT text:='23456789TJQKA'; r1 integer; r2 integer; s1 text; s2 text;
BEGIN
  IF jsonb_typeof(p_hole) IS DISTINCT FROM 'array' OR jsonb_array_length(p_hole)<>2
     OR jsonb_typeof(p_hole->0) IS DISTINCT FROM 'object' OR jsonb_typeof(p_hole->1) IS DISTINCT FROM 'object' THEN
    RETURN NULL;
  END IF;
  IF length(coalesce(p_hole->0->>'rank',''))<>1 OR length(coalesce(p_hole->1->>'rank',''))<>1 THEN
    RETURN NULL;
  END IF;
  r1:=strpos(ranks,p_hole->0->>'rank'); r2:=strpos(ranks,p_hole->1->>'rank');
  s1:=p_hole->0->>'suit'; s2:=p_hole->1->>'suit';
  IF r1=0 OR r2=0 OR s1 IS NULL OR s2 IS NULL
     OR s1 NOT IN ('hearts','diamonds','clubs','spades') OR s2 NOT IN ('hearts','diamonds','clubs','spades')
     OR (r1=r2 AND s1=s2) THEN
    RETURN NULL;
  END IF;
  IF r1=r2 THEN RETURN substr(ranks,r1,1)||substr(ranks,r2,1); END IF;
  RETURN substr(ranks,greatest(r1,r2),1)||substr(ranks,least(r1,r2),1)||CASE WHEN s1=s2 THEN 's' ELSE 'o' END;
END;
$hand$;

-- HorseLogic.classifyPosition over the dealt seats: 'sb', 'bb', 'early',
-- 'middle' or 'late'. Heads-up the dealer is the small blind.
CREATE FUNCTION public.fn_horse_commitment_reference_position(p_hero integer,p_dealer integer,p_dealt integer[])
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $pos$
DECLARE in_hand integer[]; ord integer[]:=ARRAY[]::integer[]; cur integer; nxt integer;
  n integer; idx integer; non_blind integer; p integer; early_count integer;
BEGIN
  in_hand:=ARRAY(SELECT DISTINCT s FROM unnest(coalesce(p_dealt,ARRAY[]::integer[])) s WHERE s IS NOT NULL ORDER BY s);
  IF p_dealer IS NULL OR cardinality(in_hand)<2 THEN RETURN 'middle'; END IF;
  cur:=p_dealer;
  FOR i IN 1..cardinality(in_hand) LOOP
    nxt:=coalesce((SELECT min(s) FROM unnest(in_hand) s WHERE s>cur),in_hand[1]);
    EXIT WHEN cardinality(ord)>0 AND nxt=ord[1];
    ord:=ord||nxt; cur:=nxt;
  END LOOP;
  idx:=array_position(ord,p_hero); n:=cardinality(ord);
  IF idx IS NULL THEN RETURN 'middle'; END IF;
  idx:=idx-1;
  IF n=2 THEN RETURN CASE WHEN p_hero=p_dealer THEN 'sb' ELSE 'bb' END; END IF;
  IF idx=0 THEN RETURN 'sb'; END IF;
  IF idx=1 THEN RETURN 'bb'; END IF;
  non_blind:=n-2; p:=idx-2;
  IF p>=non_blind-2 THEN RETURN 'late'; END IF;
  early_count:=greatest(1,ceil((non_blind-2)/2.0)::integer);
  IF p<early_count THEN RETURN 'early'; END IF;
  RETURN 'middle';
END;
$pos$;

-- One horse's decisions in one accepted hand, graded against the stored
-- push/fold charts. Returns {verdict, reasons}; never raises on bad data.
CREATE FUNCTION public.fn_horse_commitment_reference_grade(p_actions jsonb,p_horse uuid,p_stats_facts jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public,pg_temp AS $grade$
DECLARE
  depths CONSTANT numeric[]:=ARRAY[2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,25];
  d record; prior record; node jsonb; o text; act text; hand text; hole jsonb; reason text;
  reasons text[]:=ARRAY[]::text[]; verdict text;
  decisions integer:=0; committing integer:=0; committing_agreed integer:=0; agreed integer:=0; deviated integer:=0;
  bb numeric; hero integer; dealer integer; dealt integer[]; pos text;
  raises integer; limpers integer; callers integer; last_raiser integer; allin_ahead boolean; is_aggr boolean;
  behind numeric; wager numeric; depth numeric; eff numeric; snapped numeric; to_call numeric; current_bet numeric;
  opps integer; tourney boolean; straddled boolean; facts_hits integer:=0;
  kind text; game text; villain text; chart_pos text; yes_key text; chosen text; chart_key text;
  matrix jsonb; cell jsonb; matches integer; yes_raw numeric; fold_raw numeric; yes numeric; fold numeric; freq numeric;
BEGIN
  IF jsonb_typeof(p_actions) IS DISTINCT FROM 'array' THEN
    RETURN jsonb_build_object('verdict','unverified','reasons',jsonb_build_array('decision_actions_unavailable'));
  END IF;
  BEGIN
    -- The horse's hole cards: exactly one accepted fact row for this seat.
    IF jsonb_typeof(p_stats_facts->'facts')='array' THEN
      SELECT count(*) INTO facts_hits FROM jsonb_array_elements(p_stats_facts->'facts') f
        WHERE jsonb_typeof(f)='object' AND f->>'user_id'=p_horse::text;
      IF facts_hits=1 THEN
        SELECT f->'hole_cards' INTO hole FROM jsonb_array_elements(p_stats_facts->'facts') f
          WHERE jsonb_typeof(f)='object' AND f->>'user_id'=p_horse::text;
      END IF;
    END IF;
    hand:=public.fn_horse_commitment_reference_hand_class(hole);
    straddled:=EXISTS(SELECT 1 FROM jsonb_array_elements(p_actions) e
      WHERE jsonb_typeof(e)='object' AND e->>'action' IN ('straddle','kill_blind'));
    FOR d IN
      SELECT e.value AS a, e.ordinality AS ord
      FROM jsonb_array_elements(p_actions) WITH ORDINALITY e
      WHERE jsonb_typeof(e.value)='object' AND e.value->>'userId'=p_horse::text
        AND e.value->>'action' IN ('fold','check','call','bet','raise','all_in')
        AND NOT (e.value ? 'historyEvent') AND e.value->>'origin' IS DISTINCT FROM 'forced'
      ORDER BY e.ordinality
    LOOP
      decisions:=decisions+1; act:=d.a->>'action'; reason:=NULL; kind:=NULL; chosen:=NULL; chart_pos:=NULL;
      IF act IN ('call','bet','raise','all_in') THEN committing:=committing+1; END IF;
      o:=d.a->>'origin'; node:=d.a->'publicNode';
      IF o IS NULL THEN reason:='decision_origin_unavailable';
      ELSIF o='horse_fallback' THEN reason:='decision_fallback_not_graded';
      ELSIF o<>'horse_policy' THEN reason:='decision_origin_not_horse_policy:'||left(o,32);
      ELSIF jsonb_typeof(node) IS DISTINCT FROM 'object' OR node->>'status' IS DISTINCT FROM 'captured' THEN
        reason:='decision_public_node_unavailable';
      ELSIF node->>'variant' IS DISTINCT FROM 'nlh' THEN
        reason:='reference_domain_variant:'||left(coalesce(node->>'variant','unknown'),32);
      ELSIF node->>'street' IS DISTINCT FROM 'preflop' THEN
        reason:='reference_domain_street:'||left(coalesce(node->>'street','unknown'),16);
      ELSIF node->>'structure' IS DISTINCT FROM 'no_limit' THEN
        reason:='reference_domain_structure:'||left(coalesce(node->>'structure','unknown'),16);
      ELSIF node->'bombPot'='true'::jsonb THEN reason:='reference_domain_bomb_pot';
      ELSIF straddled THEN reason:='reference_domain_straddle';
      ELSIF hand IS NULL THEN reason:='decision_hole_cards_unavailable';
      ELSE
        bb:=(node->>'bigBlind')::numeric; hero:=(node->>'actorSeat')::integer; dealer:=(node->>'dealerSeat')::integer;
        to_call:=(node->>'toCall')::numeric; current_bet:=(node->>'currentBet')::numeric;
        tourney:=node->>'mode'='tournament' OR coalesce((node->>'ante')::numeric,0)>0;
        -- seats: [seat, behind, street wager, invested, dead, ante, flags]
        -- flags: folded=1, all-in=2, sitting-out=4. Dealt = not sitting out
        -- at the deal, or already in the pot.
        dealt:=ARRAY(SELECT (s->>0)::integer FROM jsonb_array_elements(node->'seats') s
          WHERE ((s->>6)::integer & 4)=0 OR (s->>3)::numeric>0 ORDER BY 1);
        SELECT (s->>1)::numeric,(s->>2)::numeric INTO behind,wager
          FROM jsonb_array_elements(node->'seats') s WHERE (s->>0)::integer=hero;
        SELECT count(*) INTO opps FROM jsonb_array_elements(node->'seats') s
          WHERE (s->>0)::integer<>hero AND ((s->>6)::integer & 1)=0
            AND (((s->>6)::integer & 4)=0 OR ((s->>6)::integer & 2)<>0);
        IF bb IS NULL OR bb<=0 OR behind IS NULL OR wager IS NULL OR to_call IS NULL OR current_bet IS NULL THEN
          RAISE EXCEPTION USING ERRCODE='22023';
        END IF;
        -- HorseLogic's preflop counters over the voluntary actions before it.
        raises:=0; limpers:=0; callers:=0; last_raiser:=NULL; allin_ahead:=false;
        FOR prior IN
          SELECT e.value AS a FROM jsonb_array_elements(p_actions) WITH ORDINALITY e
          WHERE e.ordinality<d.ord AND jsonb_typeof(e.value)='object' AND e.value->>'stage'='preflop'
            AND e.value->>'action' IN ('call','bet','raise','all_in')
            AND NOT (e.value ? 'historyEvent') AND e.value->>'origin' IS DISTINCT FROM 'forced'
          ORDER BY e.ordinality
        LOOP
          IF prior.a->>'action'='all_in' THEN allin_ahead:=true; END IF;
          is_aggr:=prior.a->>'action' IN ('raise','bet')
            OR (prior.a->>'action'='all_in' AND jsonb_typeof(prior.a->'isFullRaise')='boolean');
          IF is_aggr THEN raises:=raises+1; callers:=0; last_raiser:=(prior.a->>'seat')::integer;
          ELSIF raises=0 THEN limpers:=limpers+1;
          ELSE callers:=callers+1;
          END IF;
        END LOOP;
        pos:=public.fn_horse_commitment_reference_position(hero,dealer,dealt);
        depth:=(behind+wager)/bb;
        IF raises=0 AND limpers=0 AND callers=0 AND NOT allin_ahead AND pos<>'bb' AND to_call<=bb THEN
          IF depth>15 THEN reason:='reference_domain_depth:open_jam';
          ELSE
            kind:='open_jam'; villain:='fold_to_hero'; yes_key:='push'; eff:=depth;
            chart_pos:=CASE pos WHEN 'sb' THEN 'SB' WHEN 'early' THEN 'UTG' WHEN 'middle' THEN 'MP'
              WHEN 'late' THEN CASE WHEN hero=dealer THEN 'BTN' ELSE 'CO' END END;
            chosen:=CASE WHEN act='all_in'
                OR (act IN ('bet','raise') AND (d.a->>'amount')::numeric>=behind+wager-0.005) THEN 'push'
              WHEN act IN ('fold','check') THEN 'fold' END;
          END IF;
        ELSIF pos='bb' AND raises=1 AND opps=1 AND to_call>0 AND last_raiser IS NOT NULL
          AND public.fn_horse_commitment_reference_position(last_raiser,dealer,dealt)='sb'
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(p_actions) WITH ORDINALITY e
            WHERE e.ordinality<d.ord AND jsonb_typeof(e.value)='object' AND e.value->>'stage'='preflop'
              AND e.value->>'action'='all_in' AND (e.value->>'seat')::integer=last_raiser) THEN
          eff:=least(depth,current_bet/bb);
          IF eff>25 THEN reason:='reference_domain_depth:bb_defend';
          ELSE
            kind:='bb_defend'; villain:='sb_push'; yes_key:='call'; chart_pos:='BB';
            chosen:=CASE WHEN act IN ('call','all_in') THEN 'call' WHEN act='fold' THEN 'fold' END;
          END IF;
        ELSE
          reason:='reference_domain_spot:'||CASE WHEN raises>0 THEN 'facing_raise'
            WHEN limpers>0 OR callers>0 THEN 'limped_pot' WHEN allin_ahead THEN 'all_in_ahead'
            WHEN pos='bb' THEN 'big_blind_option' ELSE 'other' END;
        END IF;
        IF kind IS NOT NULL THEN
          IF chosen IS NULL THEN reason:='decision_action_outside_reference_menu:'||left(act,16);
          ELSIF chart_pos IS NULL THEN reason:='reference_domain_position:'||pos;
          ELSE
            -- Nearest charted depth; a tie takes the shallower (GtoCharts.snapDepth).
            SELECT x INTO snapped FROM unnest(depths) WITH ORDINALITY u(x,i) ORDER BY abs(eff-x),i LIMIT 1;
            game:=CASE WHEN tourney THEN 'Tournament' ELSE 'Cash' END;
            chart_key:=game||'|'||villain||'|'||chart_pos||'|'||snapped::text;
            SELECT count(*) INTO matches FROM public.memory_charts_gold c
              WHERE c.game_type=game AND c.villain_action=villain AND c.hero_position=chart_pos AND c.stack_depth=snapped;
            IF matches<>1 THEN reason:='reference_chart_unavailable:'||chart_key;
            ELSE
              SELECT c.hand_matrix INTO matrix FROM public.memory_charts_gold c
                WHERE c.game_type=game AND c.villain_action=villain AND c.hero_position=chart_pos AND c.stack_depth=snapped;
              -- An absent hand is a fold (the solver lists only non-fold branches).
              cell:=CASE WHEN jsonb_typeof(matrix)='object' AND jsonb_typeof(matrix->hand)='object' THEN matrix->hand END;
              yes_raw:=CASE WHEN jsonb_typeof(cell->yes_key)='number' THEN (cell->>yes_key)::numeric
                WHEN jsonb_typeof(cell->yes_key)='string' AND cell->>yes_key ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (cell->>yes_key)::numeric END;
              fold_raw:=CASE WHEN jsonb_typeof(cell->'fold')='number' THEN (cell->>'fold')::numeric
                WHEN jsonb_typeof(cell->'fold')='string' AND cell->>'fold' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (cell->>'fold')::numeric END;
              yes:=greatest(CASE WHEN yes_raw IS NOT NULL THEN yes_raw WHEN fold_raw IS NOT NULL THEN 1-fold_raw ELSE 0 END,0);
              fold:=greatest(CASE WHEN fold_raw IS NOT NULL THEN fold_raw WHEN yes_raw IS NOT NULL THEN 1-yes_raw ELSE 1 END,0);
              IF yes+fold>0 THEN yes:=yes/(yes+fold); fold:=1-yes; ELSE yes:=0; fold:=1; END IF;
              freq:=CASE WHEN chosen='fold' THEN fold ELSE yes END;
              reason:=kind||':'||chart_key||':'||hand||':'||chosen||':'||to_char(round(freq,3),'FM0.000');
              IF freq<=0.1 THEN
                deviated:=deviated+1; reason:='reference_deviation:'||reason;
              ELSE
                agreed:=agreed+1; reason:='reference_agreed:'||reason;
                IF act IN ('call','bet','raise','all_in') THEN committing_agreed:=committing_agreed+1; END IF;
              END IF;
            END IF;
          END IF;
        END IF;
      END IF;
      IF reason IS NOT NULL AND NOT reason=ANY(reasons) THEN reasons:=reasons||reason; END IF;
    END LOOP;
  EXCEPTION WHEN others THEN
    RETURN jsonb_build_object('verdict','unverified','reasons',
      jsonb_build_array('reference_grade_unreadable:'||SQLSTATE));
  END;
  IF deviated>0 THEN verdict:='reference_deviation';
  ELSIF committing>0 AND committing_agreed=committing THEN verdict:='reference_agreed';
  ELSE
    verdict:='unverified';
    IF decisions=0 THEN reasons:=reasons||'decision_not_found'::text;
    ELSIF committing=0 THEN reasons:=reasons||'decision_no_committing_action'::text;
    END IF;
    IF agreed>0 THEN reasons:=reasons||'reference_agreed_partial'::text; END IF;
  END IF;
  IF cardinality(reasons)>24 THEN reasons:=reasons[1:23]||'reference_reasons_truncated'::text; END IF;
  RETURN jsonb_build_object('verdict',verdict,'reasons',to_jsonb(reasons));
END;
$grade$;

ALTER FUNCTION public.fn_horse_commitment_reference_hand_class(jsonb) OWNER TO postgres;
ALTER FUNCTION public.fn_horse_commitment_reference_position(integer,integer,integer[]) OWNER TO postgres;
ALTER FUNCTION public.fn_horse_commitment_reference_grade(jsonb,uuid,jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fn_horse_commitment_reference_hand_class(jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_horse_commitment_reference_position(integer,integer,integer[]) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.fn_horse_commitment_reference_grade(jsonb,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- ===========================================================================
-- 2. THE VERDICT COLUMN. NOT VALID: every existing row is 'unverified'.
-- ===========================================================================
ALTER TABLE public.horse_commitment_reviews
  DROP CONSTRAINT horse_commitment_reviews_gto_verdict_check,
  ADD CONSTRAINT horse_commitment_reviews_gto_verdict_check CHECK (
    gto_verdict IN ('unverified','reference_agreed','reference_deviation')
    AND (gto_verdict='unverified' OR eligibility='over_10bb')) NOT VALID;
COMMENT ON COLUMN public.horse_commitment_reviews.gto_verdict IS
  'reference_agreed / reference_deviation: the horse''s recorded decisions graded against the stored push/fold solver charts (fn_horse_commitment_reference_grade, 20261024225914); unverified: outside that reference, with the reason named in reasons. A diagnostic, never policy authority.';
REVOKE ALL ON public.horse_commitment_reviews FROM PUBLIC,anon,authenticated,service_role;

-- ===========================================================================
-- 3. THE STEP. 20261008041707's body with the marked grading additions;
--    everything else is that body byte for byte.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.fn_horse_commitment_audit_step()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public,pg_temp
SET lock_timeout='2s' SET statement_timeout='5s'
AS $fn$
DECLARE
  d public.horse_commitment_audit_days%ROWTYPE;
  h record; actor record; facts jsonb; contributions jsonb; refunds jsonb;
  source_ok boolean; roster_ok boolean; valid_money boolean;
  gaps text[]; reasons text[]; variant text; game_format text;
  net numeric; refund numeric; gross numeric; bb numeric; seats integer;
  scanned integer:=0; horses integer:=0; flagged integer:=0; unknowns integer:=0; gap_hands integer:=0;
  last_created timestamptz; last_id uuid; old_hash text; old_format text;
  -- P14.3 selection receipt: per-batch selection counters, the previous
  -- pass receipt of this day, and the clock read after the scan snapshot.
  no_commit integer:=0; missing_source integer:=0; late integer:=0;
  prior public.horse_commitment_audit_passes%ROWTYPE; scan_cutover timestamptz;
  -- Accepted roster identity: the epoch, this hand's basis, its horse seats
  -- and the per-batch identity counters (they sum to the hands scanned).
  epoch timestamptz; hand_basis text; actors jsonb; horse_ids uuid[]; horse_id uuid; actors_ok boolean;
  used_profile boolean; used_roster boolean;
  roster_hands integer:=0; profile_hands integer:=0; roster_unavailable integer:=0; roster_missing integer:=0;
  -- Reference grade of one eligible horse row (20261024225914).
  grade jsonb; verdict text;
  today date:=(transaction_timestamp() AT TIME ZONE 'UTC')::date;
BEGIN
  -- Separate owner from settlement: no source row locks or financial writes.
  -- One nonblocking transaction owns the cursor and every derived row/counter.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('horse-commitment-audit-v1',0)) THEN
    RETURN jsonb_build_object('version',1,'status','busy','sourceCoverage','not_established','activationAuthorized',false);
  END IF;
  -- The first accepted roster ever captured. Hands created before it were
  -- accepted before the roster existed; no other hand reads the profile.
  SELECT e.first_captured_at INTO epoch FROM public.horse_commitment_roster_epoch e WHERE e.singleton;
  IF epoch IS NULL THEN
    RAISE EXCEPTION 'horse_commitment_roster_epoch_missing';
  END IF;
  INSERT INTO public.horse_commitment_audit_days(day,identity_basis)
    SELECT today-i,public.fn_horse_commitment_identity_basis(today-i,false,false)
    FROM generate_series(1,3) i ON CONFLICT DO NOTHING;
  SELECT * INTO d FROM public.horse_commitment_audit_days
    WHERE day BETWEEN today-3 AND today-1
      AND (finished_at IS NULL OR finished_at<transaction_timestamp()-interval '24 hours')
    ORDER BY (finished_at IS NOT NULL),day FOR UPDATE LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('version',1,'status','idle','sourceCoverage','not_established','activationAuthorized',false);
  END IF;
  IF d.finished_at IS NOT NULL THEN
    UPDATE public.horse_commitment_audit_days SET pass=pass+1,after_created_at=NULL,after_hand_id=NULL,
      started_at=transaction_timestamp(),finished_at=NULL,scanned_hands=0,horse_hands=0,
      flagged_horse_hands=0,unknown_horse_hands=0,hand_gaps=0,
      hands_without_commit=0,missing_source_hands=0,late_arrival_hands=0,
      roster_identity_hands=0,profile_identity_hands=0,roster_unavailable_hands=0,roster_missing_hands=0,
      identity_basis=public.fn_horse_commitment_identity_basis(d.day,false,false) WHERE day=d.day RETURNING * INTO d;
  END IF;
  -- The receipt of the immediately previous pass of this day, if one was
  -- recorded. No receipt means no late-arrival basis, never 'no late hands'.
  SELECT * INTO prior FROM public.horse_commitment_audit_passes WHERE day=d.day AND pass=d.pass-1;
  FOR h IN
    SELECT x.id,x.table_id,x.created_at,x.game_variant,x.big_blind,x.players,x.tournament_id,x.actions,
      t.tournament_type,t.table_size,t.max_players,c.payload_hash,c.post_commit_payload_hash,
      c.hand_id AS commit_hand_id,c.committed_at,
      c.post_commit_payload,
      r.hand_id AS roster_hand_id,r.post_commit_payload_hash AS roster_payload_hash,
      r.status AS roster_status,r.roster
    FROM (
      SELECT id,table_id,created_at,game_variant,big_blind,players,tournament_id,actions
      FROM public.hand_history
      WHERE created_at >= coalesce(d.after_created_at,d.day::timestamp AT TIME ZONE 'UTC')
        AND created_at < (d.day+1)::timestamp AT TIME ZONE 'UTC'
        AND (d.after_created_at IS NULL OR (created_at,id)>(d.after_created_at,d.after_hand_id))
      ORDER BY created_at,id LIMIT 256
    ) x
    LEFT JOIN public.hand_atomic_commits c ON c.hand_id=x.id AND c.table_id=x.table_id
    LEFT JOIN public.tournaments t ON t.id=x.tournament_id
    LEFT JOIN smarter_private.accepted_hand_rosters r
      ON x.created_at>=epoch AND r.table_id=c.table_id AND r.hand_number=c.hand_number
    ORDER BY x.created_at,x.id
  LOOP
    scanned:=scanned+1;last_created:=h.created_at;last_id:=h.id;
    gaps:=ARRAY[]::text[];facts:=NULL;contributions:=NULL;refunds:=NULL;
    source_ok:=false;roster_ok:=false;
    IF h.post_commit_payload IS NULL THEN gaps:=array_append(gaps,'accepted_commitment_facts_missing');
    ELSIF pg_column_size(h.post_commit_payload)>262144 THEN gaps:=array_append(gaps,'accepted_payload_oversized');
    ELSIF h.post_commit_payload_hash IS DISTINCT FROM encode(extensions.digest(convert_to(h.post_commit_payload::text,'UTF8'),'sha256'),'hex') THEN
      gaps:=array_append(gaps,'accepted_payload_digest_mismatch');
    ELSE
      facts:=h.post_commit_payload->'accepted_hand_facts';
      contributions:=facts->'contributions';refunds:=facts->'returned_uncalled';
      source_ok:=jsonb_typeof(contributions)='object' AND jsonb_typeof(refunds)='object';
      IF source_ok IS DISTINCT FROM true THEN gaps:=array_append(gaps,'accepted_commitment_facts_invalid'); END IF;
    END IF;
    -- No accepted commit row at all is named separately from a commit row
    -- without usable facts. Both are missing source; neither is skipped.
    IF h.commit_hand_id IS NULL THEN
      no_commit:=no_commit+1;gaps:=array_append(gaps,'hand_without_commit');
    END IF;
    IF h.post_commit_payload IS NULL OR pg_column_size(h.post_commit_payload)>262144 THEN
      missing_source:=missing_source+1;
    END IF;
    -- Late arrival: the previous completed pass of this day could not have
    -- seen this hand. Either it sorts after that pass's final cursor (that
    -- pass ended on a short batch, so it saw every row then visible past
    -- it), or its accepted commit clock is after that pass's cutover, a
    -- clock read after the pass's last scan snapshot. Sufficient, not
    -- complete: a hand committed late below an earlier batch's cursor but
    -- before the cutover is not provably late and is not labelled late.
    IF prior.pass IS NOT NULL AND (prior.final_after_created_at IS NULL
      OR (h.created_at,h.id)>(prior.final_after_created_at,prior.final_after_hand_id)
      OR h.committed_at>prior.cutover) THEN
      late:=late+1;gaps:=array_append(gaps,'late_arrival_after_pass:'||prior.pass);
    END IF;
    seats:=0;
    IF jsonb_typeof(h.players)='array' AND jsonb_array_length(h.players) BETWEEN 2 AND 10 THEN
      seats:=jsonb_array_length(h.players);
      SELECT count(*)=seats AND count(DISTINCT lower(p->>'userId'))=seats INTO roster_ok
        FROM jsonb_array_elements(h.players) p
        WHERE jsonb_typeof(p)='object' AND p->>'userId' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
    END IF;
    IF NOT roster_ok THEN gaps:=array_append(gaps,'dealt_roster_invalid'); END IF;
    -- Accepted roster identity. A hand created before the epoch was accepted
    -- before any roster existed and is the only hand classified by today's
    -- profile. From the epoch on, the roster recorded in the acceptance
    -- transaction is the only identity source; an unusable or absent roster
    -- is named and classifies no horse, never falls back to the profile.
    hand_basis:=NULL;horse_ids:=ARRAY[]::uuid[];
    IF h.created_at<epoch THEN
      hand_basis:='current_profile_is_horse';profile_hands:=profile_hands+1;
    ELSIF h.roster_hand_id IS NULL THEN
      roster_missing:=roster_missing+1;gaps:=array_append(gaps,'accepted_roster_legacy_missing');
    ELSIF h.roster_hand_id IS DISTINCT FROM h.id OR h.roster_payload_hash IS DISTINCT FROM h.post_commit_payload_hash THEN
      roster_missing:=roster_missing+1;gaps:=array_append(gaps,'accepted_roster_mismatch');
    ELSIF h.roster_status IS DISTINCT FROM 'captured' THEN
      roster_unavailable:=roster_unavailable+1;gaps:=array_append(gaps,'accepted_roster_unavailable');
    ELSE
      actors:=h.roster->'actors';actors_ok:=false;
      IF h.roster->>'handId'=h.id::text AND h.roster->>'tableId'=h.table_id::text
        AND jsonb_typeof(actors)='array' AND jsonb_array_length(actors) BETWEEN 2 AND 10 THEN
        SELECT count(*)=jsonb_array_length(actors) AND count(DISTINCT lower(a->>'userId'))=jsonb_array_length(actors) INTO actors_ok
          FROM jsonb_array_elements(actors) a
          WHERE jsonb_typeof(a)='object' AND a->>'classification' IN ('horse','human','unknown')
            AND a->>'userId' ~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
      END IF;
      IF actors_ok IS DISTINCT FROM true THEN
        roster_unavailable:=roster_unavailable+1;gaps:=array_append(gaps,'accepted_roster_invalid');
      ELSE
        hand_basis:='accepted_roster';roster_hands:=roster_hands+1;
        IF roster_ok AND ARRAY(SELECT lower(p->>'userId') FROM jsonb_array_elements(h.players) p ORDER BY 1)
          IS DISTINCT FROM ARRAY(SELECT lower(a->>'userId') FROM jsonb_array_elements(actors) a ORDER BY 1) THEN
          gaps:=array_append(gaps,'accepted_roster_players_disagree');
        END IF;
      END IF;
    END IF;
    bb:=h.big_blind;
    IF bb IS NULL OR bb::text IN ('NaN','Infinity','-Infinity') OR bb<=0 OR bb>90071992547409.91 OR round(bb,2)<>bb THEN
      bb:=NULL;gaps:=array_append(gaps,'big_blind_invalid');
    END IF;
    variant:=coalesce(h.game_variant,'unknown');
    game_format:=CASE WHEN h.tournament_id IS NULL THEN CASE WHEN seats=2 THEN 'hu_cash' ELSE 'cash' END
      WHEN upper(h.tournament_type) IN ('SPIN','SPIN_AND_GO','SPIN_AND_GOLD') THEN 'spin'
      WHEN upper(h.tournament_type) IN ('HU_SNG','HEADS_UP_SNG') THEN 'hu_sng'
      -- Actual createSNG emits SNG with both counts=2. Older canonical rows
      -- used the schema default table_size=9 but still declared max_players=2.
      -- This diagnostic recognizes only those reviewed shapes, never the
      -- current hand's remaining players. Missing/conflicting other shapes
      -- retain generic SNG; no historical format authority is inferred.
      WHEN upper(h.tournament_type)='SNG' AND h.max_players=2
        AND h.table_size IN (2,9) THEN 'hu_sng'
      WHEN upper(h.tournament_type)='SNG' THEN 'sng'
      WHEN upper(h.tournament_type) IN ('MTT','SATELLITE') THEN 'mtt'
      ELSE 'tournament_unknown' END;
    IF game_format='tournament_unknown' THEN gaps:=array_append(gaps,'tournament_format_unknown'); END IF;
    -- Generic SNG is retained when the current metadata cannot distinguish a
    -- reviewed HU shape from a field. This gap is an observation, not a repair
    -- of historical tournament configuration or an authority upgrade.
    IF upper(h.tournament_type)='SNG' AND ((
      (h.max_players=2 AND h.table_size IN (2,9)) OR
      (h.max_players>2 AND h.table_size BETWEEN 3 AND 10)
    ) IS DISTINCT FROM true) THEN
      gaps:=array_append(gaps,'tournament_format_metadata_unqualified');
    END IF;
    IF hand_basis='current_profile_is_horse' AND roster_ok THEN
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(h.players) p LEFT JOIN public.profiles pr ON pr.id=(p->>'userId')::uuid WHERE pr.id IS NULL OR pr.is_horse IS NULL) THEN
        gaps:=array_append(gaps,'horse_identity_unknown');
      END IF;
      horse_ids:=ARRAY(SELECT pr.id FROM jsonb_array_elements(h.players) p JOIN public.profiles pr ON pr.id=(p->>'userId')::uuid WHERE pr.is_horse IS TRUE ORDER BY pr.id);
    ELSIF hand_basis='accepted_roster' THEN
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(actors) a WHERE a->>'classification'='unknown') THEN
        gaps:=array_append(gaps,'horse_identity_unknown');
      END IF;
      horse_ids:=ARRAY(SELECT (a->>'userId')::uuid FROM jsonb_array_elements(actors) a WHERE a->>'classification'='horse' ORDER BY 1);
    END IF;
    FOREACH horse_id IN ARRAY horse_ids LOOP
        horses:=horses+1;net:=NULL;refund:=NULL;gross:=NULL;valid_money:=false;
        reasons:=ARRAY[]::text[];verdict:='unverified';
        IF source_ok IS TRUE AND jsonb_typeof(contributions->horse_id::text)='number'
          AND (NOT refunds ? horse_id::text OR jsonb_typeof(refunds->horse_id::text)='number') THEN
          net:=(contributions->>horse_id::text)::numeric;
          refund:=coalesce((refunds->>horse_id::text)::numeric,0);
          valid_money:=net>=0 AND refund>=0 AND net<=90071992547409.91 AND refund<=90071992547409.91
            AND round(net,2)=net AND round(refund,2)=refund AND net+refund<=90071992547409.91;
        END IF;
        IF valid_money AND bb IS NOT NULL THEN gross:=net+refund;
        ELSE reasons:=gaps||ARRAY['commitment_eligibility_unknown','reference_not_graded_commitment_unknown']; END IF;
        IF gross IS NULL OR gross>10*bb THEN
          IF gross IS NULL THEN unknowns:=unknowns+1;
          ELSE
            flagged:=flagged+1;
            -- Grade the horse's own recorded decisions in this hand against
            -- the stored solver reference. Never a replay; never a guess:
            -- every decision outside the reference's domain is named.
            grade:=public.fn_horse_commitment_reference_grade(h.actions,horse_id,facts->'stats_facts');
            verdict:=grade->>'verdict';
            reasons:=ARRAY(SELECT jsonb_array_elements_text(grade->'reasons'));
          END IF;
          INSERT INTO public.horse_commitment_reviews(hand_id,horse_user_id,table_id,played_at,source_payload_hash,game_variant,format,seats,big_blind,net_contribution,returned_uncalled,committed_amount,committed_bb,eligibility,gto_verdict,reasons)
          VALUES(h.id,horse_id,h.table_id,h.created_at,h.post_commit_payload_hash,variant,game_format,seats,bb,
            CASE WHEN valid_money THEN net END,CASE WHEN valid_money THEN refund END,gross,gross/bb,
            CASE WHEN gross IS NULL THEN 'unknown' ELSE 'over_10bb' END,verdict,reasons)
          ON CONFLICT DO NOTHING;
          SELECT source_payload_hash,format INTO old_hash,old_format FROM public.horse_commitment_reviews WHERE hand_id=h.id AND horse_user_id=horse_id;
          IF old_hash IS DISTINCT FROM h.post_commit_payload_hash THEN gaps:=array_append(gaps,'review_source_changed'); END IF;
          -- Preserve the first review. Current metadata or a new classifier
          -- cannot silently rewrite a historical diagnostic's original label.
          IF old_format IS DISTINCT FROM game_format THEN gaps:=array_append(gaps,'review_format_changed'); END IF;
        END IF;
    END LOOP;
    IF cardinality(gaps)>0 THEN
      gap_hands:=gap_hands+1;
      INSERT INTO public.horse_commitment_audit_gaps(hand_id,played_at,reasons) VALUES(h.id,h.created_at,gaps)
        ON CONFLICT(hand_id) DO UPDATE SET reasons=ARRAY(SELECT DISTINCT v FROM unnest(public.horse_commitment_audit_gaps.reasons||excluded.reasons) v),observed_at=transaction_timestamp();
    END IF;
  END LOOP;
  -- Read after the scan's snapshot was taken, so a commit clock later than
  -- this proves the commit was invisible to every batch of this pass.
  scan_cutover:=clock_timestamp();
  -- The basis this pass has actually used. A pass under way before the
  -- identity counters existed (NULL) began under the profile-only body.
  IF d.roster_identity_hands IS NULL THEN
    used_profile:=true;
    used_roster:=d.identity_basis='current_profile_then_accepted_roster' OR roster_hands+roster_unavailable+roster_missing>0;
  ELSE
    used_profile:=d.profile_identity_hands+profile_hands>0;
    used_roster:=d.roster_identity_hands+d.roster_unavailable_hands+d.roster_missing_hands
      +roster_hands+roster_unavailable+roster_missing>0;
  END IF;
  UPDATE public.horse_commitment_audit_days SET after_created_at=coalesce(last_created,after_created_at),after_hand_id=coalesce(last_id,after_hand_id),
    last_batch_at=transaction_timestamp(),finished_at=CASE WHEN scanned<256 THEN transaction_timestamp() END,
    scanned_hands=scanned_hands+scanned,horse_hands=horse_hands+horses,flagged_horse_hands=flagged_horse_hands+flagged,
    unknown_horse_hands=unknown_horse_hands+unknowns,hand_gaps=hand_gaps+gap_hands,
    hands_without_commit=hands_without_commit+no_commit,missing_source_hands=missing_source_hands+missing_source,
    late_arrival_hands=late_arrival_hands+late,
    roster_identity_hands=roster_identity_hands+roster_hands,profile_identity_hands=profile_identity_hands+profile_hands,
    roster_unavailable_hands=roster_unavailable_hands+roster_unavailable,roster_missing_hands=roster_missing_hands+roster_missing,
    identity_basis=public.fn_horse_commitment_identity_basis(day,used_profile,used_roster)
    WHERE day=d.day RETURNING * INTO d;
  -- A completed pass leaves an immutable receipt in this same transaction,
  -- before any later re-pass can zero the day counters. A pass that began
  -- before receipts existed has NULL selection counters and gets none:
  -- its early batches were never counted, so no complete receipt exists.
  -- Its identity counters are NULL when it began before they existed; its
  -- basis is always named.
  IF scanned<256 AND d.hands_without_commit IS NOT NULL AND d.missing_source_hands IS NOT NULL
    AND d.late_arrival_hands IS NOT NULL THEN
    INSERT INTO public.horse_commitment_audit_passes(day,pass,window_start,window_end,cutover,
      max_scanned_created_at,final_after_created_at,final_after_hand_id,scanned_hands,horse_hands,
      flagged_horse_hands,unknown_horse_hands,hand_gaps,hands_without_commit,missing_source_hands,
      late_arrival_hands,started_at,finished_at,identity_basis,roster_identity_hands,profile_identity_hands,
      roster_unavailable_hands,roster_missing_hands)
    VALUES(d.day,d.pass,d.day::timestamp AT TIME ZONE 'UTC',(d.day+1)::timestamp AT TIME ZONE 'UTC',scan_cutover,
      d.after_created_at,d.after_created_at,d.after_hand_id,d.scanned_hands,d.horse_hands,
      d.flagged_horse_hands,d.unknown_horse_hands,d.hand_gaps,d.hands_without_commit,d.missing_source_hands,
      d.late_arrival_hands,d.started_at,d.finished_at,d.identity_basis,d.roster_identity_hands,d.profile_identity_hands,
      d.roster_unavailable_hands,d.roster_missing_hands)
    ON CONFLICT (day,pass) DO NOTHING;
  END IF;
  -- Prune only this diagnostic store, in bounded chunks. No source retention changes.
  DELETE FROM public.horse_commitment_reviews WHERE (hand_id,horse_user_id) IN
    (SELECT hand_id,horse_user_id FROM public.horse_commitment_reviews WHERE played_at<transaction_timestamp()-interval '32 days' ORDER BY played_at,hand_id LIMIT 4096);
  DELETE FROM public.horse_commitment_audit_gaps WHERE hand_id IN
    (SELECT hand_id FROM public.horse_commitment_audit_gaps WHERE played_at<transaction_timestamp()-interval '32 days' ORDER BY played_at,hand_id LIMIT 4096);
  DELETE FROM public.horse_commitment_audit_days WHERE day<today-35;
  RETURN jsonb_build_object('version',1,'status',CASE WHEN scanned<256 THEN 'pass_complete' ELSE 'recorded' END,
    'day',d.day,'scannedHands',scanned,'horseHands',horses,'flaggedHorseHands',flagged,'unknownHorseHands',unknowns,'handGaps',gap_hands,
    'sourceCoverage','not_established','activationAuthorized',false,'gtoVerdict','unverified');
END;
$fn$;
-- Unchanged ACL, restated so the file carries its own closure.
REVOKE ALL ON FUNCTION public.fn_horse_commitment_audit_step() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.fn_horse_commitment_audit_step() TO service_role;

-- ===========================================================================
-- POSTIMAGE. Abort the whole transaction unless what was installed is exact.
-- ===========================================================================
DO $postimage$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc WHERE oid='public.fn_horse_commitment_audit_step()'::regprocedure
      AND md5(prosrc)='47003cf6071665e5f3dd4c176f1b8fa0' AND prosecdef AND proowner='postgres'::regrole
      AND provolatile='v' AND procost=100
      AND proconfig=ARRAY['search_path=pg_catalog, public, pg_temp','lock_timeout=2s','statement_timeout=5s']::text[]
      AND ARRAY(SELECT item::text FROM unnest(proacl) item ORDER BY item::text)
        =ARRAY['postgres=X/postgres','service_role=X/postgres']::text[]) THEN
    RAISE EXCEPTION 'horse_commitment_reference_grade_postimage_step';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.horse_commitment_reviews'::regclass
        AND conname='horse_commitment_reviews_gto_verdict_check') IS DISTINCT FROM 'CHECK (((gto_verdict = ANY (ARRAY[''unverified''::text, ''reference_agreed''::text, ''reference_deviation''::text])) AND ((gto_verdict = ''unverified''::text) OR (eligibility = ''over_10bb''::text)))) NOT VALID' THEN
    RAISE EXCEPTION 'horse_commitment_reference_grade_postimage_constraint';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['anon','authenticated','service_role']) r
      CROSS JOIN unnest(ARRAY['public.fn_horse_commitment_reference_grade(jsonb,uuid,jsonb)',
        'public.fn_horse_commitment_reference_position(integer,integer,integer[])',
        'public.fn_horse_commitment_reference_hand_class(jsonb)']) f
      WHERE has_function_privilege(r,f,'EXECUTE')) THEN
    RAISE EXCEPTION 'horse_commitment_reference_grade_postimage_acl';
  END IF;
END;
$postimage$;

-- Invalidate only the gateway schema cache after this transaction commits.
NOTIFY pgrst, 'reload schema';
COMMIT;
