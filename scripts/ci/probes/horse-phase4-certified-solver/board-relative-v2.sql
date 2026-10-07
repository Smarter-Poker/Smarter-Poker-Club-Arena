-- DISCONNECTED QUALIFICATION SOURCE ONLY. Load into an isolated PostgreSQL17
-- fixture; this is NOT a migration and never changes the existing V31 key.
CREATE OR REPLACE FUNCTION public.fn_gto_v31_board_relative_key_v2(p_combo_index integer,p_board text)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=public AS $fn$
DECLARE
  holes text[]; combo_high integer; combo_low integer;
  cards text[]; ranks integer[]:=ARRAY[]::integer[]; suits text[]:=ARRAY[]::text[];
  board_ranks integer[]; all_ranks integer[]; groups integer[]; multiplicities integer[];
  best integer[]:=ARRAY[]::integer[]; score integer[]; unique_ranks integer[];
  chosen integer[]; chosen_cards text[]; chosen_ranks integer[];
  bmult jsonb; hole_tuples jsonb[]:=ARRAY[]::jsonb[]; hole_relations jsonb;
  suit_tuples jsonb[]:=ARRAY[]::jsonb[]; suit_relations jsonb;
  tiebreak jsonb:='[]'::jsonb; tuple jsonb;
  i integer; j integer; a integer; b integer; c integer; d integer; e integer;
  r integer; top integer; contribution integer; min_hole integer:=2; max_hole integer:=0;
  straight integer; complete_ranks integer:=0; complete_cards integer:=0;
  flush_cards integer:=0; board_suit_count integer; hole_suit_count integer;
  unseen integer; adjacent integer:=0; one_gap integer:=0; windows integer:=0;
  suit text; suited_hole integer[]; run integer[]; is_flush boolean; has_straight boolean:=false;
  wire jsonb;
BEGIN
  IF p_combo_index NOT BETWEEN 0 AND 1325 OR length(p_board) NOT IN (6,8,10)
     OR p_board !~ '^([2-9TJQKA][cdhs]){3,5}$' THEN RETURN NULL; END IF;
  combo_high:=floor((1+sqrt(1+8*p_combo_index))/2)::integer;
  WHILE combo_high*(combo_high-1)/2>p_combo_index LOOP combo_high:=combo_high-1; END LOOP;
  WHILE (combo_high+1)*combo_high/2<=p_combo_index LOOP combo_high:=combo_high+1; END LOOP;
  combo_low:=p_combo_index-combo_high*(combo_high-1)/2;
  holes:=ARRAY[
    substr('23456789TJQKA',combo_low/4+1,1)||substr('cdhs',mod(combo_low,4)+1,1),
    substr('23456789TJQKA',combo_high/4+1,1)||substr('cdhs',mod(combo_high,4)+1,1)
  ];
  cards:=holes;
  FOR i IN 0..length(p_board)/2-1 LOOP cards:=array_append(cards,substr(p_board,2*i+1,2)); END LOOP;
  IF (SELECT count(DISTINCT value) FROM unnest(cards) value)<>cardinality(cards) THEN RETURN NULL; END IF;
  FOR i IN 1..cardinality(cards) LOOP
    ranks:=array_append(ranks,strpos('23456789TJQKA',substr(cards[i],1,1))+1);
    suits:=array_append(suits,substr(cards[i],2,1));
  END LOOP;
  SELECT array_agg(DISTINCT value ORDER BY value DESC) INTO board_ranks FROM unnest(ranks[3:cardinality(ranks)]) value;
  SELECT array_agg(DISTINCT value ORDER BY value DESC) INTO all_ranks FROM unnest(ranks) value;
  SELECT jsonb_agg(cnt ORDER BY cnt DESC) INTO bmult FROM (
    SELECT count(*)::integer cnt FROM unnest(ranks[3:cardinality(ranks)]) value GROUP BY value
  ) counted;
  FOR i IN 1..2 LOOP
    hole_tuples:=array_append(hole_tuples,jsonb_build_array(
      (SELECT count(*) FROM unnest(board_ranks) value WHERE value>ranks[i]),
      (SELECT count(*) FROM unnest(ranks[3:cardinality(ranks)]) value WHERE value=ranks[i]),
      CASE WHEN ranks[i]=14 THEN 1 ELSE 0 END));
  END LOOP;
  SELECT jsonb_agg(value ORDER BY (value->>0)::integer,(value->>1)::integer,(value->>2)::integer)
    INTO hole_relations FROM unnest(hole_tuples) value;

  -- Independent best-five enumeration (not the TS full-hand category counter).
  FOR a IN 1..cardinality(cards)-4 LOOP
   FOR b IN a+1..cardinality(cards)-3 LOOP
    FOR c IN b+1..cardinality(cards)-2 LOOP
     FOR d IN c+1..cardinality(cards)-1 LOOP
      FOR e IN d+1..cardinality(cards) LOOP
       chosen:=ARRAY[a,b,c,d,e];
       SELECT array_agg(ranks[x]),array_agg(cards[x]) INTO chosen_ranks,chosen_cards FROM unnest(chosen) x;
       SELECT array_agg(value ORDER BY cnt DESC,value DESC),array_agg(cnt ORDER BY cnt DESC,value DESC)
         INTO groups,multiplicities FROM (SELECT value,count(*)::integer cnt FROM unnest(chosen_ranks) value GROUP BY value) counted;
       SELECT array_agg(DISTINCT value ORDER BY value DESC) INTO unique_ranks FROM unnest(chosen_ranks) value;
       is_flush:=(SELECT count(DISTINCT substr(value,2,1))=1 FROM unnest(chosen_cards) value);
       straight:=0;
       IF cardinality(unique_ranks)=5 THEN
         IF unique_ranks[1]-unique_ranks[5]=4 THEN straight:=unique_ranks[1];
         ELSIF unique_ranks=ARRAY[14,5,4,3,2] THEN straight:=5; END IF;
       END IF;
       IF is_flush AND straight>0 THEN score:=ARRAY[8,straight];
       ELSIF multiplicities[1]=4 THEN score:=ARRAY[7,groups[1],groups[2]];
       ELSIF multiplicities[1]=3 AND multiplicities[2]=2 THEN score:=ARRAY[6,groups[1],groups[2]];
       ELSIF is_flush THEN score:=ARRAY[5]||unique_ranks;
       ELSIF straight>0 THEN score:=ARRAY[4,straight];
       ELSIF multiplicities[1]=3 THEN score:=ARRAY[3]||groups;
       ELSIF multiplicities[1]=2 AND multiplicities[2]=2 THEN score:=ARRAY[2]||groups;
       ELSIF multiplicities[1]=2 THEN score:=ARRAY[1]||groups;
       ELSE score:=ARRAY[0]||unique_ranks; END IF;
       SELECT count(*)::integer INTO contribution FROM unnest(chosen) x WHERE x<=2;
       IF score>best THEN best:=score;min_hole:=contribution;max_hole:=contribution;
       ELSIF score=best THEN min_hole:=least(min_hole,contribution);max_hole:=greatest(max_hole,contribution); END IF;
      END LOOP;
     END LOOP;
    END LOOP;
   END LOOP;
  END LOOP;
  FOR i IN 2..cardinality(best) LOOP
    r:=best[i];
    tiebreak:=tiebreak||jsonb_build_array(jsonb_build_array(
      (SELECT count(*) FROM unnest(ranks[1:2]) value WHERE value=r),
      COALESCE(array_position(board_ranks,r)-1,-1),
      CASE WHEN r=ANY(ranks[1:2]) THEN 14-r ELSE -1 END));
  END LOOP;
  FOREACH suit IN ARRAY ARRAY['c','d','h','s'] LOOP
    SELECT count(*)::integer INTO board_suit_count FROM generate_series(3,cardinality(cards)) x WHERE suits[x]=suit;
    SELECT count(*)::integer INTO hole_suit_count FROM generate_series(1,2) x WHERE suits[x]=suit;
    SELECT array_agg(ranks[x] ORDER BY ranks[x] DESC) INTO suited_hole FROM generate_series(1,2) x WHERE suits[x]=suit;
    tuple:=jsonb_build_array(board_suit_count,hole_suit_count);
    IF suited_hole IS NOT NULL THEN
      FOREACH r IN ARRAY suited_hole LOOP
        SELECT count(*)::integer INTO unseen FROM generate_series(r+1,14) higher
          WHERE NOT EXISTS (SELECT 1 FROM generate_series(1,cardinality(cards)) x WHERE ranks[x]=higher AND suits[x]=suit);
        tuple:=tuple||jsonb_build_array(unseen);
      END LOOP;
    END IF;
    suit_tuples:=array_append(suit_tuples,tuple);
    IF cardinality(cards)<7 AND board_suit_count+hole_suit_count=4 THEN flush_cards:=flush_cards+9; END IF;
  END LOOP;
  SELECT jsonb_agg(value ORDER BY (value->>0)::integer,(value->>1)::integer,
    COALESCE((value->>2)::integer,-1),COALESCE((value->>3)::integer,-1)) INTO suit_relations FROM unnest(suit_tuples) value;
  FOR top IN 5..14 LOOP
    run:=CASE WHEN top=5 THEN ARRAY[14,2,3,4,5] ELSE ARRAY[top-4,top-3,top-2,top-1,top] END;
    IF all_ranks @> run THEN has_straight:=true; END IF;
    IF (SELECT count(*) FROM unnest(run) value WHERE value=ANY(board_ranks))>=4 THEN windows:=windows+1; END IF;
  END LOOP;
  IF cardinality(cards)<7 AND NOT has_straight THEN
    FOR r IN 2..14 LOOP
      IF NOT r=ANY(all_ranks) THEN
        FOR top IN 5..14 LOOP
          run:=CASE WHEN top=5 THEN ARRAY[14,2,3,4,5] ELSE ARRAY[top-4,top-3,top-2,top-1,top] END;
          IF (all_ranks||r) @> run THEN complete_ranks:=complete_ranks+1;complete_cards:=complete_cards+4;EXIT; END IF;
        END LOOP;
      END IF;
    END LOOP;
  END IF;
  FOR i IN 1..cardinality(board_ranks) LOOP FOR j IN i+1..cardinality(board_ranks) LOOP
    IF board_ranks[i]-board_ranks[j]=1 OR (board_ranks[i]=14 AND board_ranks[j]=2) THEN adjacent:=adjacent+1; END IF;
    IF board_ranks[i]-board_ranks[j]=2 OR (board_ranks[i]=14 AND board_ranks[j]=3) THEN one_gap:=one_gap+1; END IF;
  END LOOP; END LOOP;
  wire:=jsonb_build_array('holdem-board-relative-v2',cardinality(cards)-2,best[1],bmult,hole_relations,
    ranks[1]=ranks[2],complete_ranks,complete_cards,suit_relations,flush_cards,tiebreak,
    jsonb_build_array(min_hole,max_hole),jsonb_build_array(adjacent,one_gap,windows));
  RETURN regexp_replace(wire::text,'\s','','g');
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_board_relative_key_v2_valid(p_key text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE STRICT SET search_path=public AS $fn$
DECLARE
  v jsonb; tuple jsonb; item jsonb; field integer; integer_value integer;
BEGIN
  v:=p_key::jsonb;
  IF jsonb_typeof(v)<>'array' OR jsonb_array_length(v)<>13
     OR v->>0<>'holdem-board-relative-v2' OR regexp_replace(v::text,'\s','','g')<>p_key
     OR jsonb_typeof(v->5)<>'boolean' THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY[1,2,6,7,9] LOOP
    IF jsonb_typeof(v->field)<>'number' OR (v->>field)!~ '^(0|[1-9][0-9]*)$' THEN RETURN false; END IF;
  END LOOP;
  IF (v->>1)::integer NOT IN (3,4,5) OR (v->>2)::integer NOT BETWEEN 0 AND 8
     OR (v->>6)::integer>13 OR (v->>7)::integer<>4*(v->>6)::integer
     OR (v->>9)::integer NOT IN (0,9) OR ((v->>1)::integer=5 AND ((v->>6)::integer<>0 OR (v->>9)::integer<>0)) THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY[3,4,8,10,11,12] LOOP
    IF jsonb_typeof(v->field)<>'array' THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_array_length(v->3) NOT BETWEEN 1 AND (v->>1)::integer
     OR jsonb_array_length(v->4)<>2 OR jsonb_array_length(v->8)<>4
     OR jsonb_array_length(v->10) NOT BETWEEN 1 AND 5 OR jsonb_array_length(v->11)<>2 OR jsonb_array_length(v->12)<>3 THEN RETURN false; END IF;
  IF jsonb_array_length(v->10)<>(CASE (v->>2)::integer
       WHEN 0 THEN 5 WHEN 1 THEN 4 WHEN 2 THEN 3 WHEN 3 THEN 3
       WHEN 4 THEN 1 WHEN 5 THEN 5 WHEN 6 THEN 2 WHEN 7 THEN 2 ELSE 1 END) THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(v->3) LOOP
    IF jsonb_typeof(item)<>'number' OR item::text !~ '^[1-4]$' THEN RETURN false; END IF;
  END LOOP;
  IF (SELECT sum(value::text::integer) FROM jsonb_array_elements(v->3))<>(v->>1)::integer THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY[4,8,10] LOOP
    FOR tuple IN SELECT value FROM jsonb_array_elements(v->field) LOOP
      IF jsonb_typeof(tuple)<>'array' OR jsonb_array_length(tuple) NOT BETWEEN 2 AND 4
        OR (field IN (4,10) AND jsonb_array_length(tuple)<>3)
        OR (field=8 AND jsonb_array_length(tuple)<>2+(tuple->>1)::integer) THEN RETURN false; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(tuple) LOOP
        IF jsonb_typeof(item)<>'number' OR item::text !~ '^(-1|0|[1-9][0-9]*)$' THEN RETURN false; END IF;
        integer_value:=item::text::integer;
        IF integer_value NOT BETWEEN (CASE WHEN field=10 THEN -1 ELSE 0 END) AND 12 THEN RETURN false; END IF;
      END LOOP;
      IF field=4 AND ((tuple->>0)::integer>(v->>1)::integer
         OR (tuple->>1)::integer>3 OR (tuple->>2)::integer NOT IN (0,1)) THEN RETURN false; END IF;
      IF field=8 AND ((tuple->>0)::integer>(v->>1)::integer OR (tuple->>1)::integer>2) THEN RETURN false; END IF;
      IF field=10 AND ((tuple->>0)::integer NOT BETWEEN 0 AND 2
         OR (tuple->>1)::integer NOT BETWEEN -1 AND jsonb_array_length(v->3)-1
         OR ((tuple->>0)::integer=0 AND (tuple->>2)::integer<>-1)
         OR ((tuple->>0)::integer>0 AND (tuple->>2)::integer<0)
         OR ((tuple->>0)::integer=0 AND (tuple->>1)::integer=-1)) THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  IF (SELECT sum((value->>0)::integer) FROM jsonb_array_elements(v->8))<>(v->>1)::integer
     OR (SELECT sum((value->>1)::integer) FROM jsonb_array_elements(v->8))<>2
     OR ((v->>5)::boolean AND (v#>'{4,0}'<>v#>'{4,1}' OR (v#>>'{4,0,1}')::integer>2)) THEN RETURN false; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements((v->11)||(v->12)) AS parts(value)
    WHERE jsonb_typeof(parts.value)<>'number' OR parts.value::text !~ '^(0|[1-9][0-9]*)$')
    OR (v#>>'{11,0}')::integer NOT BETWEEN greatest(0,5-(v->>1)::integer) AND 2
    OR (v#>>'{11,1}')::integer NOT BETWEEN (v#>>'{11,0}')::integer AND 2
    OR (v#>>'{12,0}')::integer>10 OR (v#>>'{12,1}')::integer>10 OR (v#>>'{12,2}')::integer>10 THEN RETURN false; END IF;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END;
$fn$;
