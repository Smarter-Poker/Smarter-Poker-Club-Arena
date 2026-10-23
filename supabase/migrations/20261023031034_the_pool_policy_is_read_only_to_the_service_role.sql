-- ca_bbj_pool_policy (20261023030641) granted ALL to service_role. The rule is
-- changed only by a migration, so the service role reads it and nothing else.
-- @live-proof: has_table_privilege('service_role', 'public.ca_bbj_pool_policy', 'SELECT') AND NOT has_table_privilege('service_role', 'public.ca_bbj_pool_policy', 'INSERT') AND NOT has_table_privilege('service_role', 'public.ca_bbj_pool_policy', 'UPDATE')
REVOKE ALL ON TABLE public.ca_bbj_pool_policy FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.ca_bbj_pool_policy TO service_role;
