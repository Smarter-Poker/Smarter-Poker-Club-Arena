# Diamond Games accounting fixture

Run the existing accounting entry point with PostgreSQL 17:

```sh
PG_BIN=/usr/lib/postgresql/17/bin bash scripts/dev/test-accounting-delivery.sh
```

The original accounting regression runs first, unchanged. The same private,
socket-only cluster then creates `diamond_games_probe`. Nothing accepts a
database URL or connects to production. The existing exit trap stops the cluster
and removes its private directory on either success or failure.

The fixture composes the retained historical Wheel/Daily Bonus schemas and policy
rows with catalog-captured financial columns, constraints, indexes, functions and
triggers. `provenance.json` records their source hashes and the selected scope.
Functions have body witnesses; captured triggers have definition witnesses. The
round-book view is the original migration definition over its real backing
tables, not an empty replacement view. Ledger writers, purchase-lot consumption,
Mint, eligibility, replay and append-only guards retain their real bodies.

The eight historical predecessor definitions are loaded before the untouched
`20260914132533` migration. Its eight `pg_get_functiondef` guards must pass.
The funding migration is also loaded unchanged. Current installed definitions
are not substituted for those historical predecessors.

`seed.sql` establishes synthetic starting identities, host memberships, balances
and configuration before enabling the money triggers. `auth.sql` provides only
synthetic authenticated session claims. The disposable `postgres` owner matches
the Mint's existing database-trigger owner condition. This is not proof of
production signup, HTTP/JWT verification, or the complete production RLS graph.
No production user rows or credentials are present.

The maintained daily probe now uses nonreserved local UUIDs because the former
all-zero prefix is deliberately classified as certification equipment by the
real eligibility guards. Its milestone setup inserts matching `auth.users`
parents before profiles. These are the only changes to the recovered probe;
every financial assertion remains byte-identical. The funding probe is unchanged.
There are no runtime SQL substitutions, false-return eligibility helpers, Horse
exceptions or replacement money writers.

The runner executes both maintained probes directly. Funding succeeds only at
its exact deliberate rollback exception, naming both Union and Club results;
another SQL failure is not success. Daily Bonus requires its complete original
PASS notice and exit zero, including the original deferred-constraint assertion.
Both executions reject unexpected warnings/errors and compare every public/auth
table before and after rollback. Nontransactional PostgreSQL sequence advances
are excluded from those row comparisons.

The captured trigger predicates remain intact. The bank-fallback extension adds
only the actual invoice, message, notification and outbox schema/functions reached
by the shared payout writer, plus their declared foreign-key and policy creation
dependencies. `schema-provenance.json` and `function-provenance.json` bind the
read-only catalog and original owner/grant metadata. No outbox worker runs.
The added tables remain subject to their original constraints and triggers.

The third maintained probe pays from Promo first, consumes exactly a one-cent
Main Bank shortfall, and exercises empty-Promo payments under all four game
payout categories, for both Union and standalone Club hosts. It checks physical
journal-store identity, logical invoice-party identity, stored player balances,
actual invoice/message/notification records, and unrelated host/affiliated-Club
wallet isolation. Insufficient combined cover must leave every public/auth row
unchanged. Deferred constraints must succeed before the complete PASS notice;
the runner also requires exit zero, completed rollback and identical row snapshots.
These are shared-writer checks, not full browser playthroughs of the four games.

The fixture does not exercise tournament settlement, rake-wallet credits, agent
or credit workflows, reminder scheduling, live push delivery, or production RLS.
Their declared but unexercised trigger branches remain intact. The original two
probes retain their complete funding-identity, claimed-ticket, canonical-Mint,
entry/settlement, replay, welcome-independence and private-permission assertions.

The existing CI classifier sends changes to all three probes, their financial
client callers, and this fixture to the existing accounting PostgreSQL job. No
new workflow, scheduled task or alternative financial implementation is added.

The wheel-v2 extension loads `wheel-v2-dependencies.sql` and the thirteen exact
current production preimages in `wheel-v2-current-preimages.sql` before the new
inactive migration. The migration checks all thirteen definition hashes before
replacing them. `wheel-v2-provenance.json` records the read-only catalog captures,
ACLs, source hashes, trigger definitions and pricing schema. The Choice immutable
trigger and actual inventory delivery triggers execute; cosmetic-only trigger
branches remain intact but unexercised. The three inventory price rows are
synthetic copies of the approved 1/5/5 per-use model.

`diamond-wheel-funded-awards.sql` activates v2 only inside its rolled-back
transaction. It selects deterministic, production-shaped 64-hex seeds for all
twelve primary slots and four Upgrade outcomes, then executes real authenticated
starts, replay and actions for all four games, including 7,500-diamond upgraded
Double Down budgets. It independently sums the immutable model at all 2,476
entry sizes, verifies the configured funding boundary, canonical custody and
inventory spending, protected prize reservations, failed-start rollback, foreign
award refusal, exact request identity, claimed Mint entry and separate welcome.
The 40x ordinary / 30x upgraded reservation threshold covers Steady's complete
20x table including one original-entry Double Down. `WHEEL_SAMPLE` notices are
actual RPC receipts for the client parser integration, never production records.
All prior probes still run, and the runner again requires exact all-table rollback.

The additive v3 migration follows the preserved v2 probe, with a new baseline
snapshot for its inactive release row. `diamond-wheel-upgrade-eight.sql` proves
all twelve primary slots and eight weighted Upgrade slots, the independent 80%
model across every 25–2500 entry, 2500 chips from the 100x prize (Promo 100 plus
Main Bank 2400), exposure/real-cover refusal before payment, prepaid four-game
Double Down, claimed Daily 100x with Mint entry only, Welcome 100x with no entry
transfer, and unchanged historical v2 replay. The actual captured history RPC in
`wheel-v3-history-dependency.sql` returns the mixed version receipts. Its source
hash/ACL and exact candidate qualification are in `wheel-v3-provenance.json`.
All monetary probe effects are rolled back, with the maintained all-row check.

The v3 probe now sets the authenticated `request.jwt.claims` role as PostgREST
does. `SET ROLE authenticated` alone was insufficient: a nested SECURITY DEFINER
writer becomes `postgres`, and an absent JWT made the real service-context helper
take its privileged branch. The real profile trigger was present but its browser
guard was therefore not exercised. With the JWT present, the old guard rejects
the wheel owner credit with SQLSTATE 42501. Migration `20260918225134` admits only
the reviewed `fn_wheel_spin_v2` caller, preserving all other guard text and ACLs.
The same full v3 probe now executes every primary/Upgrade prize and all four
bonus games with that guard active. Additional assertions reject direct currency
and VIP writes, verify the diamond mirror cannot be changed independently, and
refuse direct authenticated access to the private ledger writer.
`wheel-guard-dependencies.sql` carries the exact read-only declaration-function
capture and empty isolated stores, allowing the migration's real guard-history
declaration to execute. No production user, session or currency is used.
