# A Horse Account's Own Client Drives Its Seat

## What Was Seen

The Lightning pilot's live browser witnesses log in as pilot horse accounts
(009, Samantha, milehigh) and play them through the ordinary client: normal
login, accepted Terms, and a socket bound to the seat or pool session. The
server-side horse brain still answered those seats' turns within a few
seconds. Witness cycle run 39772148272 recorded the Time Bank as
`click_or_response_unknown` with execution `not_observed`, because the brain
had already acted before the action clock could run out; pre-actions and
manual actions raced the brain ("a horse/action race refuses honestly"); and
the client could never hold a decision.

## Where The Brain Acted

- Ordinary tables: `ServerTableEngineTurns.handleTurnChange` step 5 calls
  `scheduleHorseAction` for every `is_horse` seat, and the reconnect re-arm in
  `rearmTurnTimerIfCurrent` resumes it. The Crazy Pineapple discard
  (`ServerTableEngineRunout`) and the insurance auto-decline
  (`scheduleHorseInsuranceResponse`) answer for horse seats the same way.
- Lightning: `LightningHandHost.onTurn` calls `scheduleHorse` for every horse
  participant and never announces the decision to the player's rooms.

## The Control Rule

A horse account's own client controls its seat when both hold:

1. A live authenticated engine socket for that user on that table (socket
   admission or pong through `heartbeat(..., { transportOnly: true })`, until
   the last socket closes in `notifyTransportDisconnect`). In Lightning, a live
   socket in the user's own pool-session room, which admits only its owner
   (`LightningRegistry.isConnected`).
2. A client-originated claim since that socket session began. Ordinary
   tables: the table page's own `POST /heartbeat`, `POST /action`,
   `POST /preaction` or `POST /timebank`. Lightning: the room's `RENDER_ACK`,
   or an action, pre-action or time bank request through the room's seat
   proxy.

While it holds, the brain does not act on the seat's turns. The turn runs on
the human clock: the action timer, then the time bank, then the ordinary
timeout and auto-check or auto-fold. A brain decision already waiting out its
think time when the claim arrives is cancelled. In Lightning the decision is
announced to the player's rooms like anyone else's.

Control returns to the brain when the client's last socket closes, after the
ordinary disconnect handling runs. If it is that seat's turn, the brain takes
the turn inside the deadline already running and never extends it. A new
socket session needs a new claim. A socket alone, or a claim alone, is not
control.

`ServerTableEngine.isOwnClientControlling(userId)` and
`LightningRegistry.isClientControlling(playerId, roomId)` answer the question.

## What Does Not Change

Horses with no client never have a socket or a claim, so their timing and
decisions are exactly as before. No change to horse decision logic, money,
blinds, rake, fairness or the 2026-08-21 tournament sit-out rules. Human seats
are untouched: the rule is only consulted for horse seats, to decide who
supplies the horse's input (CLAUDE.md 10.5, the input-device exception).

## Verification

- `server/src/engine/AHorseAccountsOwnClientDrivesItsSeat.test.ts` (ordinary
  table, real `ServerTableEngine` turn path): with an own client, no brain
  request through the whole action clock, the time bank auto-activates, a
  manual time bank is honoured, the client's action is accepted and an idle
  client is timed out through the ordinary path; with no client the horse acts
  inside the clock with no bank; a socket alone or a claim alone is not
  control; a disconnect hands the current turn back to the brain inside the
  running clock; a mid-turn claim cancels a pending brain decision; a human
  seat is unaffected.
- `server/src/lightning/AHorseAccountsOwnClientDrivesItsLightningSeat.test.ts`
  (real `LightningHandHost` and `LightningRegistry`): the same clock, bank,
  action, timeout, no-client, hand-back and mid-turn cases, plus the
  registry's definition of control.
- With the two gates reverted, seven of the seventeen cases fail.

Release: engine runtime. Ships at the next daily 04:00 Chicago engine release.
No database change.
