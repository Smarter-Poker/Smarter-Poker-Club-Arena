# Global wallet transfers use club authority

The wallet screen combined live club and agent balances but its Send panel
called fn_wallet_type_transfer, which still moved public.wallets. That pool
has been retired since August. A successful call could move invisible balances
while the real club balance stayed unchanged.

The panel now opens the current club cashier, or the existing club chooser
when no club is selected. The obsolete service/store/hook transfer APIs and
unused legacy user-to-user wrapper are removed. Scoped agent self-transfer and
Diamond gifting remain unchanged. The database RPC keeps its signature but
refuses without touching balances, protecting already-open older clients too.
No historical balance is reassigned, deleted, or reclaimed.

Regression contracts pin the refusal and absence of the retired client paths;
existing supported-wallet tests still run. A private PostgreSQL execution
checks the real migration and confirms refusal preserves both balances and
journal count. Publication and exact installed migration readback are separate.

Installed through the configured Supabase migration tool at 16:13 UTC. The tool
assigned ledger version 20261005161344; the source filename follows that actual
installed identity rather than the earlier reserved 20261005160950. No replay.
Readback: function MD5 1dedf0d38ab47a16f12e76b8f202e99e, owner postgres,
SECURITY INVOKER, authenticated execution retained for the explicit refusal.
