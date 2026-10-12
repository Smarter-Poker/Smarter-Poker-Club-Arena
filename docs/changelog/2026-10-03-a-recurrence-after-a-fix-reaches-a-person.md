# A recurrence after a fix reaches a person (2026-10-03)

Phase 5 of 9 (alerts reach a person). Migration `20261003101407_a_recurrence_after_a_fix_reaches_a_person`, live as schema_migrations `20261003101511`. The recorded text is byte-identical to the repo file.

## What was wrong

`fn_ca_incident_notify` records each page against the finding in `ca_incident_notify_ledger`. It pages again only when the finding's state hash changes. That is the law of 2026-09-01 (`tests/one-page-per-finding.law.test.ts`), and its own proof included "resolved, then recurs -> 1": a resolution wrote the ledger with kind `resolved`, so a recurrence carried a new state and paged.

On 2026-09-06, "a fix is not a page" moved the resolved case in front of the ledger write. The push for a fix was rightly withheld, but the re-arm went with it. From then on, a finding that came back after its fix carried exactly the state it had last been paged with, and was filed as `already_reported`.

Read from production on 2026-10-03, over 14 days of `ca_incident_events`:

- 29 critical recurrences passed every gate (critical, money in doubt or a named liveness finding) and still reached nobody.
- 28 of them came after their earlier incident had been resolved. The oldest was muted against a page sent on 2026-09-05.
- Among them:
  - the kill switch, -2,624.78, on 09-21 and 10-02;
  - the unexplained chip supply, -100,005.30, on 10-02;
  - the ledger replay and the nightly reconcile for the same treasury;
  - the liveness findings for tables that cannot deal (4) and for orphaned running tournaments (6).

## What changed

The ledger's conflict update now also fires when the incident being notified is a different incident from the one last paged, and that earlier incident is resolved or no longer exists. That is a new episode, and it pages once.

Everything else stays as it was:

- a repeat call for the same incident does not page;
- a second open incident for the same finding does not page;
- a fix, a warning and a 0.00 are still withheld before the ledger is touched;
- no clock or time window enters the decision.

`fn_ca_incident_notify` is a watched guard, so the migration declares the redefinition through `fn_ca_declare_guard_redefinition`. No chips moved, nothing was backfilled, and no job was added.

## Proof

- **Rehearsal on production, rolled back.** One MCP call ending in `RAISE`. The successor was built from the live text as a `pg_temp` function, and both senders were driven through the same synthetic incidents:

  | case                               | installed | successor |
  | ---------------------------------- | --------- | --------- |
  | first raise                        | 1         | 1         |
  | same incident again                | 0         | 0         |
  | second open incident, same finding | 0         | 0         |
  | the fix                            | 0         | 0         |
  | new incident after the fix         | **0**     | **1**     |
  | that recurrence again              | 0         | 0         |
  | a warning                          | 0         | 0         |
  | a 0.00 critical                    | 0         | 0         |

- **Live.** The `@live-proof` md5 `0abfd723b4d2e129d5038e6b849c6288` is true, and the reverse substitution reproduces the pinned predecessor.
- **Law.** `tests/a-recurrence-after-a-fix-reaches-a-person.law.test.ts` pins the migration, the exact condition added, the guard declaration and the rehearsal. It also forbids any clock or notifications-table read in the new clause.
