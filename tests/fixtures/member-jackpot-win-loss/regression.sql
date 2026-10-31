DO $$ DECLARE d jsonb; BEGIN
 d:=ca_club_member_win_loss('10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001');
 IF (d->'today'->>'cash')::numeric<>619.20 THEN RAISE EXCEPTION 'Paid jackpot missing from Win/Loss: %',d; END IF;
END $$;
