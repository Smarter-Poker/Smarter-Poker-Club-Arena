-- The compact key is only defined for a possible seven-card deck. Source
-- validation already rejects duplicate boards and positive blocked combos;
-- make the shared key function independently fail closed so ad-hoc callers,
-- future builders, and runtime-parity probes cannot classify impossible cards.
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_gto_v31_hand_key(p_combo_index integer, p_board text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = public
AS $fn$
DECLARE
  v_cards text[] := public.fn_gto_v31_combo_cards(p_combo_index);
  v_ranks constant text := '23456789TJQKA';
  v_r1 text;
  v_r2 text;
  v_s1 text;
  v_s2 text;
  v_high text;
  v_low text;
  v_suffix text;
  v_count1 integer;
  v_count2 integer;
  v_high_count integer;
  v_low_count integer;
BEGIN
  IF p_board !~ '^([2-9TJQKA][cdhs]){3,5}$' THEN RETURN NULL; END IF;
  IF (SELECT count(DISTINCT substr(p_board,n,2))
        FROM generate_series(1,length(p_board),2) n) <> length(p_board)/2
     OR EXISTS (
       SELECT 1 FROM unnest(v_cards) c(card) WHERE position(c.card IN p_board)>0
     ) THEN
    RETURN NULL;
  END IF;
  v_r1 := left(v_cards[1],1);
  v_s1 := right(v_cards[1],1);
  v_r2 := left(v_cards[2],1);
  v_s2 := right(v_cards[2],1);

  SELECT count(*) INTO v_count1
    FROM generate_series(2,length(p_board),2) n
   WHERE substr(p_board,n,1)=v_s1;
  SELECT count(*) INTO v_count2
    FROM generate_series(2,length(p_board),2) n
   WHERE substr(p_board,n,1)=v_s2;

  IF position(v_r1 IN v_ranks) > position(v_r2 IN v_ranks) THEN
    v_high := v_r1;
    v_low := v_r2;
    v_high_count := v_count1;
    v_low_count := v_count2;
  ELSIF position(v_r2 IN v_ranks) > position(v_r1 IN v_ranks) THEN
    v_high := v_r2;
    v_low := v_r1;
    v_high_count := v_count2;
    v_low_count := v_count1;
  ELSE
    v_high := v_r1;
    v_low := v_r2;
    v_high_count := greatest(v_count1,v_count2);
    v_low_count := least(v_count1,v_count2);
  END IF;

  v_suffix := CASE
    WHEN v_high=v_low THEN ''
    WHEN v_s1=v_s2 THEN 's'
    ELSE 'o'
  END;
  RETURN v_high || v_low || v_suffix || ':' || v_high_count || v_low_count;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_gto_v31_hand_key(integer,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_gto_v31_hand_key(integer,text) TO service_role;

COMMENT ON FUNCTION public.fn_gto_v31_hand_key(integer,text) IS
  'Canonical two-hole-suit V31 hand key; NULL for duplicate boards, blocked combos, or malformed cards.';

DO $contract_assertions$
BEGIN
  IF public.fn_gto_v31_hand_key(1321,'QsQs2c') IS NOT NULL
     OR public.fn_gto_v31_hand_key(1321,'As7d2c') IS NOT NULL THEN
    RAISE EXCEPTION 'V31 hand-key accepted an impossible deck';
  END IF;
  IF public.fn_gto_v31_hand_key(1321,'Qs7s2c') IS DISTINCT FROM 'AKo:20'
     OR public.fn_gto_v31_hand_key(1272,'Qs7s2c') IS DISTINCT FROM 'AKo:02' THEN
    RAISE EXCEPTION 'V31 impossible-deck hardening changed a valid key';
  END IF;
END;
$contract_assertions$;

COMMIT;
