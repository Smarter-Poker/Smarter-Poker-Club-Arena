# Elimination candidate lookup regression

The September 17 repair resolves the existing VOLATILE knockout resolver once
per owning function, then queries the candidate primary key. It changes neither
resolver volatility nor lock placement. The public ordinary door legitimately
calls two owning functions; successful PKO claims call one.

Run the retained regression through the existing PostgreSQL 17 behavior gate:

```sh
PGBIN=/path/to/postgresql17/bin TMPDIR=/tmp \
  bash scripts/dev/probe-a-bust-is-ranked-by-when-it-happened-pg17.sh
```

The gate creates its own socket-only temporary database, keeps all 27 original
ranking scenarios and rollback checks, then uses a separate clone for
`candidate-lookup.sql`. The unchanged three current elimination functions and
resolver reproduce the actual excessive call count; applying the guarded
`20260917054818_resolve_elimination_candidate_once.sql` migration makes the same
case pass. It checks ordinary acceptance, exact replay, conflicting identity,
indexed UUID lookup, and the PKO rebuy-decision refusal. Four deliberate guard
faults cover body, function ACL, resolver ACL and wrong postimage; a rejected
migration must preserve the entire public function catalog fingerprint.

The existing `accounting_postgres` job in `.github/workflows/ci.yml` invokes this
gate. Its existing server change classification includes `scripts/dev/` and
`supabase/migrations/`, so capture, scenario, runner and migration changes all
select that job. This does not claim a provider CI run has completed.

`candidate-lookup-authority-20260917.json` preserves seven exact function
catalog rows from an authorized read-only capture on Club Arena project
`kuklfnapbkmacvwxktbh`; the reduced gate selects only the three changed functions
and unchanged resolver. `candidate-lookup-tables-20260917.json` preserves real
Diamond-ledger and PKO-watermark metadata. The reduced gate creates an **empty
typed Diamond read relation** for the generation checks. It retains the original
ranking fixture's declared financial, exact-claimant and seat-count doubles.
It does not qualify Diamond purchases, custody, positive PKO causal claims or
bounty payouts.

`candidate-lookup-full-native.sql` is a supporting companion for the separately
executed captured-catalog qualification, not a step run by this CI gate. That
qualification loads real captured authorities and real table constraints/ACLs,
then composes the existing `bounty-rebuy-generation-atomicity.sql` replica seed
with this companion. Only synthetic seed timestamps and complete accepted
rosters are normalized. It proves a positive PKO pending obligation with the
exact five-chip head, its exact replay, missing-history refusal, original scan
versus indexed lookup, and ordinary elimination. No bounty collection is
performed. The task's evidence records exact source hashes, actual red/green
outputs and full data/catalog rollback; this file alone is not qualification.

The migration pins all three function pre/post definitions, bodies, owners,
security modes, volatility, search paths and ACLs, plus the resolver's complete
unchanged authority and candidate primary key. It validates every preimage before
replacement and validates postimages in the same transaction. The private
owner-only core now eagerly resolves even if no pending candidate can survive
its later filter, so a direct malformed owner call can raise an existing
resolver error instead of the earlier generic refusal. The only installed caller
is the public ordinary door, which already proves and locks the candidate; the
public refusal and replay paths remain protected by the regression.
