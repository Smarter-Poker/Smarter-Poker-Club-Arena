# Diamond Spins never start themselves, and the run accumulates (2026-09-21)

Owner ruling 2026-09-21 (Dan's Diamond Spins change list), client side of
R1, R8, R9, R18 and R19. Workstream C1 (wheel page flow). The database side
of R18 (`fn_wheel_run_begin`, `fn_wheel_run_end`, `auto_run` and
`pending_awards` on `fn_wheel_state_v2`) is workstream D1; this client is
coded against that contract and tolerates its absence.

## Behaviour

**R1. Nothing on the wheel page starts play on a clock.** Four paths did:

1. A 30-second idle countdown (`useIdleSpinCountdown`) pressed Spin by
   itself, re-armed on every load and every entry change, with a `Hold Ns`
   plate. Deleted, with its hook, its test and its e2e pin.
2. The win reveal dismissed itself at the end of its own pop animation for a
   bonus game or an upgrade, and the page then navigated into the game. The
   reveal now waits for its plate: **Play Game** on a bonus game, **Open
   Upgrade Wheel** on an upgrade, **Continue** on an instant prize. Escape
   and the backdrop never open a game.
3. An effect opened an unfinished award's game page on load. It is now a
   visible, persistent card, "You Have A Bonus Game To Play" (or "N Bonus
   Games"), with a **Play Game** button. The spin plate is held with "Play
   Your Bonus Game Before Another Spin" until it is played.
4. The upgrade ring started spinning the moment its reveal closed (R19). See
   below.

The one automatic press left is a run of 5, 10 or 25 the player started.
Law: `tests/diamond-spins-never-start-themselves.law.test.tsx` renders the
real page and reveal flow under fake timers, lets two minutes pass at every
point where a clock used to act, and asserts no spin, no navigation and no
turning ring. Source pins keep the idle hook deleted and every effect on the
page free of navigation.

**R8.** The bottom slide-in toast after every spin (`toast.success(outcomeHeadline)`)
is gone. The result stays in the reveal and in the control panel notice.
Error toasts stay.

**R9.** A won bonus game stays on its reveal until the player taps **Play
Game**, which navigates to the game page (workstream C3 owns what that page
shows next). Instant prizes keep the tap-to-continue reveal.

**R19.** When Upgrade lands, the ring does not spin by itself. A new
`awaitUpgrade` phase in `WheelExperience` shows a flashing instruction,
"Swipe Or Tap The Wheel To Spin" (static under `prefers-reduced-motion`),
and makes the upgrade stage the hit target: `role="button"`, `tabIndex 0`,
a tap (pointer down and up), a swipe (12 px of travel) or Enter / Space
starts the ring. The outcome is already in the receipt (`secondary`), so
this is presentation only. A refresh mid-phase goes through the existing
Recover Spin path and replays into the waiting phase again, never past it.
Inside a run the ring waits for the gesture too, then the run resumes.

**R18. The run accumulates and the server keeps it.**

- The plate offers 5, 10 and 25 (`WHEEL_RUN_SIZES`); the 50 is gone from
  the wheel (Crash's Auto Play keeps `AUTO_RUN_SIZES`, untouched).
- One tap on **Auto Spin N** declares the run to the server
  (`fn_wheel_run_begin(p_club_id, p_spins)`), then the same runner
  (`autoRunVerdict`, unchanged) presses `handleSpin` N times, each with its
  full wheel animation. Nothing is skipped (10.6): what changes is that a
  spin inside a run lands on the run's **tally** instead of opening a reveal,
  because the player asked for N spins back to back and reads the prizes
  together at the end. A "Spin K Of N. Won So Far: ..." strip stands in the
  control panel notice while it turns.
- Instant prizes are paid by each spin's own server transaction, as before;
  bonus games are queued unplayed at the server. Neither ends the run.
- When the run finishes, is stopped, hits a blocker, a server refusal or a
  request that never answered, the client closes it
  (`fn_wheel_run_end(p_run_id)`) and shows one **Run Complete** / **Run
  Stopped** summary: every instant prize with its worth, every bonus game,
  the reason if it stopped early, and one **Play Game** plate for the first
  unplayed game (the server's `pending_awards` is the list offered, so games
  from before a resume are included). **Not Now** leaves them in the queue
  card. Each game goes through the R9 flow; on return the card offers the
  next.
- A refresh mid-run: the in-flight spin is recovered by the existing
  Recover Spin path, and the run itself comes back as `state.auto_run`
  with a "Your Run Is Waiting" card offering **Resume Run (N Left)** and
  **End Run**. Nothing resumes by itself (R1). The spin plate is held with
  "Resume Or End Your Run Below" until the player chooses.
- Guards: Auto Spin is re-entrancy safe (`runBusyRef`, one `runBegin` per
  tap however many taps land while it is in flight); a refused run starts
  nothing and says why; leaving the page mid-run presses nothing more and
  leaves the run open at the server for the resume card; the runner's
  timer is cleared on unmount and every continuation checks `live()`. The
  server pause `min_seconds_between_spins` reaches the runner through the
  page's own `waitSeconds` (from `player.seconds_until_next`), which holds
  `canSpin` and therefore the runner.
- Audit fixes from MAP-client R18: the run count is now persisted (at the
  server); a malformed saved spin no longer fails the page load, it is
  discarded out loud ("A Saved Spin Could Not Be Read. Your History Shows
  Every Spin.") since a value that fails validation could never be
  resubmitted; a bonus win no longer ends the run silently.

## Contract this client codes against (workstream D1)

- `fn_wheel_run_begin(p_club_id uuid, p_spins integer)` -> jsonb
  `{ok, run_id, spins, spins_done}` or `{ok:false, error}`.
- `fn_wheel_run_end(p_run_id uuid)` -> jsonb
  `{ok, run_id, spins_done, pending_awards}` or `{ok:false, error}`.
- `fn_wheel_state_v2` gains `auto_run` (`{run_id, spins, spins_done}` or
  null) and `pending_awards` (`[{id, game, boost_multiplier, base_diamonds,
entry_diamonds, created_at}]`). The client also still reads the older
  `awards` name, and reads an absent or malformed `auto_run` as no run.
- While a run is open the spin RPC accepts spins although the run's bonus
  awards are unfinished. The client sends no run id on the spin.

## Moved pins (same commit, owner ruling 2026-09-21)

- `tests/components/IdleSpinCountdown.test.tsx` deleted with the hook (R1).
- `tests/e2e/css/diamond-wheel-reveal.spec.ts`: the `Hold Automatic Spin`
  click is gone (R1); the bonus reveal now waits for Play Game (R9); the
  upgrade path clicks Open Upgrade Wheel, checks the ring stays idle, then
  swipes it (R19).
- `tests/components/WheelWinReveal.test.tsx`, `WheelExperience.test.tsx`,
  `DiamondWheelQuotes.test.tsx`: auto-dismiss and auto-open pins replaced by
  Play Game, gesture and card pins.
- `tests/the-wheel-runs-the-way-the-other-two-do.law.test.ts` (+ its
  `docs/laws.d` entry): the counting line is now `tallyWheelRun`, the
  refusal carries the server's reason, and the wheel offers 5/10/25 (R18).
- `tests/components/DiamondWheelAutoRecovery.test.tsx`: the run declares and
  closes at the server, spins land on the tally without a reveal, and the
  summary replaces the finished toast; plus new cases for every R18 path.

## Proof

- `npx tsc --noEmit -p tsconfig.app.json`: clean.
- `npx vitest run` on every test naming the changed files (31 files, 1060
  tests) plus `tests/unit/wheelRun.test.ts` (8): green.
- `npm run check:title-case`, `npm run check:painted-text`: OK.
- `node scripts/ci/report-source-grep-tests.mjs --ratchet`: OK (5/5).

## Flag to the owner

Inside a run the per-spin reveal modal is not shown; the prize is tallied
and shown in the end-of-run summary. This is a different presentation of
the same receipt, argued under R18 ("accumulate all prizes and bonus games
to the end and award all of them then"), not a skipped animation: every
wheel spin still plays in full.
