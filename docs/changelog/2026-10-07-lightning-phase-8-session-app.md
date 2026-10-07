# 2026-10-07 Lightning Phase 8 (Of 14): Multi-Table Lightning, Decision Queue, Session Stats, Pool Health, Session Summary And Recent Hands (Engine And Client)

Spec Phases 11, 12 and 13, app side. The database half (multi_table_limit,
p_player_platforms, and the five browser RPCs) ships in its own pull request
from `agent/claude-lightning-p8/lightning/session-db`. Dark in production:
no Cluster is Lightning, so every path below is inert for current players.

## Engine

- **The device class reaches the matcher.** A Lightning room's socket says
  which device it is: `?p=desktop|tablet|mobile` on the per-room socket URL,
  `platform` on the multiplexed SUBSCRIBE frame. Every other table's socket is
  byte-for-byte unchanged. `LightningRegistry` records it per room, the
  presence feed carries it, and `LightningPresence.snapshot` returns
  `platforms` (this Cluster's players only; where two reports disagree the
  narrower device wins, so a limit is never loosened by a stale report).
- **p_player_platforms.** `fn_lightning_match` and
  `fn_lightning_match_and_form` are called with it whenever a platform is
  known. A database still on the old signature answers "function not found";
  the same call is repeated once without the argument (nothing ran the first
  time, and the writer keeps its request id), and the worker stops sending it
  for ten minutes, so a pass costs one call, not two, until the migration is
  live.
- **The decision queue.** When a human player owes a decision in any
  Lightning hand, the host announces it and the registry sends USER_EVENT
  `lightning_decision` `{pool_session_id, hand_id, street, time_remaining_ms,
deadline_at, urgency, server_now}` to EVERY Lightning room that player has
  open, and `lightning_decision_cleared` `{pool_session_id, hand_id, reason}`
  when it is acted, folded, timed out or the hand ends. A time bank start
  re-announces the new deadline. A reconnect or RESYNC re-sends what is still
  owed. All clock values are the engine's. Horses are never queued.

## Client

- **Multi-table Lightning.** The Lightning entry lists the player's other
  Lightning tables (fn_lightning_my_sessions) with VIEW GAME, says "N Of
  limit", and offers the last Cluster played as a door. At the device's
  limit (desktop 4, tablet 3, phone 2) JOIN LIGHTNING is not offered and the
  page says why. Each room opens as a tab of the existing multi-table view,
  so several Lightning rooms sit side by side in its tile view. Handhelds may
  now multi-table (capability map), up to their limit.
- **Decision Queue strip** (`LightningDecisionQueue`) at the top of the
  multi-table view: rooms owing a decision, ordered by time left on the
  engine's clock, coloured by urgency; the room's tile and slot carry the same
  urgency outline.
- **Law 10.6 decision.** The queue only SIGNALS. The view moves only from the
  player's tap on an entry (a tab select, or opening the room when it has no
  tab). There is no auto-foreground, not even behind an opt-in setting:
  10.6 forbids any setting that moves `activeIndex` without a user gesture,
  "however opt-in".
- **Session panel** (Session) in the room: hands, duration, hands per hour,
  starting and current stack, net, BB/100, VPIP and PFR when known,
  showdowns, LIGHTNING FOLD count, average and P95 wait. Read when opened and
  once per new hand while open; never polled. Its visibility is remembered.
- **Pool health badge** (BUILDING / ACTIVE / HOT / THIN) from
  fn_lightning_pool_status in the room and on the Lightning entry (every 30 s,
  only while visible); the lobby card now prefers the same answer (falling
  back to the derived status when the function is not there yet), refreshed
  every 30 s.
- **Session summary.** Leaving Lightning (either leave door) opens the
  Lightning summary over the lobby (fn_lightning_session_summary) in place of
  the table card; the MUST MOVE reversion notice carries it inline. VIEW
  SESSION shows the session's hands; PLAY AGAIN goes to the Cluster's
  Lightning entry, where the existing buy-in confirmation still applies.
- **Recent Hands** (last 50, This Session / All Lightning) and **Previous
  Hand**: a tap opens the EXISTING replay (`HandReplay`) for the hand's
  hand_history_id, read-only.
- **Warm resume** (`lightningPrefs`, localStorage, every access guarded):
  last Cluster and stakes, table count, Session panel visibility and the FOLD
  & WATCH preference. Nothing spends.

## Tests

- `server/src/lightning/LightningPhase8SessionApp.test.ts`
- `tests/lightning/lightning-phase-8-session-app.test.tsx`
