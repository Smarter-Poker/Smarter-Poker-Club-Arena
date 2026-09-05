# Run It Twice hardening: dead money paths, the odd cent, per-run labels (2026-09-05)

Follow-up to `2026-09-05-run-it-twice-ships-the-pot-per-board.md`. That fixed the
reported bug; this closes the four things the verification pass turned up.

## 1. The offer engine holds no money math any more

`RunItTwiceEngine.resolve()` returned a `Map<string, number>` distribution built
by splitting `state.pot` evenly across the runs. Nothing has ever spent it: the
only caller, `dealAndResolveRIT`, discards the return because it has already
settled the hand properly. The deleted math was also wrong, and said so in its
own comment - it treated `state.pot` as a single number, so a multi-way all-in
with side pots was split as one pot.

Ninety lines of plausible, unreachable, incorrect money math sitting beside the
real thing is a trap: the next agent either "fixes" a bug that cannot fire or
wires it up. `resolve()` now returns void and keeps only what is load-bearing -
the winner bookkeeping, the RIT_RESOLVED announcement, and `clearOffer()`.

`dealDualBoards()` is deleted outright: zero call sites ever, a hardcoded
two-board model with a third bolted on, and a `pot1/pot2/pot3` result shape that
cannot express a main pot plus two side pots. `RITResult` went with it.

`RunItTwice.threeruns.test.ts` pinned the A9 bug in that dead arithmetic. Its
eight tests are replaced by the invariant that actually protects players: this
function is not a money path and must never become one again, enforced at
runtime AND as a source law over the file.

## 2. The odd cent has a rule

Each board used to be evaluated against the FULL pots, with the winner's
entitlement then divided by `runs` in floating point. Nothing was lost - the
repairs downstream saw to that - but float dust entered the pre-rake
distribution, and WHICH run carried the odd cent was whatever the rounding
happened to do. That is not something you can explain to a player.

Every pot is now cut into `runs` integer-cent slices up front, leftover cents to
the EARLIEST runs, and each board settles its own slice through the ordinary
path. `determineWinners` still handles hi-lo halves and `distributePot` still
gives an odd chip inside a chop to the first seat clockwise of the button. No
division survives in the board loop, and conservation is exact by construction.

## 3. A seat names the hand it made on the run being shown

`winnerInfo.handNames` is one name per player for the whole hand. A player who
takes run 1 with Two Pair and run 3 with a Flush got one of those for both,
beside a board row correctly naming the other. The seat now reads the run
currently on stage (`ritRevealedRuns`), falling back to the merged name - so
single-board hands and older payloads are untouched. Client-only: the engine
already sends `winners_by_board`.

## 4. The behaviour has a regression net

`tests/ritShipsPerBoard.law.test.ts` (registered in `docs/laws.d/`) pins what
had none: the per-player release ledger reaching `pendingStackHold`, each award
group releasing its own shares in integer cents, the release dying with its
hand, `potShipRemaining` staying deleted, a pot retiring only when it has paid
every run, side-pot rows filtered rather than emptied, the board-axis guard, and
the per-run seat label.

## Verification

Server 5742/5742 (399 files). Client: the RIT and hand-history specs pass,
including the new law and the law registry. Both sides typecheck; prettier
clean.

Two client specs (`currentLevelIsAnIndex`, `chipsAreTheDefaultNotBB`) cannot run
from a sandbox at all - they shell out to `git ls-files`, and a worktree's
`.git` points at a host path. They are green on the host and in CI; if you see
them red from a container, that is the reason.
