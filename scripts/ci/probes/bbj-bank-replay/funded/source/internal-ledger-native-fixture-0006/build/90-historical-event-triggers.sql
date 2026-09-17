--
-- Name: ca_ddl_watchdog_drop_log; Type: EVENT TRIGGER; Schema: -; Owner: postgres
--

CREATE EVENT TRIGGER ca_ddl_watchdog_drop_log ON sql_drop
   EXECUTE FUNCTION public.ca_log_ddl_drop();


ALTER EVENT TRIGGER ca_ddl_watchdog_drop_log OWNER TO postgres;

--
-- Name: ca_ddl_watchdog_log; Type: EVENT TRIGGER; Schema: -; Owner: postgres
--

CREATE EVENT TRIGGER ca_ddl_watchdog_log ON ddl_command_end
   EXECUTE FUNCTION public.ca_log_ddl_event();


ALTER EVENT TRIGGER ca_ddl_watchdog_log OWNER TO postgres;

--
-- Name: issue_graphql_placeholder; Type: EVENT TRIGGER; Schema: -; Owner: postgres
--

CREATE EVENT TRIGGER issue_graphql_placeholder ON sql_drop
         WHEN TAG IN ('DROP EXTENSION')
   EXECUTE FUNCTION extensions.set_graphql_placeholder();


ALTER EVENT TRIGGER issue_graphql_placeholder OWNER TO postgres;

--
-- Name: issue_pg_cron_access; Type: EVENT TRIGGER; Schema: -; Owner: postgres
--

CREATE EVENT TRIGGER issue_pg_cron_access ON ddl_command_end
         WHEN TAG IN ('CREATE EXTENSION')
   EXECUTE FUNCTION extensions.grant_pg_cron_access();


ALTER EVENT TRIGGER issue_pg_cron_access OWNER TO postgres;

--
-- Name: issue_pg_graphql_access; Type: EVENT TRIGGER; Schema: -; Owner: postgres
--

CREATE EVENT TRIGGER issue_pg_graphql_access ON ddl_command_end
         WHEN TAG IN ('CREATE FUNCTION')
   EXECUTE FUNCTION extensions.grant_pg_graphql_access();


ALTER EVENT TRIGGER issue_pg_graphql_access OWNER TO postgres;

--
-- Name: issue_pg_net_access; Type: EVENT TRIGGER; Schema: -; Owner: postgres
--

CREATE EVENT TRIGGER issue_pg_net_access ON ddl_command_end
         WHEN TAG IN ('CREATE EXTENSION')
   EXECUTE FUNCTION extensions.grant_pg_net_access();


ALTER EVENT TRIGGER issue_pg_net_access OWNER TO postgres;

--
-- Name: pgrst_ddl_watch; Type: EVENT TRIGGER; Schema: -; Owner: postgres
--

CREATE EVENT TRIGGER pgrst_ddl_watch ON ddl_command_end
   EXECUTE FUNCTION extensions.pgrst_ddl_watch();


ALTER EVENT TRIGGER pgrst_ddl_watch OWNER TO postgres;

--
-- Name: pgrst_drop_watch; Type: EVENT TRIGGER; Schema: -; Owner: postgres
--

CREATE EVENT TRIGGER pgrst_drop_watch ON sql_drop
   EXECUTE FUNCTION extensions.pgrst_drop_watch();


ALTER EVENT TRIGGER pgrst_drop_watch OWNER TO postgres;

--
-- Name: trg_autorevoke_privileged_anon; Type: EVENT TRIGGER; Schema: -; Owner: postgres
--

CREATE EVENT TRIGGER trg_autorevoke_privileged_anon ON ddl_command_end
         WHEN TAG IN ('CREATE FUNCTION', 'ALTER FUNCTION', 'GRANT')
   EXECUTE FUNCTION public.fn_autorevoke_privileged_anon();


ALTER EVENT TRIGGER trg_autorevoke_privileged_anon OWNER TO postgres;

--
-- Name: trg_new_view_respects_the_caller; Type: EVENT TRIGGER; Schema: -; Owner: postgres
--

CREATE EVENT TRIGGER trg_new_view_respects_the_caller ON ddl_command_end
         WHEN TAG IN ('CREATE VIEW', 'ALTER VIEW')
   EXECUTE FUNCTION public.fn_new_view_respects_the_caller();


ALTER EVENT TRIGGER trg_new_view_respects_the_caller OWNER TO postgres;

--
-- Name: trg_reject_retired_solver_option_rpc_ddl; Type: EVENT TRIGGER; Schema: -; Owner: postgres
--

CREATE EVENT TRIGGER trg_reject_retired_solver_option_rpc_ddl ON ddl_command_end
         WHEN TAG IN ('CREATE FUNCTION', 'ALTER FUNCTION')
   EXECUTE FUNCTION public.fn_reject_retired_solver_option_rpc_ddl();


ALTER EVENT TRIGGER trg_reject_retired_solver_option_rpc_ddl OWNER TO postgres;

--
-- Name: EVENT TRIGGER trg_reject_retired_solver_option_rpc_ddl; Type: COMMENT; Schema: -; Owner: postgres
--

COMMENT ON EVENT TRIGGER trg_reject_retired_solver_option_rpc_ddl IS 'Blocks CREATE/ALTER from recreating either retired legacy solver option RPC in public.';


--
-- Name: trg_rls_on_new_public_table; Type: EVENT TRIGGER; Schema: -; Owner: postgres
--

CREATE EVENT TRIGGER trg_rls_on_new_public_table ON ddl_command_end
         WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
   EXECUTE FUNCTION public.fn_rls_on_new_public_table();


ALTER EVENT TRIGGER trg_rls_on_new_public_table OWNER TO postgres;

--
-- Name: trg_strip_client_writes_from_new_views; Type: EVENT TRIGGER; Schema: -; Owner: postgres
--

CREATE EVENT TRIGGER trg_strip_client_writes_from_new_views ON ddl_command_end
         WHEN TAG IN ('CREATE VIEW', 'CREATE MATERIALIZED VIEW')
   EXECUTE FUNCTION public.fn_strip_client_writes_from_new_views();


ALTER EVENT TRIGGER trg_strip_client_writes_from_new_views OWNER TO postgres;

--
-- Name: xp_ban_guard; Type: EVENT TRIGGER; Schema: -; Owner: postgres
--

CREATE EVENT TRIGGER xp_ban_guard ON ddl_command_end
         WHEN TAG IN ('CREATE TABLE', 'ALTER TABLE', 'CREATE FUNCTION')
   EXECUTE FUNCTION public.xp_ban_guard_fn();


ALTER EVENT TRIGGER xp_ban_guard OWNER TO postgres;

--
-- Name: EVENT TRIGGER xp_ban_guard; Type: COMMENT; Schema: -; Owner: postgres
--

COMMENT ON EVENT TRIGGER xp_ban_guard IS 'ZERO XP POLICY v3 (substring-matching): blocks any CREATE/ALTER introducing XP-named column/table/function.';


--
-- PostgreSQL database dump complete
--


