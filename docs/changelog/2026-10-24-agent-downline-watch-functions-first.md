# Agent downline watch: functions ship before the window policy

The 04:00 America/Chicago install of `20261024020328` refused on lock timeout
(its `CREATE POLICY` on `public.tables` needs a frozen break). The new ordinary
migration `20261024193818` installs the three functions now, with no relation
lock and no break: `fn_agent_can_watch_table` (engine and browser helper),
`fn_get_table_watch_access` (watch button) and `fn_search_players` (agent
search). Bodies are byte-identical to the queued file, which stays queued and
later adds only the `agent_downline_table_observation` metadata policy.
The native PostgreSQL suite now proves the function-only stage before the policy.
