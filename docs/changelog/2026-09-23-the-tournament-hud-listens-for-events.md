# The tournament HUD listens for events instead of polling every 45 seconds (2026-09-23)

Pull request #5169 (squash `377c4d4f6`), assignment
CA-PRODUCT-COMPLETION-2026-09-22, finding P1-F05 (Phase 5.4). Published in
client `fc288985`. This entry was missing when the pull request merged and is
written from the header comment of `src/components/tournament/TournamentHUD.tsx`
and the files the change touched.

## What was wrong

The in-table tournament bar (`TournamentHUD`, on `TablePage`) re-read the
whole tournament row (about 95 columns plus the club embed) every 45 seconds,
on every open table, hidden or not, and again on every elimination anywhere in
the field, plus the whole field of player rows on every level.

- Its failure handling never engaged. `getTournament` was called without
  `throwOnError`, so a failed read came back as `null`, the bar vanished and
  the failure count reset.
- It held its own binding on `t-break-<id>`. A Realtime binding cannot be
  removed while `TablePage` still holds that channel, so every remount left
  one more live listener firing reads.
- Its countdown ran on the device clock against the engine-stamped
  `level_started_at`, and it ignored real breaks (`on_break`,
  `break_ends_at`).

## Shipped

- `src/components/tournament/TournamentHUD.tsx`
  - Events, not a poll. The bar subscribes only to MasterBus, which
    `TablePage` already feeds from `t-break-<id>` through
    `tournamentEventBridge`, and unsubscribes on unmount, on an account or
    tournament switch, and once the event is over. A level change from the
    engine's table socket (`TOURNAMENT_LEVEL_UP`) triggers the same one read.
  - One reader: one read in flight plus one trailing, owned by the
    (tournament, account, mount). A response for any other owner is dropped,
    so a late answer can never paint another account or event.
  - A failed read keeps the last confirmed row. Real failures (a thrown
    PostgREST error, or no row) count, report the first two, and retry at
    5 s, 10 s, 20 s and so on up to five minutes. A success resets the ladder.
  - Bounded catch-up where a broadcast could have been missed: on mount; when
    the shared channel joins or rejoins; when the tab or the table comes back
    on screen; when the engine link reconnects; when a level, break or start
    time passes with no event (a few reads, then it stops); and on a
    `level_up` that skips a level.
  - A five-minute safety read, only while the bar is on screen, because the
    broadcasts carry no sequence number, are never replayed, and a failed
    engine broadcast is not retried.
  - Left, rank and average stack are re-read at most once per ten seconds,
    trailing the busts that moved them; `bubble_burst`'s own count shows at
    once.
  - The countdown is measured on the engine's clock (`serverNow()`), a real
    break and the add-on break show their own countdown, and late
    registration comes from the entry-window helper.
- `src/services/tournamentEventBridge.ts`: relays the four engine facts
  nothing relayed before (`late_reg_closed`, `ADDON_PERIOD_START`,
  `bubble_burst` with its `playersRemaining`, `final_table`) as
  `TOURNAMENT_UPDATED` with the engine's event named in `status`.
  `FINAL_TABLE_REACHED` is deliberately not emitted for `final_table`:
  `TablePage` publishes it itself, for MTTs only.
- `src/services/TournamentService.ts`: `getCurrentLevelState(tournament,
nowMs = Date.now())` measures at the instant it is given, so the HUD passes
  `serverNow()`; every existing caller keeps the device clock it always had.
- `src/pages/TablePage.tsx`: passes `hidden={!isVisible}`, so a background
  table slot that stays mounted stops asking.

## Evidence

- `tests/unit/tournamentHudPolling.test.tsx`: no 45-second poll after the
  mount read; a failed or missing row keeps the bar and backs off, reporting
  only the first two failures; a burst of triggers coalesces into one
  trailing read; a late row or field read after a tournament or account
  switch is dropped; catch-up on channel join and rejoin, tab return, engine
  reconnect, an expired level or break, a skipped level and a passed start
  time; nothing is read while hidden; a completed event retires every
  listener; unmount holds no channel; breaks and the add-on window count down
  on the engine clock.
- `tests/unit/tournamentEventBridgeHudRelays.test.ts`: each of the four facts
  is relayed once, `bubble_burst` never invents a count, and `final_table`
  does not raise the final-table celebration.
