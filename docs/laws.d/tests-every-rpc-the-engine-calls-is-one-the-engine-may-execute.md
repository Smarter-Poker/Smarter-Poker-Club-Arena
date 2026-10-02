# tests/every-rpc-the-engine-calls-is-one-the-engine-may-execute.law.test.ts

Every name the engine passes to supabase.rpc() must not end its migration history with EXECUTE revoked from service_role (the role the engine runs as); fn_ca_tournament_rebuy_window is granted to service_role alone over its owner-only pre-image, so the closed-window bust-sweep short-circuit of #5466 actually runs.
