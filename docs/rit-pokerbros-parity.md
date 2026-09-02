# Run It Twice — PokerBros Parity Spec (2026-08-26)

Source: three screen recordings supplied by Dan (RIT accepted HU, RIT declined,
RIT multi-way with split pots), watched frame-by-frame at 3-4 fps. This
document is the behavioral contract the implementation targets.

## 1. Observed reference behavior

### 1.1 Offer flow (all three videos)

1. All-in + call → betting closes. Every live hand turns FACE UP immediately.
   Hand-rank labels update under seats. Action clock stops.
2. Status line under the table: "Waiting for risk control." (~1.5-2s), then
   "Waiting for running multi-times." while the offer window is open.
3. A **Risk Management panel** slides in for every all-in participant:
   - Board row: the community cards dealt so far, then face-down card backs
     for every undealt street slot (5 slots total; preflop = 5 backs).
   - `Pot: <amount>` and `Countdown: 25s` ticking down.
   - One row per all-in player: hole cards (small), player name, equity %
     (when the table computes equity), and a green check the moment that
     player has agreed. The requesting player's row is pre-checked.
   - Footer: "<name> requests to run it twice." with **Decline** (orange) and
     **Accept** (yellow) pills for responders.
4. Checks appear LIVE as each player accepts (video 3: requester checked,
   then player 1's check, then player 5's check).

### 1.2 Decline (video 2)

- The instant ANY player declines, the panel closes for EVERYONE.
- A wide banner appears over the felt: "<name> has rejected running
  multi-times." It stays up through the start of the single runout (~5s).
- The hand then runs ONCE, normally paced (turn… pause… river).

### 1.3 Accept (videos 1 and 3)

- When the last responder accepts, the panel closes at once and a banner
  shows "Players have accepted running multi-times." (~4s).
- The pot display splits into main pot + side pots + total where side pots
  exist (video 3: 20.32 / 1.95 / POT 22.27).

### 1.4 Runout pacing (video 3, preflop 3-way; video 1, turn HU)

- Board 1 deals one street at a time: flop cards flip in with a short
  per-card stagger, ~1.3s pause, turn (card back slides then flips), ~1.3s
  pause, river. Same cadence as the normal paced all-in runout.
- Then board 2 deals in a row stacked adjacent to board 1 (board 1 compresses
  to make room), with the SAME street pacing. Only the re-dealt streets are
  new; a turn all-in re-deals only the river (video 1: run-2 river renders as
  a single offset card next to run 1's river slot).
- Three runs: same again for board 3.

### 1.5 Winner identification + pot shipping (video 3 — the critical part)

- After the final river: each board gets a gold ribbon with the winning hand
  name rendered ON the board row; the winning cards stay lit, non-winning
  cards dim. Winning hole cards highlighted at the seat.
- ~1s later pots ship ONE AT A TIME, board by board, pot by pot:
  - Chips fan from the pot to that board-share's winner with a floating
    "+<amount>" that rides the fan; the pot counter decrements as each pot
    leaves.
  - **Split pots fan to every winner of that pot simultaneously**, each with
    their own float showing their exact share (video 3: +0.12 to two players
    at once).
  - Sequential ships are ~1.2s apart.
- Stacks update as each share lands. Next hand starts ~2.5s after the last
  ship.

## 2. Implementation mapping (Club Arena)

Money settlement is already correct server-side (per-board × per-side-pot
`determineWinners`, single rake/BBJ, cent-exact scaling) and is asserted
synchronously by the RIT money tests — so settlement stays synchronous and
the reference pacing is presentation, driven by the client from the enriched
result events (which is also how the reference client behaves).

### Server

- `rit_offer` / `rit_chooser_decided` now carry `deadline_ts` and
  `timeoutSeconds` from the engine config (25s, PokerBros countdown parity).
- NEW `rit_response_update` broadcast on every accept: `accepted_ids[]`,
  `waiting_for[]` — powers the live green checkmarks.
- NEW `rit_all_accepted` broadcast when consent completes: the accept banner.
- `dealAndResolveRIT` now populates `currentHandPerPotAwards` and
  `currentHandWinnersByBoard` with a per-RUN board axis, so `pot_win` carries
  the UNMERGED (run, pot, winner, exact share) groups. The client's existing
  sequenced award-group animation then ships each board's pots individually,
  splits included — the same machinery that already sequences main/side pots
  on single-board hands.
- `rit_result` carries `base_board_count` so the client knows which cards are
  re-dealt (and animates only those for runs 2/3).

### Client

- `RunItTwicePrompt` rebuilt as the Risk Management panel (board preview with
  card backs, pot, live countdown, per-player rows with hole cards, equity
  and live checkmarks, requester line, Decline/Accept pills; chooser variant
  shows Run Once / Run It Twice / Run It 3 Times).
- Responders see the panel from `rit_offer` (waiting state) — not only after
  the chooser decides.
- `rit_result` starts a client reveal timeline: per-run, per-street card
  reveal at the paced-runout cadence; winner ribbons + highlights + share
  labels appear only after the last river.
- `POT_WIN` chip ships are held until the reveal timeline completes, then the
  award groups play in order (board 1 pots, board 2 pots, …), split-pot fans
  to multiple winners with per-winner floats — this path is shared with all
  other games, so every split pot everywhere ships per-winner.
- Any decline closes the panel instantly for everyone (`rit_single_run`),
  with the decliner named in the banner, and the single runout proceeds
  (already server-paced).

## 2b. Round 2 (same day) — measured timings and the remaining gaps

The three recordings were re-cut at 10fps and inter-frame difference spikes
were used to timestamp every card land and chip ship. Measured: streets
~1.3-1.4s apart, ~1.8s between boards, winner ribbons ~0.9s after the last
river, pot ships ~0.9-1.2s apart, next hand ~2.5s after the last ship, and a
multi-second "waiting" lead-in before the panel.

Closed in round 2:

- **The engine's post-hand hold now covers the reveal timeline.** A RIT hand
  settles synchronously server-side while the client deals the boards street
  by street — the old hold (max ~7.9s) was shorter than a 2-run preflop
  timeline (~12s), so the next hand dealt over a board still turning its
  river. `handCompletionSpec` gained RIT\_\* constants (single source, mirrored
  byte-identical client/server, pinned by test) and
  `handCompletionHoldMs({ritRuns, ritStreetsPerRun})` extends the hold by
  exactly the client timeline. The client timeline reads the SAME constants.
- **Felt status strip instead of toasts.** "Waiting" rides the felt for
  everyone — spectators and folded players included — while the offer hangs;
  the accepted/rejected outcome (decliner named) replaces it for ~5s, exactly
  like the reference. The panel itself slides in a beat (~1.5s) after the
  strip appears, matching the reference lead-in.
- **The POT counter decrements as each pot leaves the middle** during any
  sequenced award (splits, side pots, every RIT board) — the number over the
  felt always says what is still in the middle. Single-pot hands keep the
  existing slide-and-fade.
- **Runs 2+ dim the shared base cards** (flop/turn all-ins) so the re-dealt
  streets read as the new information, like the reference's offset cards.
- **Ship cadence retuned**: POT_AWARD_STAGGER_MS 600 → 900 (measured
  0.9-1.2s), run gap 1500 → 1800 (measured ~1.8s).

Known deliberate divergences (documented, not accidental):

- The reference's "risk control" phase is their compliance backend; our
  single waiting strip covers the same beat without pretending to a check we
  do not run.
- On a turn all-in the reference draws run 2 as one offset river card; we
  draw a full second row with the shared prefix dimmed — same information,
  same pacing, layout adapted to our stacked-board system (which must also
  fit run 3).
- Banner/panel wording follows the house popup law (Title Case, no em
  dashes) rather than the reference's literal strings.

## 2c. Round 3 — the RUN IT 3X recording (turn all-in, spectator view)

A fourth recording (Crazy Pineapple, HU turn all-in run three times, captured
from a FOLDED player's seat) added three behaviors:

- **Per-player accept banners.** Spectators and folded players — who never
  see the consent panel — watch the question resolve on the felt: the
  waiting strip, then "<name> has accepted running multi-times." for a few
  seconds per accept, then back to waiting while the offer still hangs. The
  final accept's named banner rides straight into the runout (no collective
  banner on top of it). Implemented via `rit_response_update` → named felt
  banner with revert-to-waiting; the collective `rit_all_accepted` banner is
  suppressed when a named one fired within the last 2s.
- **Compact layout for partial re-deals.** Runs 2+ never redraw the shared
  prefix — the reference deals each re-dealt river into the river slot and
  parks the previous ones offset. Ours: extra-run rows hide the shared-prefix
  slots (layout width kept), so each run's re-dealt cards sit exactly under
  their street positions. Preflop all-ins keep full rows (matches video 3).
- **The winner phase is INTERLEAVED per run** — run 1's ribbon + highlights
  land, run 1's pot ships, THEN run 2's ribbon, ship, then run 3 (measured
  ~2.5-3.2s per run). Implemented as one `RIT_RESULT_RUN_MS` (2600ms) window
  per run: `ritRevealedRuns` gates each board's ribbon/label on its own
  turn, and POT_WIN aligns each run's award groups to that run's ribbon
  time (`ritRunRibbonAtRef`) — a ribbon-beat after the ribbon, pots within
  a run staggered as before. The engine hold formula changed to match:
  `reveal + runs × RIT_RESULT_RUN_MS + push` (the per-run windows ARE the
  showdown read on a multi-board hand).

## 2d. Round 4 — completeness pass (persistence + replay + cleanup)

- **`hand_history.rit_boards` exists at last** (migration
  20260826_hand_history_rit_boards, applied to production). Boards 2..N in
  run order, JSONB, NULL on single-run hands. The engine writes it at
  settlement; the client mapper prefers it and falls back to parsing the
  `rit_board_N:` pseudo-actions on pre-column rows. `rit_boards IS NOT NULL`
  is now the exact predicate for "this hand ran multiple boards".
- The pseudo-entries are FILTERED from the mapped action list — they leaked
  into every replay's action feed as a bogus system entry.
- Hand replay renders every RIT board as a labeled RUN row from the river
  step onward — and a pre-existing replay bug was fixed along the way:
  production rows store board cards as engine STRINGS ('8spades'), which the
  replay's card converter didn't handle, so every hand_history replay board
  rendered as Ace-of-Spades placeholders.
- Dead code removed: the RunItTwiceBoard component (zero call sites,
  hardcoded 2-player model). The uppercase RIT\_\* masterBus re-broadcast
  cases were AUDITED AND KEPT — the event type is uppercased before that
  switch, so they do fire (an earlier audit note claiming they were dead
  was wrong).

## 3. Explicitly out of scope

- No PokerBros assets, artwork or text is copied; visual layout is our own.
