-- Root-owned finite original witness admission AFTER exact31649 installation
-- and its required installation recording. No wallet/ledger/funding receipts
-- are created; supported original validators retain the seven actual witnesses.
BEGIN;
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='2s';
SET LOCAL timezone='UTC';
DO $admit$
DECLARE c record;p jsonb;g numeric:=0;r numeric:=0;gn int:=0;rn int:=0;
BEGIN
 IF smarter_private.original_inventory_proof_sources_match()IS DISTINCT FROM true OR position('count(*)=65' IN pg_get_functiondef('smarter_private.original_inventory_proof_sources_match()'::regprocedure))=0 THEN RAISE EXCEPTION 'original65_treasury_authority_required';END IF;
 FOR c IN SELECT * FROM(VALUES
('1b4eab8b-d46d-4f54-a825-340d50d9e6e2'::uuid,'gift',200.0::numeric,'2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid,'29199f64-bb8e-40ce-994b-651a7af38567'::uuid),
('68e2c834-49cb-4917-aa9d-95355b0cebfc'::uuid,'return',628.65::numeric,'2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid,'29199f64-bb8e-40ce-994b-651a7af38567'::uuid),
('821d7f4b-0bd9-431d-bca2-6308627d7faf'::uuid,'return',1244.38::numeric,'a0000000-0000-0000-0000-000000000001'::uuid,'650f193e-e50c-4239-b243-eb25384a4ae7'::uuid),
('95445619-c021-4dd8-97b5-a593ce910145'::uuid,'gift',200.0::numeric,'a0000000-0000-0000-0000-000000000001'::uuid,'2de00543-57b1-425e-8ea0-66cb294c1de9'::uuid),
('ab65ad78-6e50-4718-ba7e-86256d426a43'::uuid,'gift',200.0::numeric,'2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid,'1c1c117c-bf60-4282-810c-0658f2528e11'::uuid),
('b439b3d5-2d1f-4859-aa48-34bea8a8101c'::uuid,'gift',347.0::numeric,'a0000000-0000-0000-0000-000000000001'::uuid,'650f193e-e50c-4239-b243-eb25384a4ae7'::uuid),
('dc82ad6b-1357-489b-9d11-b426eb50d053'::uuid,'return',788.3::numeric,'2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid,'1c1c117c-bf60-4282-810c-0658f2528e11'::uuid)
 )x(ledger_id,kind,amount,club_id,user_id) ORDER BY CASE kind WHEN 'gift'THEN 0 ELSE 1 END,ledger_id LOOP
  p:=CASE c.kind WHEN 'gift'THEN smarter_private.admit_original_treasury_gift(c.ledger_id)ELSE smarter_private.admit_original_treasury_return(c.ledger_id)END;
  IF p->>'status'IS DISTINCT FROM'proven' OR p->>'ledger_id'IS DISTINCT FROM c.ledger_id::text OR(p->>'amount')::numeric IS DISTINCT FROM c.amount OR p->>'earning_club'IS DISTINCT FROM c.club_id::text OR p->>'user_id'IS DISTINCT FROM c.user_id::text
   OR NOT EXISTS(SELECT FROM smarter_private.original_treasury_funding_witnesses w JOIN smarter_private.original_treasury_historical_admissions h ON h.ledger_id=w.ledger_id AND h.kind=w.kind AND h.source_fingerprint=w.source_fingerprint WHERE w.ledger_id=c.ledger_id AND w.kind=c.kind AND w.historical_late)THEN RAISE EXCEPTION 'original_treasury_admission_identity_disagrees: %',c.ledger_id;END IF;
  IF c.kind='gift'THEN gn:=gn+1;g:=g+c.amount;ELSE rn:=rn+1;r:=r+c.amount;END IF;
 END LOOP;
 IF gn<>4 OR rn<>3 OR g<>947 OR r<>2661.33 THEN RAISE EXCEPTION 'original_treasury_admission_totals_disagree';END IF;
 RAISE NOTICE 'original_treasury_witnesses_proven: gifts4/947 returns3/2661.33; no money changed';
END$admit$;
COMMIT;
