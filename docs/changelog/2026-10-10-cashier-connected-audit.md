# Cashier Connected Audit

Cashier recipient selection now retires immediately when the club route or
signed-in account generation changes, including an unresolved destination slug.
The old request keeps its original durable identity and cannot control the new
workspace. Diamond review and confirmation acquire one synchronous in-flight
lock, preventing rapid clicks from issuing duplicate requests.

The member-data database query excludes profiles explicitly marked deleted from
roster rows and downline counts, retains active descendants below deleted parents,
and returns a missing identity for deleted or absent club memberships. Historical
fee facts remain intact. The roster access check treats a missing profile's admin
flag as false, closing its unaffiliated-reader fall-through.

Diamond verification refuses deleted recipients before displaying their identity.
The authoritative writer refuses new transfers involving deleted profiles under
its existing ordered profile locks, after committed receipt recovery. Existing
friendship, session, anti-farming, collateral, debt, ledger and replay behavior
remain intact. No historical balances or records are rewritten.

Validation: 563 focused cashier/wallet tests passed, including before/after
regressions for club switching, repeated confirmation and deleted verification.
The required Accounting qualification runner executes native PostgreSQL member
query/access tests and the diamond transfer chain with the production profile
guard; the baseline pays a deleted friend, the corrected writer refuses without
wallet/journal changes, and an earlier receipt still replays. Private fixtures
include account-generation, historical fee, missing-profile, active descendant,
concurrent bank-credit and settled-receipt boundaries. App compiler, production
build, four copy gates and canonical policy checks passed.

This is a compatible client/database delivery using existing engine contracts.
Protected checks, exact migration installation and live publication are separate
from this source qualification and are recorded in the task checkpoint.
