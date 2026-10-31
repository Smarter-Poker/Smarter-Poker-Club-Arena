DO $$ DECLARE u uuid:='73000000-0000-0000-0000-000000000002'; c uuid:='73000000-0000-0000-0000-000000000001'; j jsonb; k jsonb; b record; BEGIN
 SELECT * INTO b FROM ca_stats_calendar_bounds(7,'America/Chicago');
 j:=ca_player_rake_stats_calendar(u,7,'chips','America/Chicago');
 k:=ca_player_rake_stats_calendar_by_club(u,7,'chips',c,'America/Chicago');
 ASSERT (j->>'hands')::int=2 AND (j->>'rake_paid')::numeric=5,format('calendar cash bounds wrong: %s',j);
 ASSERT (k->>'hands')::int=2 AND (k->>'rake_paid')::numeric=5,format('funded calendar bounds wrong: %s',k);
 ASSERT (j->>'range_from')::timestamptz=b.from_at AND (j->>'range_to')::timestamptz=b.to_at AND j->>'range_tz'='America/Chicago','calendar provenance';
 ASSERT (ca_player_rake_stats_calendar(u,7,'diamonds','America/Chicago')->>'rake_paid')::numeric=50,'asset isolation';
 ASSERT (ca_player_rake_stats_calendar_by_club(u,7,'chips','a41434bb-8d0c-400a-8f0d-e8b3d65afed4','America/Chicago')->>'hands')::int=0,'club isolation';
 ASSERT ca_player_rake_stats_calendar(u,7,'chips','invalid-timezone')->>'range_tz'='UTC','invalid timezone fallback';
 ASSERT (ca_player_rake_stats_calendar(u,0,'chips','UTC')->>'days')::int=1,'minimum days';
 ASSERT (ca_player_rake_stats_calendar(u,5000,'chips','UTC')->>'days')::int=3650,'maximum days';
 ASSERT ca_player_rake_stats_calendar(u,NULL,'chips','America/Chicago')->'range_from'='null'::jsonb,'unbounded dates';
 -- No changes to original API or fixed/share allocation in an unbounded read.
 j:=ca_player_rake_stats('69f2cefa-017d-49f3-ac3e-61505633747c');
 ASSERT j=(SELECT all_clubs FROM calendar_legacy_baseline),'old all-club contract';
 ASSERT ca_player_rake_stats_calendar('69f2cefa-017d-49f3-ac3e-61505633747c',NULL,'chips','America/Chicago')-'range_from'-'range_to'-'range_tz'=j,'unbounded allocation';
 ASSERT ca_player_rake_stats_by_club('69f2cefa-017d-49f3-ac3e-61505633747c',NULL,'chips','a41434bb-8d0c-400a-8f0d-e8b3d65afed4')=(SELECT one_club FROM calendar_legacy_baseline),'old funded contract';
 ASSERT NOT has_function_privilege('anon','ca_player_rake_stats_calendar(uuid,integer,text,text)','EXECUTE'),'anonymous reader refused';
 ASSERT NOT has_function_privilege('authenticated','smarter_private.fn_player_rake_share_calendar_cents(uuid,timestamptz,timestamptz,text)','EXECUTE'),'private helper refused';
 ASSERT has_function_privilege('authenticated','ca_player_rake_stats_calendar(uuid,integer,text,text)','EXECUTE'),'owner door granted';
 -- The actual standing-share allocator respects bounds before daily rounding.
 INSERT INTO smarter_private.player_rake_share_rules(rule_key,club_id,from_user,to_user,share_bps,effective_from,reason)
 VALUES ('calendar-fixture',c,u,'73000000-0000-0000-0000-000000000004',5000,b.from_at-interval '1 day',repeat('calendar fixture ',4));
 INSERT INTO smarter_private.player_fee_redemptions(operation_key,club_id,user_id,effective_on,amount_cents,reason,recorded_at)
 VALUES ('calendar-in',c,u,(b.from_at AT TIME ZONE 'UTC')::date+1,25,repeat('calendar fixture ',4),now()),
 ('calendar-before',c,u,(b.from_at AT TIME ZONE 'UTC')::date,10000,repeat('calendar fixture ',4),now()),
 ('calendar-after',c,u,(b.to_at AT TIME ZONE 'UTC')::date+1,10000,repeat('calendar fixture ',4),now());
 j:=ca_player_rake_stats_calendar(u,7,'chips','America/Chicago');
 ASSERT (j->>'rake_share')::numeric=-2.5 AND (j->>'rake_paid')::numeric=2.25,format('bounded share/redemption: %s',j);
 ASSERT (ca_player_rake_stats_calendar_by_club(u,7,'chips',c,'America/Chicago')->>'rake_paid')::numeric=2.25,'funded bounded share/redemption';
 j:=ca_player_rake_stats_calendar('73000000-0000-0000-0000-000000000004',7,'chips','America/Chicago');
 ASSERT (j->>'hands')::int=0 AND (j->>'rake_paid')::numeric=2.5,'recipient shares without own hands';
 -- Explicit helper times prove DST calendar lengths without changing server time.
 SELECT * INTO b FROM ca_stats_calendar_bounds(1,'America/Chicago','2026-11-01 19:00Z');
 ASSERT b.to_at-b.from_at=interval '25 hours','fall DST';
 SELECT * INTO b FROM ca_stats_calendar_bounds(1,'America/Chicago','2026-03-08 19:00Z');
 ASSERT b.to_at-b.from_at=interval '23 hours','spring DST';
END $$;
\echo RAKE_CALENDAR PASS: exact calendar boundaries, UTC, DST, day validation, assets, clubs, old APIs and allocations, private ACLs
