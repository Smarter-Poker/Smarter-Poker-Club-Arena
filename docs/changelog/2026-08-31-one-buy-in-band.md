# One buy-in band, and the rest are derived

**2026-08-31 — Phase 2 of the live cash games audit, item 2A**

## What was wrong

`public.tables` carried three pairs of buy-in columns and they disagreed on
every live cash table. Measured on production, on a 1/2 table:

| pair                              | value          | unit              | read by                                     |
| --------------------------------- | -------------- | ----------------- | ------------------------------------------- |
| `min_buy_in` / `max_buy_in`       | 80.00 / 400.00 | chips (40-200 BB) | `atomic_table_buyin`, the engine, the lobby |
| `min_buyin` / `max_buyin`         | 40 / 200       | big blinds        | nothing                                     |
| `min_buy_in_bb` / `max_buy_in_bb` | 2 / 25         | big blinds        | nothing                                     |

Which pair is real is settled by evidence, not preference. `atomic_table_buyin`
is the only hard enforcement of a buy-in anywhere in the product and it reads
`min_buy_in` / `max_buy_in`. So do `ServerTableEngineBase`, `Dealing` and
`Settlement`, `src/lib/cashBuyIn.ts` and its server mirror. A census of the
database found no function, view, constraint or policy touching the other four
columns, and a search of both repositories found exactly one writer:
`TableConfigPage` stamped `min_buy_in_bb` / `max_buy_in_bb` on every table it
created, in big blinds, one line below a sibling it wrote in chips.

The 2 / 25 is not a stale copy of the truth. It is the **default** from
`010_table_configuration.sql`, still sitting on 103,684 of 103,690 rows. A
reader that picked `max_buy_in_bb` off a 1/2 table would have capped a player at
50 chips on a table advertising 400, and nothing in the schema would have
stopped it, because the column looks authoritative. That is the shape of the
seat-law bug from PR #2012: a column that reads like configuration, is written
by a real product surface, and is wrong.

`20260828_cash_buyins_are_40bb_to_200bb.sql` set out to end this — its own
comment says the vestigial columns are resynced "so the two column families
cannot disagree". It resynced the six rows its `WHERE` clause touched and left
the other 103,684 on the defaults. Resyncing was the wrong tool: a copy that has
to be maintained drifts again on the next insert.

## What changed

`20260831133000_one_buy_in_band_and_the_rest_are_derived.sql` turns the four
orphans into `GENERATED ALWAYS ... STORED` columns computed from the canonical
pair. They keep their names and types, so every `SELECT` anywhere — including
clients outside these repositories — keeps working and starts returning the
truth, and Postgres refuses a write to them, so a fourth writer of a fifth
opinion cannot be added.

Rounding is conservative in the direction that cannot mis-sell a seat: the floor
rounds up, the ceiling rounds down. A naive reader of the derived pair can never
offer a buy-in the RPC would refuse.

Tournament rows derive to `NULL`. Their `0/0` is legitimate and a tournament
table has no cash buy-in band; `NULL` says that, where a stamped `2/25` said
something false.

They were not dropped. Dropping is cheaper — metadata only, no rewrite — and
nothing in either repository would notice. It is still the wrong call: a `SELECT`
list in a dashboard or a PostgREST client outside these repositories would break
with no way to see it coming, and the failure would land on whoever is on shift.

`TableConfigPage` stops writing the derived pair; it would now raise `428C9` and
take table creation down. `tests/unit/buyInBandIsOneColumnPair.test.ts` scans
`src/` and `server/src/` for any object-literal write to a derived column, pins
that the page still authors the canonical pair in chips, and pins the migration
itself.

## Ordering

The migration must be applied **after** the client change is live. Applying it
first leaves a window in which `TableConfigPage` writes a generated column and
table creation fails.

## Verification

- Derivation dry-run across all 103,690 rows: every one of the 972 cash rows
  derives to exactly 40 / 200, against the 2 / 25 stored today.
- Generated-column behaviour probed on a temp table: the six boundary rows
  (standard band, sub-unit blinds, the incoherent 25/50 row, zero blinds, null
  columns, a tournament row) all derive as specified, and a write to a generated
  column is refused.
- `tests/unit/buyInBandIsOneColumnPair.test.ts`, `cashBuyInMirror.test.ts` and
  `noFixedSizeSourceWindows.test.ts` pass.
