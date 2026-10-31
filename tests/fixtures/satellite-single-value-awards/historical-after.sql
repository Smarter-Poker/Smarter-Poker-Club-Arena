BEGIN;
DO $history$
DECLARE h record;r jsonb;wallet numeric;
BEGIN
 SELECT * INTO STRICT h FROM public.single_value_historical_fixture;
 PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
 PERFORM set_config('request.jwt.claim.role','service_role',true);
 EXECUTE 'SET LOCAL ROLE service_role';r:=public.fn_settle_satellite_tournament(h.source_id,h.winner);EXECUTE 'RESET ROLE';
 SELECT sum(chip_balance) INTO wallet FROM public.club_members WHERE club_id=(SELECT club_id FROM public.tournaments WHERE id=h.source_id);
 IF r IS DISTINCT FROM h.receipt OR wallet IS DISTINCT FROM h.wallet THEN RAISE EXCEPTION 'historical legacy cash receipt or wallet mutated';END IF;
 RAISE NOTICE 'PASS: actual pre-migration cash receipt immutable, wallet unchanged';
END $history$;
ROLLBACK;
