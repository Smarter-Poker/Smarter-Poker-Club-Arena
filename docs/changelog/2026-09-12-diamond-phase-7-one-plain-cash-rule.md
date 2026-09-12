# Diamond Phase 7: One Rule Says What A Plain Diamond Cash Table Is

Status: Phase 7 In Progress. No Checklist Line Is Claimed By This Work. Public Funded Diamond Games Remain Closed And `cash_games_enabled` Remains False.

## Six Copies, Six Answers

"Is this a plain Diamond cash table" was answered in six places: five SQL functions and the engine's TypeScript boundary. Measured on production this morning, by md5 of the clause alone, the five SQL copies had five different values and three materially different answers.

| function                                  | reads `rake_cap_bb` | requires the run-it columns stated | refuses straddles | refuses bomb pots |
| ----------------------------------------- | ------------------- | ---------------------------------- | ----------------- | ----------------- |
| `fn_poker_diamond_buyin`                  | yes                 | yes                                | no                | no                |
| `fn_poker_diamond_top_up`                 | **no**              | **no**                             | **yes**           | **yes**           |
| `fn_poker_diamond_set_table_straddle`     | yes                 | no                                 | no                | **yes**           |
| `fn_poker_diamond_set_table_run_it_twice` | yes                 | no                                 | no                | **yes**           |
| `fn_poker_diamond_set_table_bomb_pot`     | yes                 | no                                 | no                | no                |

Both kinds of error were live at once, and the top-up door carried both.

**Too strict.** It was written on September 12 before straddles, run it twice and bomb pots were permitted, and not one of the three migrations that permitted them lifted its refusal. A Diamond table with any of the three on could be bought into, seated and dealt, and the player could then never top up: `diamond_plain_cash_table_required`, from a door nobody had thought to look at.

**Too loose, which is the direction that costs money.** It read an UNSET rake as zero and never read `rake_cap_bb` at all. UNSET IS NOT OFF in this arena, which is why the admission door was corrected earlier the same day: the engine reads an absent column as the CHIP schedule's default, so a table admitted on a NULL is a table the engine then refuses to load, with the player's Diamonds already reserved into a seat that cannot deal.

Nothing live was affected. All seventeen Diamond tables are `waiting`, with all four columns explicitly stated and every feature off. This is a latent break of the features that shipped hours earlier, closed before anything could reach it.

## The Rule Now Lives Once

`fn_poker_diamond_plain_cash_table(public.tables)` is the single answer, and it is the buy-in door's rule, which was the correct one. Every Diamond money door and every staff door reads it.

The two money doors were edited **in place** rather than restated. The clause is read from the live definition, bounded by the structure that holds it, replaced, and re-created, with every step asserted: the function exists, the clause is found exactly once, it ends where the `IF` ends, the result actually changed, and the result calls the predicate. Exact by construction rather than by proofreading, which is how the 34KB settlement function was edited earlier today. A function that already calls the predicate is skipped, so the migration is safe to replay onto a database built from the migration history.

## The Staff Doors Ask A Different Question

Hand-copying the money door's list was the wrong way to answer it. A door that turns a feature ON must refuse a table that would not be admissible **afterwards**, which is not the same as a table that is admissible now, because the door is about to change it.

Each staff door therefore builds the row it is about to write and tests that. The mutual exclusions disappear along with the copies: a straddle can now be turned on at a table that bombs, and run it twice at a table that bombs, and a straddle at a table that runs it twice. All three were refused before, for no reason except the date each door was written.

It also tightens them in two ways, both correct and neither reachable today. A staff door now refuses a table whose run-it columns are unset, unless it is the door that states them; and it refuses a table outside the four live statuses, which the hand-copied clauses never checked.

## The Settler Is Exempt, Deliberately

`fn_poker_diamond_settle_cash_hand` keeps its own narrow check and is not touched. By settlement the hand has already been dealt, and refusing to settle a dealt hand on a feature flag parks the table with the seat stuck: the exact failure the run-it-twice work was written to avoid. It verifies the arena, the variant and the hand's own invariants, and asks nothing about feature flags. The migration asserts that it still does not read the shared rule.

## Evidence

**In the isolated fixture**, 41 checks, all passing. Twenty-two of them are the rule itself, one row per way a table can be right or wrong, including all five UNSET columns and all four permitted features alone and together. Eight are that each door reads the rule and keeps no copy, and one that the settler does not. Four prove the combinations the staff doors used to refuse. Five prove they still refuse what the money door would refuse afterwards, including the one case where the run-it-twice door legitimately does not, because it is about to state the column it is asked about. `tests/sql/run-diamond-plain-cash-rule.py`.

**The fixture is the estate.** The four functions the migration restates carry byte-identical definitions in the fixture and in production, compared by md5 of `pg_get_functiondef` after the apply. The two it edits in place were dry-run against production read-only before the apply (clause found once, ends in `THEN`, replacement length as predicted) and verified after it by length and by the absence of their own copy of the rule.

**And a law for the copy that cannot be shared.** The engine's TypeScript boundary is the sixth copy, in another language in another process, so no SQL function can unify it. `tests/a-diamond-table-has-one-shape.law.test.ts` asserts that both sides decide with the same SIXTEEN columns. It compares the set of columns, not the phrasing: SQL says `IS DISTINCT FROM 0` where TypeScript says `typeof !== 'number' || !== 0`, because a NULL and an absent key are the same fact in two type systems. Checked by mutation: dropping `rake_cap_bb` from the SQL rule turns it red.
