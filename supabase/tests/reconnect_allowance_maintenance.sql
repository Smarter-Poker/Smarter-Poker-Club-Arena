-- Read-only assertions. Run after applying the reconnect allowance migration.

DO $test$
DECLARE s jsonb; r jsonb;
BEGIN
s := '{
 "regular":{"state":"MISSING","graceDeadlineMs":120000,"reconnectDeadlineMs":120000,"reconnectGrantedAtMs":90000,"strikes":2},
 "vip":{"state":"MISSING","reconnectDeadlineMs":135000,"reconnectGrantedAtMs":90000},
 "expired":{"state":"DISCONNECTED","reconnectDeadlineMs":100000},
 "during":{"state":"MISSING","reconnectDeadlineMs":230000,"reconnectGrantedAtMs":200000},
 "legacy":{"state":"MISSING","graceDeadlineMs":110000},
 "connected":{"state":"CONNECTED","graceDeadlineMs":null,"reconnectDeadlineMs":115000},
 "bad":{"reconnectDeadlineMs":"bad","reconnectThawedAtMs":"bad"},
 "scalar":7
}';
r := public.fn_thaw_reconnect_states(s,100000,400000);
ASSERT (r#>>'{regular,reconnectDeadlineMs}')::numeric=420000, 'regular remaining 20 seconds';
ASSERT (r#>>'{vip,reconnectDeadlineMs}')::numeric=435000, 'VIP remaining 35 seconds';
ASSERT r->'expired'=s->'expired', 'expired allowance cannot revive';
ASSERT (r#>>'{during,reconnectDeadlineMs}')::numeric=430000, 'grant during freeze';
ASSERT (r#>>'{legacy,reconnectDeadlineMs}')::numeric=410000, 'legacy missing state';
ASSERT r#>'{connected,graceDeadlineMs}'='null'::jsonb, 'connected grace remains null';
ASSERT (r#>>'{connected,reconnectDeadlineMs}')::numeric=415000, 'heartbeat does not lose allowance';
ASSERT r->'bad'=s->'bad' AND r->'scalar'=s->'scalar', 'malformed entries preserved';
ASSERT (r#>>'{regular,strikes}')::integer=2, 'other fields retained';
ASSERT public.fn_thaw_reconnect_states(r,100000,400000)=r, 'idempotent on retry and restored shifted snapshot';
ASSERT public.fn_thaw_reconnect_states(s,100000,100000)=s, 'invalid interval';
END;
$test$;
