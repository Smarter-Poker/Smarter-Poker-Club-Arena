-- Owner explicitly directs next-hand recovery of these three interrupted originals.
-- No replacement deal, winner, payout, or stack mutation; all native fences remain.
-- Full immutable snapshot bytes identify the only river exception.
BEGIN;
DO $patch$
DECLARE body text;
BEGIN
 SELECT pg_get_functiondef('public.fn_f06_abort_abandoned_generation(uuid,uuid,uuid,text,boolean)'::regprocedure) INTO body;
 IF md5(body) <> 'ead21308621ee697dc418a3a8c2dd80e' THEN RAISE EXCEPTION 'EXACT_INCIDENT_ABORT_PREIMAGE_CHANGED'; END IF;
 IF length(body)-length(replace(body,$old$         OR snap.stage IS DISTINCT FROM 'preflop'
         OR snap.state_json->>'stage' IS DISTINCT FROM 'preflop'$old$,'')) <> length($old$         OR snap.stage IS DISTINCT FROM 'preflop'
         OR snap.state_json->>'stage' IS DISTINCT FROM 'preflop'$old$) THEN RAISE EXCEPTION 'EXACT_INCIDENT_ABORT_PATCH_CHANGED'; END IF;
 EXECUTE replace(body,$old$         OR snap.stage IS DISTINCT FROM 'preflop'
         OR snap.state_json->>'stage' IS DISTINCT FROM 'preflop'$old$,$new$         OR NOT (((snap.stage = 'preflop' AND snap.state_json->>'stage' = 'preflop') OR
           (t = '853b3df9-9e15-4d05-97b1-7a38dd0345c1'::uuid
            AND g = 'c6b911a0-0847-4bbf-82a5-f40fb5b915fd'::uuid
            AND h.table_id = 'f855c60a-8223-4e83-88ae-8e32191f5c46'::uuid
            AND h.hand_number = 51229078
            AND snap.id = '550fc305-4151-4a8e-bd9a-2cca289b9921'::uuid
            AND md5(to_jsonb(snap)::text) = '87a6f743916b576ce0e1fae414a9b3f0'
            AND snap.stage = 'river' AND snap.state_json->>'stage' = 'river'
            AND cardinality(reserved_ids) = 3
            AND (SELECT count(*) = 18 AND sum(s.stack) = 1025000
                   FROM public.table_seats s WHERE s.table_id = ANY(tab_ids) AND s.left_at IS NULL))) IS TRUE)$new$);
END $patch$;
COMMIT;
