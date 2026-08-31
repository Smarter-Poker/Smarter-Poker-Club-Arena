# The create-table form and the table it actually creates

2026-08-31. Phases 4 and 5 of the game-creation audit Dan asked for:
"CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING ISSUES
ANYWHERE AND EVERYWHERE."

Every defect here has the same shape. The form said one thing and the row it
wrote said another, and nothing in between ever complained.

## Loading a template left a form that described a different table

`loadTemplate` was one line —
`setConfig({ ...DEFAULT_CONFIG, ...template.config, name: '' })` — and it was
broken four ways at once.

1. **It cleared the name and nothing regenerated it.** The naming effect is
   guarded by `prev.name ||` and keyed on `[gameInfo.name]`, which a template
   load does not change. So Save and Start both bailed on
   `!config.name.trim()` immediately after a "Loaded Template" success toast.
   The owner was told it worked and then could not save.
2. **It ignored `template.game_type`.** The column was written on save and read
   NOWHERE. Templates are fetched for the whole club, so a PLO6 template sat in
   the dropdown of an FLH page; loading it carried PLO6's toggles, stakes and
   seat count onto a fixed-limit table. Worse, a tournament template loaded on a
   variant that cannot be a tournament stranded the form in an unreachable mode
   and `buildTournamentConfig` fell back to `'NLH'` — the owner clicked
   Pineapple and got an NLH tournament.
3. **The blinds slider desynced.** `blindsIndex` is separate state the load did
   not touch. A template carrying 5/10 restored those blinds and left the thumb
   at index 2, so it sat over a label reading "5/10" and any nudge snapped to a
   neighbour of the WRONG preset.
4. **The seat count shown was not the seat count written.** The clamp is an
   effect keyed on `[seatCap, sngSeatCap]`, neither of which a template load
   changes. The header printed "Table Size: 9 max" on a plo6 page while the
   write silently clamped to 6.

The whole decision is now a pure function, `restoreTemplateConfig`, and the
dropdown offers only templates saved for this game (legacy rows with no
`game_type` still appear — refusing those would strand every template an owner
already has). The blind ladder moved to `src/config/blindsPresets.ts` so the
slider index and the blinds can be reconciled by something a test can reach.

## The default table name never tracked the blinds

Same effect, same missing dependency. Accept the default name, drag the blinds
to 10/25, and you created a table NAMED "NLH 0.05/0.1" PLAYING 10/25 —
`tables.name` flatly disagreeing with `tables.stakes`. The name follows the
blinds now, and a name the owner typed is still never overwritten: a ref holds
what we last generated, and only that exact string is replaced.

## Pineapple Hold'em was a finished feature with no way to turn it on

`pineappleHoldem` had exactly three occurrences in the 2,800-line form: the
interface field, the default `false`, and the write. **There was no control.**
Meanwhile the engine deals it, `BettingStructure` has the discard street, and
`lobbyEntries` badges it.

The history is worth writing down, because a test was holding the feature shut.
The toggle was deleted on 2026-08-24 for a good reason — nothing read the
column — and pinned deleted by `limitUserIntent.test.ts`. On 2026-08-25, #840
taught `ServerTableEngineBase.dealtGameVariant` to read it. The pin outlived
its reason by six days and kept a working feature unreachable for a week. It is
reversed here, in the same commit as the control, per CLAUDE.md rule 8.

The switch is offered on `nlh`/`nlhe` only, mirroring the engine's own gate
("Pineapple PLO is not a game"), and the write is gated identically so a
variant change cannot strand a stale true.

## Twenty tournament columns were being written onto every cash row

`buildTableData` runs ONLY when `gameMode === 'regular'` — both save paths
branch to the tournament writer first — so the entire SNG/MTT block was landing
on cash rows. Twenty of those columns have zero readers anywhere: not the
engine, not the lobby, not any SQL beyond the `ALTER TABLE` that created them.
They are no longer written. Only `name` is NOT NULL without a default on
`tables`, so omitting them cannot refuse an insert.

Also gated: `seven_deuce_amount`, which was the one line short of the guard
above it. A PLO6 table created after loading an NLH template wrote
`enabled: false` beside `amount: 8`.

## What this audit nearly broke, and what caught it

Two switches, Auto Restart and Auto Create Table, were reported as dead by a
grep of `src/` and `server/src/` and were deleted here. They are not dead:
`fn_table_lifecycle_pass` reads both columns IN SQL, confirmed against the
deployed function rather than a migration file. The existing
`tableLifecycleSwitches.test.ts` failed on the deletion and the change was
reverted in full.

Three more that look dead from a TypeScript grep and are not, now recorded in
the file so nobody finishes the job: `game_mode` (five club-data RPCs match
`ILIKE '%mixed%'` on it), and `min_buy_in_bb` / `max_buy_in_bb`
(`20260828_cash_buyins_are_40bb_to_200bb.sql` resyncs both deliberately "so the
two column families cannot disagree").

**A TypeScript grep is not a reader census.** Grep `supabase/migrations` too,
then read the live object.

## Files

- NEW `src/config/blindsPresets.ts`, `src/lib/tableTemplateRestore.ts`
- NEW `tests/unit/templateLoadRestoresAConsistentForm.test.ts` (14 pins)
- NEW `tests/unit/theCreateTableFormOffersOnlyLiveSwitches.test.ts` (37 pins)
- `src/pages/TableConfigPage.tsx`
- `tests/unit/limitUserIntent.test.ts` — one pin deliberately reversed, see above

No migration. No money path touched. Client suite: 482 files, 6,836 tests green.
