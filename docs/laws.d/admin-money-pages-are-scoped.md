# tests/admin-money-pages-are-scoped.law.test.ts

The five global-path admin money pages (/financial-admin,
/settlement-dashboard, /settlement-history, /credit-admin, /rate-audit) name
the club they are about through `useFinancialAdminScope` - the URL's club,
else the whole platform for platform staff, else the club where the viewer
holds a finance role - and every read of a club-keyed money table on them goes
through `clubScoped()`, which refuses to build a query before the scope is
ready, and binds its error. Also pins that TransactionLedgerView refuses a
read with no union, club or player; that /engine and /financial-alerts sit
behind PlatformStaffGuard, /financial-incidents behind FinancialAdminGate and
the union operations/money routes behind UnionOverseerGuard
(`ca_can_oversee_union`); and that no route element chooses between a guarded
and an unguarded render of the same page on a build flag.
