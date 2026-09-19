# 2026-09-19 The Diamond tournament code comes home

## What was wrong

The September 16 baseline restore (#4711, "Restore September 13 GitHub/Hetzner
delivery and application baseline") reset `main` to `c35e9403a0` and archived
128 commits out of it. Seven of those were the Diamond Arena Phase 8 and Phase
9 tournament work: the unit reaching the engine and the tournament seat guards
(#4553), a Diamond tournament entry as custody with the doors that answer the
client (#4583), the Phases 1 through 8 recheck (#4587), the seat exit going home
through its own door (#4620), a Diamond event priced in Diamonds on every
surface (#4685), the Phase 9 bounty bank and mystery chest engine (#4638), the
diamond-health known-comparisons qualification (#4595) and the Diamond bonus
club index law (#4679).

Production was never reset. Every migration those commits call was applied on
September 14 and is still recorded in `supabase_migrations.schema_migrations`
(`the_diamond_seat_guards_know_a_tournament_seat` 20260914004611,
`a_diamond_tournament_entry_is_custody` 20260914024241,
`a_diamond_tournament_pays_from_its_own_custody` 20260914032315,
`a_diamond_tournament_door_answers_the_client` 20260914034708, the grants and
watchlist migrations, `a_diamond_seat_exit_goes_home_through_its_own_door`
20260914103912, `a_diamond_rebuy_proves_its_generation` 20260914111558,
`a_diamond_bounty_is_paid_from_its_own_bank` 20260914111709,
`a_diamond_mystery_chest_holds_whole_diamonds` 20260914113514,
`diamond_health_requires_known_comparisons` 20260914063002 and
`diamond_bonus_club_foreign_key_is_indexed` 20260916072541), and the fifteen
`fn_poker_diamond_tournament_*` functions plus `fn_poker_diamond_create_tournament`
exist in production. So the database had every door and the code on `main`
called none of them: the engine held every Diamond table to the cash boundary,
the client's tournament ladders priced a Diamond event in cents, and the laws
that pin the migrations' text were gone.

## What changed

The archived commits are cherry-picked back onto today's `main` as one series,
in dependency order, each with `-x` so the source SHA is on record:

1. `d9e3f4a0be` (#4553) the unit reaches the engine; `tournamentUnit.ts`,
   `UNIT_CENTS_ASSET_NOT_READ`, the seat-guard laws. Main already declared
   `unit_cents` on `TournamentBrainContext`; the pick reconciles the one
   normalisation there rather than duplicating it.
2. `6f734856b3` (#4583) a Diamond tournament entry is custody. The engine's
   `loadTable` on main had replaced the inline cash-switch check with
   `assertDiamondCashSettingsOpen`, which keeps a failed read apart from a
   closure. A tournament table is now gated on `tournaments_enabled` through a
   matching `assertDiamondTournamentSettingsOpen` (with its own tests), so a
   Supabase blip is never read as the switch being off. `assertDiamondTable`
   is the one door for both kinds; main's `DiamondCashPolicyClosedError`
   startup handling is untouched. The manager's `readTournamentClub` sits
   beside main's `clearPersistedBreak`, and the resume path keeps main's
   `on_break` restore. `ClubHomePage` keeps main's `handleLobbyWaitlistToggle`
   and gains `registrationClosedLabel`.
3. `684f0a6236` (#4587) the recheck audit.
4. `44943b45f7` (#4620) a seat exit goes home; applied cleanly on today's
   `TablePage.tsx`.
5. `e4d14f7a1c` (#4685) priced in Diamonds. The archived commit sat on the
   SpadeConsole render of `TournamentInfoPanel` and `TournamentPage`, which is
   not on main; main's render is kept and only the unit wiring is added (the
   named `arena:clubs!tournaments_club_id_fkey` embed on every tournament read,
   `tournamentRowUnitCents`, and the fourth `placePrize` argument at every
   ladder). `TournamentService`'s longer select lists on main are kept.
6. `070529ff52` (#4638) Phase 9 bounty bank and mystery chest engine; applied
   cleanly on the re-landed manager.
7. `84a8e5d754` (#4595) the diamond-health qualification script and its CI
   step, placed beside the other `PG_BIN` pg17 steps. The script finds its
   migration by slug because production recorded a different stamp
   (20260914063002) than the file was written with.
8. `64a27a6895` (#4679) the bounded Diamond bonus club index law.

No `supabase/migrations/*` or `scripts/ci/schema-manifest.d/*` path is carried
by any pick: the migrations are installed and their files return through the
parallel migration-records restoration PR. Every law test that reads a
migration's text (`a-tournament-stack-is-not-a-diamond`, the three Phase 8
custody laws, the seat-exit law, the three Phase 9 laws, the bonus club index
pin) therefore passes only once both PRs are on `main`, which is why this
series lands after that one.

The programme's Phase 8 and Phase 9 sections carry the archived text again with
a paragraph recording the re-landing. The `docs/laws.d/` file for every
restored law returns with it (`law-registry.law.test.ts` holds both directions).

Nothing opens funded play: `ca_arena_settings.tournaments_enabled` and
`cash_games_enabled` stay false and are not touched.

## How verified

- `npx tsc --noEmit` at the root and in `server/`: clean after every step.
- Focused per step: `server/src/tournament/**` (178 files), the
  `DiamondTournamentBoundary`, `cashTablePlayEligibility`,
  `MysteryActivationCutoff`, `aDiamondMysteryChestHoldsWholeDiamonds` and
  mystery pool suites; root `a-tournament-prize-knows-its-unit`,
  `payout-one-rule-everywhere`, `a-tournament-pays-every-place-or-none`,
  `the-diamond-guards-are-watched`, `law-registry`,
  `unit/aClosedArenaOffersNoRegistration`, `unit/aDiamondSeatIsBoughtWithDiamonds`,
  `unit/aDiamondEventIsPricedInDiamonds`, `unit/theClientHasOneTournamentMoneyRule`
  and the lobby and tournament component suites, all green.
- The full server suite and the full root suite, recorded in the PR.
- The Silent Revert Guard is expected to report every restored file; that is
  the intended restoration, explained in the PR.
