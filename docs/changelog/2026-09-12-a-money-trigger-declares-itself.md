# A Money Trigger Declares Itself

**2026-09-12** · `ca_declared_money_triggers`, `UndeclaredTriggerOnAMoneyTable`

## The Alarm That Had Been On Too Long To Mean Anything

`UndeclaredTriggerOnAMoneyTable` is critical severity and pages by SMS. Its own
description says what is at stake:

> Either it is a legitimate change missing its declaration, or it is an
> unreviewed one, and the last unreviewed one broke a third of all hand
> settlements.

It was reading **76**. Ninety minutes earlier in the same session it read **74**.

| Table                | Undeclared |
| -------------------- | ---------- |
| `tournaments`        | 26         |
| `table_seats`        | 23         |
| `tournament_players` | 15         |
| `chip_ledger`        | 8          |
| `club_members`       | 3          |
| `club_wallets`       | 1          |

The register is not abandoned: 115 triggers **are** declared. What failed is the
discipline of declaring, and the alarm meant to enforce it saturated long ago.

A critical page that has been on for weeks is not a signal. The seventy-seventh
undeclared trigger looks exactly like the seventy-sixth, which is to say
invisible, and it is the seventy-seventh that this alarm exists to catch.

## Why Counting Was Never Going To Work

Nothing stopped a trigger reaching a money table undeclared. No CI gate
mentioned `ca_declared_money_triggers` or `CREATE TRIGGER` at all. The only
consequence of shipping one was that a saturated counter went up by one.

That is the whole defect. The register was enforced by a number that only ever
grows, read by people who had already learned the number means nothing.

## The Change

**`scripts/ci/check-money-trigger-declared.mjs`** refuses a migration that
creates a trigger on any of the nine tables `fn_undeclared_money_triggers`
watches without declaring it in the **same** migration:

```sql
INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES ('table_seats', 'my_new_guard', 'what it guards, and why it is safe');
```

Same migration, deliberately. A declaration promised for a later one is exactly
what produced seventy-six of them. Wired into CI and into pre-push, with the
directory's usual escape hatch for a trigger that genuinely must not be
declared, costing a written reason of at least forty characters.

The gate does not review the trigger. It cannot. It enforces that somebody wrote
down what the trigger is for at the moment they added it, which is the thing the
register was built to hold and the one thing nobody can reconstruct afterwards.

## The Baseline, And What It Honestly Claims

One migration brings the register level by reading the live catalogue:

```sql
INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
SELECT u.table_name, u.trigger_name, '...'
  FROM public.fn_undeclared_money_triggers() u
ON CONFLICT (table_name, trigger_name) DO NOTHING;
```

The note records that each trigger was live and known on 2026-09-12. It does
**not** claim anybody re-read all seventy-six, because nobody did, and a note
claiming otherwise would be worth less than no note.

Seventy-six triggers cannot be reviewed retroactively by anyone. The
seventy-seventh can be stopped before it ships, and that is the trade this
makes.

It reads the catalogue rather than listing names because two triggers arrived
between the first count and the migration being written. Reading at apply time
declares exactly what is live at apply time, which is the only set it can
honestly speak for. The migration then **fails** if any undeclared trigger
remains, so the gate cannot begin life measuring from a moving baseline.

Dry run against production inside a rolled-back transaction:

```
BEGIN
INSERT 0 76
NOTICE:  money trigger register: 0 undeclared, 191 declared in total.
         UndeclaredTriggerOnAMoneyTable can fire on the next one.
DO
ROLLBACK
```

## Pins

`tests/a-money-trigger-declares-itself.law.test.ts`, eleven cases.

The one worth naming: a migration that writes to the register but names a
_different_ trigger is still refused. Without that case the gate would pass any
migration that touched the register at all, which is the same "close enough"
that filled it with seventy-six gaps.

The nine watched tables are pinned as a list, so a table added to the database
function and not to the gate fails a test rather than silently dropping out of
coverage.
