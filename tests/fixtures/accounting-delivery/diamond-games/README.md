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

The captured trigger predicates remain intact. These probes do not exercise
tournament settlement, rake-wallet credits, manual journal mutation, or the
bank-shortfall invoice branch: the synthetic Promo wallets cover the original
Wheel prizes. Their real root trigger definitions are retained, but unrelated
branch dependency programs are not imported. This fixture does not certify those
paths or live financial behavior. The original complete assertions do exercise
funding identity, claimed-ticket issuance, canonical Mint refusal, atomic entry
funding/settlement, replay, welcome independence and private-door permissions.

The existing CI classifier sends changes to these two probes, their financial
client callers, and this fixture to the existing accounting PostgreSQL job. No
new workflow, scheduled task or alternative financial implementation is added.
