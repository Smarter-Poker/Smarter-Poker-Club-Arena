-- R6 sealing reached its 240s budget inside the V2 best-five SQL subset loop.
-- Keep the exact independent enumeration and wire contract; replace only
-- tiny SPI queries with bounded array arithmetic. No gate or data changes.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='60s';
DO $repair$
DECLARE b record; before_definition text; after_definition text;
 old_subset text := $old$       chosen:=ARRAY[a,b,c,d,e];
       SELECT array_agg(ranks[x]),array_agg(cards[x]) INTO chosen_ranks,chosen_cards FROM unnest(chosen) x;
       SELECT array_agg(value ORDER BY cnt DESC,value DESC),array_agg(cnt ORDER BY cnt DESC,value DESC)
         INTO groups,multiplicities FROM (SELECT value,count(*)::integer cnt FROM unnest(chosen_ranks) value GROUP BY value) counted;
       SELECT array_agg(DISTINCT value ORDER BY value DESC) INTO unique_ranks FROM unnest(chosen_ranks) value;
       is_flush:=(SELECT count(DISTINCT substr(value,2,1))=1 FROM unnest(chosen_cards) value);
$old$;
 new_subset text := $new$       -- Enumerate the same five cards without planning SQL for every subset.
       chosen:=ARRAY[a,b,c,d,e];
       rank_counts:=array_fill(0,ARRAY[15]);
       contribution:=0;
       FOREACH subset_index IN ARRAY chosen LOOP
         rank_counts[ranks[subset_index]]:=rank_counts[ranks[subset_index]]+1;
         IF subset_index<=2 THEN contribution:=contribution+1; END IF;
       END LOOP;
       unique_ranks:=ARRAY[]::integer[];
       FOR r IN REVERSE 14..2 LOOP
         IF rank_counts[r]>0 THEN unique_ranks:=array_append(unique_ranks,r); END IF;
       END LOOP;
       groups:=ARRAY[]::integer[];
       multiplicities:=ARRAY[]::integer[];
       FOR rank_count IN REVERSE 4..1 LOOP
         FOREACH r IN ARRAY unique_ranks LOOP
           IF rank_counts[r]=rank_count THEN
             groups:=array_append(groups,r);
             multiplicities:=array_append(multiplicities,rank_count);
           END IF;
         END LOOP;
       END LOOP;
       is_flush:=suits[a]=suits[b] AND suits[a]=suits[c]
         AND suits[a]=suits[d] AND suits[a]=suits[e];
$new$;
BEGIN
 SELECT * INTO STRICT b FROM pg_proc
 WHERE oid='public.fn_gto_v31_board_relative_key_v2(integer,text)'::regprocedure;
 before_definition:=pg_get_functiondef(b.oid);
 IF md5(before_definition)<>'4dc0cd773f09f7c73f436bfa91b4af41'
 OR (length(before_definition)-length(replace(before_definition,old_subset,'')))/length(old_subset)<>1 THEN
  RAISE EXCEPTION 'V31 feature subset optimization exact preimage differs';
 END IF;
 after_definition:=replace(before_definition,
  '  chosen integer[]; chosen_cards text[]; chosen_ranks integer[];',
  '  chosen integer[]; rank_counts integer[]; rank_count integer; subset_index integer; board_counts integer[]; all_counts integer[]; greater_count integer; same_count integer; suit_sort_keys integer[]:=ARRAY[]::integer[]; sort_key integer; swap_key integer; swap_tuple jsonb;');
 after_definition:=replace(after_definition,old_subset,new_subset);
 after_definition:=replace(after_definition,
  E'       SELECT count(*)::integer INTO contribution FROM unnest(chosen) x WHERE x<=2;\n','');
 IF (length(after_definition)-length(replace(after_definition,$old0$  IF (SELECT count(DISTINCT value) FROM unnest(cards) value)<>cardinality(cards) THEN RETURN NULL; END IF;$old0$,'')))/length($old0$  IF (SELECT count(DISTINCT value) FROM unnest(cards) value)<>cardinality(cards) THEN RETURN NULL; END IF;$old0$)<>1 THEN RAISE EXCEPTION 'V31 feature fragment 0 differs'; END IF;
 after_definition:=replace(after_definition,$old0$  IF (SELECT count(DISTINCT value) FROM unnest(cards) value)<>cardinality(cards) THEN RETURN NULL; END IF;$old0$,$new0$  FOR i IN 1..cardinality(cards) LOOP FOR j IN i+1..cardinality(cards) LOOP
    IF cards[i]=cards[j] THEN RETURN NULL; END IF;
  END LOOP; END LOOP;$new0$);
 IF (length(after_definition)-length(replace(after_definition,$old1$  SELECT array_agg(DISTINCT value ORDER BY value DESC) INTO board_ranks FROM unnest(ranks[3:cardinality(ranks)]) value;
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
$old1$,'')))/length($old1$  SELECT array_agg(DISTINCT value ORDER BY value DESC) INTO board_ranks FROM unnest(ranks[3:cardinality(ranks)]) value;
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
$old1$)<>1 THEN RAISE EXCEPTION 'V31 feature fragment 1 differs'; END IF;
 after_definition:=replace(after_definition,$old1$  SELECT array_agg(DISTINCT value ORDER BY value DESC) INTO board_ranks FROM unnest(ranks[3:cardinality(ranks)]) value;
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
$old1$,$new1$  board_counts:=array_fill(0,ARRAY[15]); all_counts:=array_fill(0,ARRAY[15]);
  FOR i IN 1..cardinality(ranks) LOOP
    all_counts[ranks[i]]:=all_counts[ranks[i]]+1;
    IF i>=3 THEN board_counts[ranks[i]]:=board_counts[ranks[i]]+1; END IF;
  END LOOP;
  board_ranks:=ARRAY[]::integer[]; all_ranks:=ARRAY[]::integer[];
  FOR r IN REVERSE 14..2 LOOP
    IF board_counts[r]>0 THEN board_ranks:=array_append(board_ranks,r); END IF;
    IF all_counts[r]>0 THEN all_ranks:=array_append(all_ranks,r); END IF;
  END LOOP;
  bmult:='[]'::jsonb;
  FOR rank_count IN REVERSE 4..1 LOOP
    FOREACH r IN ARRAY board_ranks LOOP
      IF board_counts[r]=rank_count THEN bmult:=bmult||jsonb_build_array(rank_count); END IF;
    END LOOP;
  END LOOP;
  FOR i IN 1..2 LOOP
    greater_count:=0;
    FOREACH r IN ARRAY board_ranks LOOP
      IF r>ranks[i] THEN greater_count:=greater_count+1; END IF;
    END LOOP;
    hole_tuples:=array_append(hole_tuples,jsonb_build_array(greater_count,
      board_counts[ranks[i]],CASE WHEN ranks[i]=14 THEN 1 ELSE 0 END));
  END LOOP;
  -- Equal-length numeric tuples use the same lexicographic order as the old columns.
  IF hole_tuples[1]>hole_tuples[2] THEN
    hole_relations:=jsonb_build_array(hole_tuples[2],hole_tuples[1]);
  ELSE hole_relations:=jsonb_build_array(hole_tuples[1],hole_tuples[2]); END IF;
$new1$);
 IF (length(after_definition)-length(replace(after_definition,$old2$      (SELECT count(*) FROM unnest(ranks[1:2]) value WHERE value=r),$old2$,'')))/length($old2$      (SELECT count(*) FROM unnest(ranks[1:2]) value WHERE value=r),$old2$)<>1 THEN RAISE EXCEPTION 'V31 feature fragment 2 differs'; END IF;
 after_definition:=replace(after_definition,$old2$      (SELECT count(*) FROM unnest(ranks[1:2]) value WHERE value=r),$old2$,$new2$      (ranks[1]=r)::integer+(ranks[2]=r)::integer,$new2$);
 IF (length(after_definition)-length(replace(after_definition,$old3$    SELECT count(*)::integer INTO board_suit_count FROM generate_series(3,cardinality(cards)) x WHERE suits[x]=suit;
    SELECT count(*)::integer INTO hole_suit_count FROM generate_series(1,2) x WHERE suits[x]=suit;
    SELECT array_agg(ranks[x] ORDER BY ranks[x] DESC) INTO suited_hole FROM generate_series(1,2) x WHERE suits[x]=suit;$old3$,'')))/length($old3$    SELECT count(*)::integer INTO board_suit_count FROM generate_series(3,cardinality(cards)) x WHERE suits[x]=suit;
    SELECT count(*)::integer INTO hole_suit_count FROM generate_series(1,2) x WHERE suits[x]=suit;
    SELECT array_agg(ranks[x] ORDER BY ranks[x] DESC) INTO suited_hole FROM generate_series(1,2) x WHERE suits[x]=suit;$old3$)<>1 THEN RAISE EXCEPTION 'V31 feature fragment 3 differs'; END IF;
 after_definition:=replace(after_definition,$old3$    SELECT count(*)::integer INTO board_suit_count FROM generate_series(3,cardinality(cards)) x WHERE suits[x]=suit;
    SELECT count(*)::integer INTO hole_suit_count FROM generate_series(1,2) x WHERE suits[x]=suit;
    SELECT array_agg(ranks[x] ORDER BY ranks[x] DESC) INTO suited_hole FROM generate_series(1,2) x WHERE suits[x]=suit;$old3$,$new3$    board_suit_count:=0; hole_suit_count:=0; suited_hole:=NULL;
    FOR i IN 1..cardinality(cards) LOOP
      IF suits[i]=suit THEN
        IF i>=3 THEN board_suit_count:=board_suit_count+1;
        ELSE hole_suit_count:=hole_suit_count+1; suited_hole:=array_append(suited_hole,ranks[i]); END IF;
      END IF;
    END LOOP;
    IF cardinality(suited_hole)=2 AND suited_hole[1]<suited_hole[2] THEN
      suited_hole:=ARRAY[suited_hole[2],suited_hole[1]];
    END IF;$new3$);
 IF (length(after_definition)-length(replace(after_definition,$old4$        SELECT count(*)::integer INTO unseen FROM generate_series(r+1,14) higher
          WHERE NOT EXISTS (SELECT 1 FROM generate_series(1,cardinality(cards)) x WHERE ranks[x]=higher AND suits[x]=suit);$old4$,'')))/length($old4$        SELECT count(*)::integer INTO unseen FROM generate_series(r+1,14) higher
          WHERE NOT EXISTS (SELECT 1 FROM generate_series(1,cardinality(cards)) x WHERE ranks[x]=higher AND suits[x]=suit);$old4$)<>1 THEN RAISE EXCEPTION 'V31 feature fragment 4 differs'; END IF;
 after_definition:=replace(after_definition,$old4$        SELECT count(*)::integer INTO unseen FROM generate_series(r+1,14) higher
          WHERE NOT EXISTS (SELECT 1 FROM generate_series(1,cardinality(cards)) x WHERE ranks[x]=higher AND suits[x]=suit);$old4$,$new4$        unseen:=14-r;
        FOR i IN 1..cardinality(cards) LOOP
          IF ranks[i]>r AND suits[i]=suit THEN unseen:=unseen-1; END IF;
        END LOOP;$new4$);
 IF (length(after_definition)-length(replace(after_definition,$old5$  SELECT jsonb_agg(value ORDER BY (value->>0)::integer,(value->>1)::integer,
    COALESCE((value->>2)::integer,-1),COALESCE((value->>3)::integer,-1)) INTO suit_relations FROM unnest(suit_tuples) value;$old5$,'')))/length($old5$  SELECT jsonb_agg(value ORDER BY (value->>0)::integer,(value->>1)::integer,
    COALESCE((value->>2)::integer,-1),COALESCE((value->>3)::integer,-1)) INTO suit_relations FROM unnest(suit_tuples) value;$old5$)<>1 THEN RAISE EXCEPTION 'V31 feature fragment 5 differs'; END IF;
 after_definition:=replace(after_definition,$old5$  SELECT jsonb_agg(value ORDER BY (value->>0)::integer,(value->>1)::integer,
    COALESCE((value->>2)::integer,-1),COALESCE((value->>3)::integer,-1)) INTO suit_relations FROM unnest(suit_tuples) value;$old5$,$new5$  -- Encode exactly the old four ORDER BY numeric columns, padding absent ranks as -1.
  FOR i IN 1..4 LOOP
    tuple:=suit_tuples[i];
    sort_key:=(((tuple->>0)::integer*4+(tuple->>1)::integer)*16+
      COALESCE((tuple->>2)::integer,-1)+1)*16+COALESCE((tuple->>3)::integer,-1)+1;
    suit_sort_keys:=array_append(suit_sort_keys,sort_key);
  END LOOP;
  FOR i IN 2..4 LOOP
    j:=i;
    WHILE j>1 AND suit_sort_keys[j]<suit_sort_keys[j-1] LOOP
      swap_key:=suit_sort_keys[j-1]; suit_sort_keys[j-1]:=suit_sort_keys[j]; suit_sort_keys[j]:=swap_key;
      swap_tuple:=suit_tuples[j-1]; suit_tuples[j-1]:=suit_tuples[j]; suit_tuples[j]:=swap_tuple;
      j:=j-1;
    END LOOP;
  END LOOP;
  suit_relations:=to_jsonb(suit_tuples);$new5$);
 IF (length(after_definition)-length(replace(after_definition,$old6$    IF (SELECT count(*) FROM unnest(run) value WHERE value=ANY(board_ranks))>=4 THEN windows:=windows+1; END IF;$old6$,'')))/length($old6$    IF (SELECT count(*) FROM unnest(run) value WHERE value=ANY(board_ranks))>=4 THEN windows:=windows+1; END IF;$old6$)<>1 THEN RAISE EXCEPTION 'V31 feature fragment 6 differs'; END IF;
 after_definition:=replace(after_definition,$old6$    IF (SELECT count(*) FROM unnest(run) value WHERE value=ANY(board_ranks))>=4 THEN windows:=windows+1; END IF;$old6$,$new6$    same_count:=0;
    FOREACH r IN ARRAY run LOOP IF board_counts[r]>0 THEN same_count:=same_count+1; END IF; END LOOP;
    IF same_count>=4 THEN windows:=windows+1; END IF;$new6$);
 EXECUTE after_definition;
 IF pg_get_functiondef(b.oid) IS DISTINCT FROM after_definition OR NOT EXISTS (
  SELECT 1 FROM pg_proc p WHERE p.oid=b.oid AND p.proowner=b.proowner
   AND p.proacl IS NOT DISTINCT FROM b.proacl AND p.prosecdef=b.prosecdef
   AND p.proconfig IS NOT DISTINCT FROM b.proconfig AND p.proisstrict=b.proisstrict
   AND p.provolatile=b.provolatile AND p.proparallel=b.proparallel
   AND p.prorettype=b.prorettype AND p.proargtypes=b.proargtypes
   AND p.proleakproof=b.proleakproof
 ) THEN RAISE EXCEPTION 'V31 feature optimization changed contract metadata'; END IF;
END;
$repair$;
-- @live-proof: the exact V2 wire keys remain equal for the qualified all-combo
-- edge boards; strictness, volatility, search_path, ownership and ACL are preserved.
COMMIT;
