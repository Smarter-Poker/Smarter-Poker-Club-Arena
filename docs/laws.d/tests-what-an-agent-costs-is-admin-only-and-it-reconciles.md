# tests/what-an-agent-costs-is-admin-only-and-it-reconciles.law.test.ts

Commission columns are gated on `fn_is_club_admin_uid` (not the looser finances gate that admits super agents) and mask to NULL rather than 0; the figure is read from `agent_commissions` and never derived as rate x rake, because commission cascades; commission owed to recipients with no agents row gets its own residual row so the column reconciles exactly with `fn_club_commission_accrued`; the window is half-open to match that reader; and `ca_rake_snapshot` returns the club total instead of dropping it
