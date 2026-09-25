# Declare the recognized bank receipt guard (2026-09-18)

## What was wrong

`UndeclaredTriggerOnAMoneyTable` was firing critical with `page: sms`, and had been since the accounting release went in:

```
fn_undeclared_money_triggers() ->
  chip_ledger | accounting_tournament_recognized_bank_immutable
              | fn_accounting_tournament_recognized_evidence_immutable
```

`ca_declared_money_triggers` held 216 rows, and the convention written into its 2026-09-12 baseline note is that "anything created after this date declares itself in its own migration". This trigger did not. The alert means "a trigger may be live on `chip_ledger` that nobody reviewed", which is worth exactly as much as the accuracy of that table. A legitimate guard sitting there undeclared spends the alert's credibility for nothing, and it had been spending it for hours alongside 3,075 other unread criticals.

## What it actually is

On `chip_ledger` the trigger fires `BEFORE DELETE OR UPDATE ... FOR EACH ROW` and does one thing: if the row is the `bank_journal_id` of a recorded `accounting_tournament_fee_recognitions` row, it raises `recognized_tournament_fee_bank_receipt_is_immutable`. Otherwise it returns `OLD` or `NEW` unchanged. It writes nothing and moves no chips. It stops a recognized tournament fee's bank receipt from being rewritten after the fact, and it is the `chip_ledger` half of a pair whose `rake_records` half protects the fee evidence itself.

## What changed

One row in `ca_declared_money_triggers`, with a note recording what the guard does and that it was reviewed rather than assumed.

A declaration asserts a review, so the migration proves what it is asserting before it writes. Its preconditions pin the trigger's exact definition, and that its function contains no `INSERT INTO`, no `UPDATE ... SET` and no `DELETE FROM` — a guard that can write is not a guard, and this row says it is one. The postcondition is that `fn_undeclared_money_triggers()` returns nothing at all.

The rollback removes only the declaration row. It does not drop the trigger: that belongs to the accounting release, and dropping it would leave a recognized fee's bank receipt rewritable, which is the opposite of what rolling back a declaration should do.

## Verified

Dry run with `COMMIT` replaced by `ROLLBACK` first: `BEGIN / DO / INSERT 0 1 / DO / ROLLBACK`, so both preconditions and the postcondition were satisfied before anything was committed. Applied at 04:18:09 UTC, outside the `:50`-`:03` DDL break window. After it, `fn_undeclared_money_triggers()` returns 0 and `ca_declared_money_triggers` holds 217 rows. Recorded in `supabase_migrations.schema_migrations` as version `20260918041452`, with its statements array populated the same way as the migrations before it.
