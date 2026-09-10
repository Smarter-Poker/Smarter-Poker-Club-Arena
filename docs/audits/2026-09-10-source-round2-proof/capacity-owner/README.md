# Prospective source funding / Round2 capacity checkpoint

This is an unactivated SQL candidate and native proof, not a production migration.
It builds on the earlier 17-group prototype at
`b6355d2169a03c908e5a69aca39894f7047671ee`, replacing its insufficient
positive-treasury assumption with immutable bank admission, released cash receipts,
and explicit consumption. No historical commission row is admitted or backpaid.

The shared contract has four separate facts:

- Source lots retain the accepted generation/hash, original booked club/Union/route,
  captured rate, UTC earning week and Pacific bank window.
- Explicit admissions preserve closed-period cadence even when no cash cent is due.
  Compatible pools carry fractions across windows; a later request for an older
  boundary cannot discard previously admitted rights.
- Actual club cash releases have immutable source attribution slices. These slices
  are reporting allocations, not independent tiny wallets.
- Agent cash payments consume the matching pool's real release receipts and retain
  exact recipient/source/week slices. Cumulative provisional payment is floored;
  fractions remain owed.

The existing 70% agent producer/storage policy and captured hierarchy margins remain
unchanged. A valid club right can release even when its agent hierarchy is
overpromised; that hierarchy receives no eligible recipient accrual. Intentional
Union-self retention remains distinct from unresolved source terms.

`03-capacity-assertions.sql` binds source facts, admission sequence prefixes,
recipient identity, source slices, actual treasury/wallet/ledger witnesses, and
release consumption. Actual Round2 ledger rows retain the original Union and
booked club. Linked money evidence is immutable even in maintenance context.
`04-agent-payment.sql` credits the same club-membership allocation wallet from
which the captured player payer debits; it does not credit an unrelated global
wallet or agent business balance.

## Reproduce

After the upstream audit checkpoint directories are present in the same checkout:

```sh
bash docs/audits/2026-09-10-source-round2-proof/capacity-owner/run-local.sh
```

For isolated review trees, set `ROUND1_FIXTURE` to the sibling payer lane's
`docs/audits/2026-09-10-rakeback-payer-proof/round1-owner` directory.
The runner copies all fixture inputs into a private temporary directory, overlays
these exact capacity stages and actual dependency captures, and runs PG17 on a
private Unix socket. It never writes another agent's checkout or a live database.
The fresh actual support catalog includes the cash batch, treasury debit/credit
wrapper, Union calendar/overseer, ledger idempotency relation and membership ladder
dependencies. The source bank checkpoint is
`02377511fa3d23185704176439ca9f09ed135f36`; the precise fixture versions actually
executed are recorded in `native-proof.json`, including derived schema hashes.

The fixture installs 122 captured tables, 231 captured functions and 175 captured
enabled triggers, plus candidate/fixture functions and triggers. It preserves
captured FK/check/index definitions and reports no missing foreign tables. This is
the exercised native dependency graph, not a claim to clone every production object.

## Evidence boundary

Current unchanged accepted/bank owner emission proves open-period refusal.
Closed-week tests use explicitly synthetic fixture-only INSERT timestamp stamps on
accepted and bank money records; they are not evidence of historical owner emission.
Synthetic users, balances, small hand input builders and auth shims remain fixture
inputs. Actual accepted owner, bank owner, cash batch, treasury functions and
captured financial/management trigger bodies execute unchanged.

`native-proof.json` lists the exact passing groups, runtime and SHA256 inputs.
Coverage includes 100 sequential penny sources across earning/bank weeks, exact
weekly attribution, source-specific overpromise refusal, late older-window carry,
deactivated recipients, moved-Union isolation, actual money rollback, malformed
money witnesses, exact account-bound replay and funded concurrency with observed
shared advisory-lock barriers.

## Remaining activation gates

This branch remains an audit archive. It is not safe to activate these SQL files
independently. Required coordinated work includes legacy Round1 bank-leg exclusion,
legacy Round2/direct-claim exclusion of compatibility projections, the reviewed
player bridge/getter/claim capability and UI contract, actual outer Union cascade
composition, common source/bank/funding finality and prospective residual policy.
Representative production-scale query plans and the complete legacy/new owner lock
graph remain release checks. A positive wallet, calendar boundary or immutable
high-water sequence is not a finality witness.

The parent audit owns integration and publication. The approved
`backup/resume-poker-sep10/source-round2` branch is archival only.
