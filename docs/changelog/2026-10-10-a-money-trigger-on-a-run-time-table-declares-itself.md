# A money trigger on a run-time table declares itself

2026-10-10. Follows `2026-10-09-the-unpaid-alarm-reads-every-payout-rail.md`.

## What was wrong

`UndeclaredTriggerOnAMoneyTable` (critical) fired from 2026-10-05 22:18 UTC
until 2026-10-10 05:11 UTC: 26 deliveries for one trigger,
`poker_arena_no_chip_rake` on `club_wallets`.

The trigger is sound. It is the refusal guard migration 20261005183028
(`diamond_cash_rake_reads_the_owner_settings`) put on `rake_records`,
`rake_attributions`, `rake_distribution_legs` and `club_wallets`: any row for a
Diamond club raises `Diamond Rake Is Never A Chip Rake Record` (23514). It moves
no money. It was never declared in `ca_declared_money_triggers`, so the
register read it as an unreviewed trigger on a money table.

The CI gate that exists to stop exactly this, `check-money-trigger-declared`,
passed the migration. The trigger was created in a loop:

```sql
FOREACH t IN ARRAY ARRAY['rake_records','rake_attributions','rake_distribution_legs','club_wallets'] LOOP
  EXECUTE format('CREATE TRIGGER poker_arena_no_chip_rake '
                 'BEFORE INSERT OR UPDATE ON public.%I ...', t);
END LOOP;
```

The gate could not read `%I` as a table, fell back to reading `public` as the
table name, and reported OK.

## What changed

1. Production (approved by Dan 2026-10-09, "Yes, apply it"): migration
   `20261010051104_the_diamond_rake_guard_is_a_declared_money_trigger` adds the
   register row and proves `fn_undeclared_money_triggers()` then lists nothing.
   Recorded byte-exact here with its manifest row.
2. The gate reads a run-time target. A `CREATE TRIGGER` whose table is a
   `format()` placeholder or a `||` concatenation lands on every money table
   the enclosing loop walks (its `ARRAY[...]`, or the array variable's
   `ARRAY[...]`), or, outside a loop, the statement's own literal arguments.
   Each needs its declaration in the same migration.
3. A definition being compared in a proof block
   (`pg_get_triggerdef(oid) = 'CREATE TRIGGER ...'`) is no longer read as a
   trigger being created; a definition assigned with `:=` or `v_sql =` still is.

## How it was measured

Run over every migration in the directory and checked against production's
catalogue: the first version ("any money table the file names") produced 25
table/trigger pairs, of which 15 do not exist in production. Reading the
enclosing loop produces 11 pairs across 5 files, all 10 distinct pairs live and
now declared, none false. `tests/a-money-trigger-declares-itself.law.test.ts`
pins the shapes, including the real 20261005183028 file.
