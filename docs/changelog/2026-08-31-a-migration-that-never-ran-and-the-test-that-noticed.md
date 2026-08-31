# 2026-08-31 — A migration that never ran, and the test that noticed

Main was red on three tests. Fixing that came before my own work (CLAUDE.md
section 5, rule 8), and one of the three turned out to be pointing at a live
data-correctness gap rather than at itself.

## 1. The buy-in columns: the code shipped, the migration did not

`tests/unit/theCreateTableFormOffersOnlyLiveSwitches.test.ts` asserted that
`TableConfigPage` still writes `min_buy_in_bb` / `max_buy_in_bb`. It no longer
does, and the code's own comment explains why: those columns became
`GENERATED ALWAYS ... STORED` in
`20260831133000_one_buy_in_band_and_the_rest_are_derived.sql`, so writing one
would raise 428C9.

**Except the migration had never been applied.** It is absent from
`supabase_migrations.schema_migrations`, and production still had all four
columns plain, still carrying the `2` / `25` DEFAULT from
`010_table_configuration.sql` on 103,684 of 103,690 rows.

So the companion code change was live while the schema change it depends on was
not. The writer that used to stamp those columns was gone, nothing generated
them, and the next cash table created through that page would have carried
`min_buy_in_bb = 2, max_buy_in_bb = 25` on a table selling 40-200 BB — with
nothing left in the product to correct it. That is the exact harm the migration
was written to end, reintroduced from the other direction.

It had not bitten yet: 161 tables were created in that window and every one was
a tournament row, which derives to NULL by design. The harm was latent, not
realised.

**Why nothing caught it.** `check-migrations-applied` compares a branch's
migrations against the schema manifest, and the manifest lists table and
function NAMES. This migration adds no object — it alters four existing columns
— so there was nothing for the gate to miss. The stale unit test was the only
thing in the estate that noticed, and it noticed by accident.

**Applied it.** Pre-flight first, per `.agent/workflows/migration-safety.md`:
16 running cash tables, none with a zero or null blind, none with a null band,
all 16 deriving to exactly (40, 200) — so both of the migration's own
assertions would hold. The author's `lock_timeout = '4s'` was left exactly
where it was; their note says "if it times out, run it again; do not raise the
timeout", and it did time out on the first attempt (rolled back clean, nothing
changed) and succeeded on the second. That contention is presumably why it
never landed in the first place.

After: all four columns `GENERATED ALWAYS`, zero disagreements between the
three column families, zero running cash tables off the 40-200 band, and zero
rows left carrying the false 2/25 default.

The test is now inverted rather than deleted, in a `DERIVED_AND_UNWRITABLE`
list of its own. That distinction matters: the columns are still READ
everywhere, so filing them under the existing "no longer writes" list would
have recorded something false about why. A positive pin on the canonical
`min_buy_in` / `max_buy_in` pair was added alongside, so deleting the real band
cannot turn the block green.

## 2. A source pin bounded by a magic number

`tests/unit/noFixedSizeSourceWindows.test.ts` is a gate: a source pin may not
be bounded by a character count, because a window that drifts off the end of
what it guards can drift while staying GREEN. `satelliteSecondWinIsNeverZero`,
merged an hour earlier in #2209, took a `SRC.slice(at, at + 2600)` window.

Converted to `sliceEnclosingBlock` anchored on the award RPC — a structural
bound, which is what the gate asks for. Its six assertions still pass, so the
block genuinely contains what the fixed window was reaching for.

The gate's own header predicted this: "MORE WERE ADDED BY OTHER AGENTS WHILE
THAT WAS HAPPENING, which is the whole argument for this file."

## Verification

`npx vitest run` on the full client suite: 740 files, 10,384 passed, 2 skipped,
0 failed.
