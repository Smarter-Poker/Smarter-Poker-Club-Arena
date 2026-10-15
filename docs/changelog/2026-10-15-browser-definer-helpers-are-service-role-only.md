# Browser-Reachable Definer Helpers Are Service Role Only

Telemetry Exposure had failed on main since 2026-10-11 because four SECURITY DEFINER
routines with no identity argument were executable by `authenticated`:
`fn_ca_launch_accounting_cutoff`, `fn_ca_launch_accounting_start`,
`fn_ca_launch_accounting_waived` and the retired `fn_redeem_vip_points` stub.

Migration `20261015004335` revokes EXECUTE from PUBLIC, anon and authenticated and keeps
service_role. No RLS policy or view references them, every caller of the launch
helpers is itself SECURITY DEFINER (or not browser-executable), and no client code calls
the retired stub, so no browser path changes.
