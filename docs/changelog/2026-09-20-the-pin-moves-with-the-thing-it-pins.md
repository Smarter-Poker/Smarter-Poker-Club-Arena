# The pin moves with the thing it pins (2026-09-20)

PR #4978 went red on four checks after the cash settler's batch sizes were
re-derived. None of the four was a disagreement about the settler. Every one
was a RECORD that had been written down beside a thing, and had not moved when
the thing did. That is the same defect the pull request itself is about, three
more times, so it is worth writing down rather than just fixing.

The failing checks, and what each was actually saying:

| check                             | what it said                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------- |
| `Every pinned source stays bound` | `RakebackSettlerService.ts` no longer hashes to its reviewed bytes                    |
| `Client Unit Tests shard 4`       | the same pin, plus two migrations that redefined a watched guard without declaring it |
| `Server Engine shard 1/4`         | the dealing client's deadline "is" 50,000 ms                                          |
| `What this run verified`          | the rollup of the above                                                               |

## 1. The binding pin, restamped against the merged tree

`tests/fixtures/private-cash-earning-scope/source-binding.json` pins the exact
bytes of `server/src/services/RakebackSettlerService.ts` that the private cash
earning scope qualification was reviewed against. This branch changed that
file, so the pin was stale and the check was correct to refuse.

**It had to be restamped against the MERGE, not against the branch.** CI checks
out `refs/pull/4978/merge`, and while this branch was open, #4979 landed on
`main` — the tournament sentinel repair, in the same file, restamping the same
pin from `31a9394a…` to `29c9ee64…`. Stamping the branch's own bytes would have
produced a third hash that matched neither side. `origin/main` was merged in
first (`git merge`, never a rebase — section 12), and the pin now records the
merged bytes, `db27d7c0…`, which is what CI hashes.

The audit block `cash_accounting_batch_budget_rebinding_20260920` records the
diff that was read before the restamp: two batch sizes, both derived from
`cashAccountingBatchSize(resolveClientTimeoutMs())`, both resolving to 31 at the
shipped 15,000 ms client budget; no rate, bank destination, refusal reason,
commission, statistic or payout behaviour changed, and `fn_cash_earning_club`
and the recorded-seat-scope attribution this qualification reviews are not
touched by the diff. A batch size decides how much work one call carries, never
what a call decides.

## 2. The dealing deadline moved house, so its law moved with it

`server/src/services/HorseFleetSeedCycleFinishesInsideItsTick.test.ts` protects
an arithmetic relationship: the seeding client gives up at 5 s, the dealing
client at 15 s, the seating budget is 18 s, and 18 + 5 + 3.5 < 30 so the next
seeding tick always fires. It read both deadlines out of `supabase/client.ts`
with

    new RegExp(`${name}\\s*\\?\\?\\s*([0-9_]+)`)

This branch moved the dealing deadline's default into `resolveClientTimeoutMs()`
in `cashAccountingBatchBudget.ts` — same environment variable, same 15,000 ms,
one definition, and out of the client module because four suites mock that
module and a constant imported through a mock disappears.

**The regex then matched something else and answered anyway.** It is not
anchored, `SUPABASE_TIMEOUT_MS` is a substring of
`MAINTENANCE_SUPABASE_TIMEOUT_MS`, and the maintenance client's deadline is
`?? 50_000`. So the law did not report "the number I was reading is gone"; it
reported that a dealing call is abandoned at fifty seconds. A signal that
answers confidently when it cannot tell (CLAUDE.md 10.86 rule 1).

The pin moved to the new mechanism in the same commit, as 10.6 requires, and it
got stricter rather than looser:

- the dealing bound is read from `DEFAULT_CLIENT_TIMEOUT_MS`'s own `const`
  declaration, through a reader anchored on `\bconst ` so it cannot silently
  slide onto a different constant again;
- a new case pins that `client.ts` still IS that budget —
  `const DB_TIMEOUT_MS = resolveClientTimeoutMs()`, importing it from the budget
  module, with no numeric literal and no `process.env.SUPABASE_TIMEOUT_MS` of
  its own. One definition is the whole point of the move; two numbers that
  happen to agree today is the defect it was made to prevent;
- the operator-override case pins that the budget still resolves that same
  environment variable, via its `= process.env` default parameter.

## 3. Three migrations that create no object now say how to see them

`tests/a-merged-migration-must-be-live.law.test.ts` binds from 2026-09-20: a
migration that creates no persistent object must declare
`-- @live-proof: <boolean SQL expression>`, because nothing else can tell whether
production carries it. Three migrations on this branch create nothing — two only
`REVOKE`/`GRANT` and set rows, one replaces two function bodies by asserted
substitution — and none declared a proof.

Each now does, and **each expression was run against production before it was
written down**; all nine return true:

- `20260920180734` — one per correction: the four settlement-period doors are no
  longer executable by `authenticated`, the retired BBJ cron's
  `ca_guard_inventory` row is inactive, the orphan union-scoped period is closed,
  and no prize row for that member is left without a club.
- `20260920192513` — the migration's own two post-conditions:
  `fn_ca_autoledger` reads the declared club, and `fn_diamond_game_pay_chips`
  sets the GUC it reads.
- `20260920193128` — neither board writer is reachable by `anon` or
  `authenticated`, and both are still reachable by `service_role`. Both halves,
  because a revoke that also locked out the cron would be a different bug.

These are comments. They change nothing that ran.

## 4. Two guard redefinitions, recorded forward rather than rewritten

`20260920183008` replaced `fn_ca_incident_escalation_tick` and `20260920192513`
replaced `fn_ca_autoledger`. Both are on `fn_ca_guard_watchlist()`, and neither
called `fn_ca_declare_guard_redefinition` in its own transaction, which
`20260910143032` requires. So `fn_ca_guard_defs_watch` did exactly its job:
observed a hash nobody had named, moved the baseline itself, and opened an INFO
notice for a person to close by hand. Read from production:

    466ebf15-8501-4c3f-b052-72b5d3311812  19:25:00Z  fn_ca_incident_escalation_tick
    f95556fc-e0d4-4f01-b73b-42b1c443f7ae  20:25:00Z  fn_ca_autoledger

Both baselines are already at the live definition; both carry
`declared_ref IS NULL`, which is how you tell a change the watcher observed from
one a migration recorded.

**The omission was not repaired by editing the two migrations,** and this is the
part worth arguing rather than asserting. They are installed byte for byte —
`schema_migrations` holds 36,406 and 36,391 characters against files of 36,407
and 36,392, the difference being the trailing newline the apply transport
strips. Adding the call to either file would put a statement in this repository
that production never ran; it would not move `declared_ref`, because an applied
migration is not applied again; the file would claim the declaration happened
and the database would disagree; and a rebuild from these files would diverge
from production with nothing to notice it. The check would go green and the two
notices would stay open for ever, which is the failure mode the second of those
migrations is itself named after.

So it is recorded forward, in the shape this repository already has for exactly
this case (`20260918014359_declare_the_installed_original_club_funding_guard.sql`):
`20260921003008_declare_the_two_installed_board_guards.sql` declares both, and
refuses rather than blessing unknown drift if the installed history digest, the
live definition, the owner, the grants, `fn_ca_autoledger`'s eleven triggers, or
`fn_ca_declare_guard_redefinition` itself is not what was read when it was
written. It carries no DDL, so the break-window triggers do not apply to it and
it reloads no schema cache.

`tests/a-declared-guard-change-is-recorded-not-raised.law.test.ts` now keeps a
BOUND LIST of installed omissions instead of a single hard-coded one. It is not
a waiver, and the four hashes are the difference: an entry names one original
file, the one guard it failed to declare, and one successor, and pins the exact
bytes of both files. Change a character of either, point an entry at a second
guard, or remove the successor, and the pardon evaporates. The two negative
tests now run per entry and additionally prove that one entry's successor never
pardons another entry's original; the successor-shape test runs per entry too,
and from 2026-09-20 also requires the successor to carry a `@live-proof`.

**Still owed, and it is a person's job, not a file's.** The migration above has
NOT been applied — this session had no authority to apply anything — and the two
INFO notices are still open on the board. Applying it sets `declared_ref` on both
baselines; closing the notices is separate and deliberate, because a notice that
closes itself is not a notice.

## What was not a failure

`tests/legacyEngineCheckpointTransport.test.ts` fails on this workstation with
`The input did not match the regular expression /^v(?:20|22)\./. Input: 'v26.3.0'`.
That is Homebrew's node in front of nvm's on a non-interactive PATH, not a
defect: `Client Unit Tests` runs on node 20. `src/benchmark/HorseLeagueProcessPriority*`
fails locally with `expected 'darwin' to be 'linux'` for the same class of
reason. Both pass on the runners. Worth knowing before somebody "fixes" one.
