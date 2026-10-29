DO $$ DECLARE n numeric; i integer; q text; BEGIN
FOR i IN 1..3 LOOP
q:=CASE i WHEN 1 THEN 'SELECT net FROM fn_ca_leg_accounts(''-infinity'',''infinity'')' WHEN 2 THEN 'SELECT net FROM fn_ca_leg_accounts_since_snapshot(''-infinity'',''3:3:'')' ELSE 'SELECT net FROM fn_ca_leg_accounts_since_snapshot_for(''-infinity'',''3:3:'',ARRAY[''a41434bb-8d0c-400a-8f0d-e8b3d65afed4'']::uuid[])' END;
EXECUTE q||' WHERE account_key=''promo_wallet:a41434bb-8d0c-400a-8f0d-e8b3d65afed4:clubs.promo_balance''' INTO n;
IF n IS DISTINCT FROM EXPECTED_NET::numeric THEN RAISE EXCEPTION 'reader % got %',i,n; END IF;
EXECUTE q||' WHERE account_key=''promo_wallet:a41434bb-8d0c-400a-8f0d-e8b3d65afed4:explicit.other_column''' INTO n;
IF n IS DISTINCT FROM -3::numeric THEN RAISE EXCEPTION 'explicit label changed'; END IF;
END LOOP;
IF EXISTS(SELECT 1 FROM fn_ca_leg_accounts('-infinity','infinity') WHERE entity_id='99999999-0000-0000-0000-000000000001' AND account_type<>'unkeyable') THEN RAISE EXCEPTION 'unknown owner was guessed'; END IF;
END $$;
SELECT 'three reader totals, explicit labels and unknown-owner boundary passed';
