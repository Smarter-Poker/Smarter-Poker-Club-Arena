DO $$ DECLARE c uuid:='a41434bb-8d0c-400a-8f0d-e8b3d65afed4'; u uuid:='e5abee6e-abe2-4400-9005-b5c81577155d'; row_old record; row_new record; BEGIN
 SELECT * INTO row_old FROM ca_club_member_downline(c,u);
 ASSERT row_old.total_fees=57.14,'old overall contract';
 SELECT * INTO row_new FROM ca_club_member_downline_in_range(c,u,'2026-10-26','2026-10-29');
 ASSERT row_new.total_fees=7.22,'applied range must reach downline fees';
 ASSERT to_jsonb(row_old)-'total_fees'=to_jsonb(row_new)-'total_fees','hierarchy identity or wallet changed';
 ASSERT (SELECT total_fees FROM ca_club_member_downline_in_range(c,u,NULL,NULL))=57.14,'overall range';
 ASSERT (SELECT total_fees FROM ca_club_member_downline_in_range(c,u,'2026-10-23','2026-10-23'))=49.92,'single UTC day';
 ASSERT (SELECT total_fees FROM ca_club_member_downline_in_range(c,u,'2026-10-26','2026-10-26'))=7.22,'inclusive day';
 ASSERT NOT EXISTS(SELECT 1 FROM ca_club_member_downline_in_range(c,'73000000-0000-0000-0000-000000000002',NULL,NULL)),'other hierarchy';
 PERFORM set_config('test.access','none',true);
 ASSERT NOT EXISTS(SELECT 1 FROM ca_club_member_downline_in_range(c,u,NULL,NULL)),'access refused';
 ASSERT NOT has_function_privilege('anon','ca_club_member_downline_in_range(uuid,uuid,date,date)','EXECUTE'),'anonymous refused';
END $$;
\echo DOWNLINE_RANGE PASS: screenshot 57.14 overall versus 7.22 applied, UTC days, hierarchy and ACLs, other fields unchanged
