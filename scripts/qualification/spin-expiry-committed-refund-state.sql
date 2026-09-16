-- SOURCE ONLY / UNRUN. Loads after the unchanged R1/R5 observation helpers.
-- No token values are read; the one-use capability relation is count-only.
CREATE FUNCTION pg_temp.spin_expiry_r2_state() RETURNS jsonb
LANGUAGE plpgsql AS $r2_state$
DECLARE answer jsonb:=pg_temp.spin_expiry_business_state(); rows jsonb; n text;
BEGIN
  FOREACH n IN ARRAY ARRAY['wallet_credit_idempotency','rake_records'] LOOP
    EXECUTE format('SELECT COALESCE(jsonb_agg(r ORDER BY r::text),''[]''::jsonb)
      FROM (SELECT to_jsonb(x) r FROM public.%I x LIMIT 1001) bounded',n) INTO rows;
    IF jsonb_array_length(rows)>1000 THEN
      RAISE EXCEPTION 'spin expiry R2: relation output bound exceeded: %',n;
    END IF;
    answer:=answer||jsonb_build_object(n,rows);
  END LOOP;
  answer:=answer||jsonb_build_object('refund_authorizations_count',
    (SELECT count(*) FROM public.tournament_refund_authorizations));
  IF octet_length(answer::text)>524288 THEN
    RAISE EXCEPTION 'spin expiry R2: selected-state output exceeds 512 KiB';
  END IF;
  RETURN answer;
END;
$r2_state$;
