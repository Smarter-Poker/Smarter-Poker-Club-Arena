# 2026-08-29 — Round 10: the ratchet, the reachable history, and two honest findings

Executes the remaining actionable items from rounds 8-9's open list.

## 1. The discarded-error-read ratchet (repo-wide)

`tests/unit/discardedErrorReadRatchet.test.ts`. The `const { data } = await
supabase...` shape produced fifty-two real defects across rounds 7-9 - a
tournament cancellable by a timeout, a money-path fork decided by a guess,
duplicate money gates failing open. The ratchet counts the pattern per file
across all of src/ against a frozen baseline (291 inherited occurrences):
any file over baseline fails, any new file with an occurrence fails, and a
shrunk file must tighten its baseline in the same commit - the ratchet only
turns one way. The four audited surfaces are pinned at zero.
TournamentResultsPage was cleared 3 -> 0 this round under the ratchet's own
rule (shrink what you touch); TournamentService's last two `{ count }` reads
now report too.

## 2. My Spin Results — the history that existed becomes reachable

TournamentResultsPage has carried a Mine filter, a Spin type filter, the
multiplier badge and isMe highlighting for weeks - with no way to ARRIVE at
that view. The filters are now deep-linkable (`?filter=mine&type=spin`,
validated against the one shared list so a bad param is the default view,
never an empty board), and the hamburger menu gains **My Spin Results** -
one tap to a spin player's own history. The chunk preloader strips query
strings so the menu prefetch still lands. Its four discarded reads were
fixed in passing (a resolved error used to render as an empty history
board / empty standings / "no hands recorded").

Pinned by `tests/unit/mySpinResultsDeepLink.test.ts`.

## 3. The chest-lid E2E flake

`live-animations.spec.ts` read the lid's CSSTransition exactly two rAFs
after the class flip; on a loaded CI runner the browser had not listed it
yet, `ms` read -1, and a correct lid failed the pin - which blocked one
publish today for code that never touched CSS. The read now polls up to 20
frames for the live transition and falls back to the computed
transition-duration only if the window was genuinely missed. The transform
assertion (the lid actually swings) is unchanged.

## 4. Finding: the cancellation row-deletion is HISTORY, not a live defect

The 290 ledger-only prize pairs (rounds 9's backfill could not stamp them)
all date from 2026-07-24 and earlier. The current `atomic_cancel_tournament`
does not delete rows - it marks them eliminated and refunds from the ledger
under an idempotency key. The deleting path was retired over a month ago;
the stale client comment in cancelTournament dates from before that. The
orphans stay as ledger history; there is nothing to fix upstream.

## 5. Finding: POY is a PHANTOM PIPELINE — decision needed from Dan

`POYService.submitTournamentResult` POSTs to `/api/club-arena/results`. That
endpoint DOES NOT EXIST in the World Hub - the 200 it "returns" is the SPA
fallback serving index.html, whose JSON parse then throws into the error
reporter. `poy_leaderboard` (which is actually a scraped news-site table -
source_url, external_player_id, country, team) is EMPTY. Club POY has never
recorded a single result, and no scoring formula (points per placement,
field-size weighting) exists anywhere in either repo.

Deliberately NOT built this round: inventing a points formula is exactly the
sin CLAUDE.md 10.5 documents (my invention presented as a design decision).
What POY needs from Dan: the scoring rule. Given that, the build is
mechanical - an ingestion endpoint (or direct Supabase writes), a real club
POY table, and a backfill from tournament_players, whose prize column
rounds 9-10 just made trustworthy.

## Verification

- tsc 0 errors (client, server, and the e2e spec standalone)
- Full client + server suites green (see PR checks)
- New pins: 3 (ratchet) + 5 (deep link)
- Branch merged with origin/main (#1743, #1744) before shipping
