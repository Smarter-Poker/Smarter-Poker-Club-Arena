# Lightning Counts A Resumed Hand As A Resume And Reads A Formed Hand's Participants In One Wave

## Hand To First Render (R19 Breaches On Both Pilots)

The leg starts when the hand host sends a room its first frame (`LightningHandHost` HAND_START, `onFirstFrame`) and closes on that room's `RENDER_ACK` (`LightningRegistry.renderAck`), on the engine clock, for up to 60 s. The first frame was recorded for every seat, whether or not the room had a socket. So when a page opened onto a hand that was already dealt, its first ack timed the page load, not a render.

Evidence from the 2026-10-23 latency workload runs (pilot horse account Samantha), comparing `lightning_hand.formed_at`, the run's start and the browser's first ack:

| Window        | p95 (ms) | First acked hand formed | Page started                             | First ack    |
| ------------- | -------- | ----------------------- | ---------------------------------------- | ------------ |
| Action 13:55  | 30634    | 13:54:31.380            | 13:54:57.232                             | 13:55:02.706 |
| Madness 14:00 | 51597    | 13:59:09.148            | 13:59:56.713                             | 14:00:01.674 |
| Action 14:35  | 3130     | 14:35:17.781            | 14:35:16.542 (socket not yet subscribed) | 14:35:21.613 |
| Action 14:40  | 20537    | 14:39:58.723            | 14:40:15.753                             | 14:40:19.957 |

The 13:51 (13067 ms) and 14:25 (15774 ms) windows follow the same pattern: each is the first render sample after a workload run started (runs at 13:50 and 14:24). Every breach window holds exactly one outlier, and its other samples have a p50 of 83 to 237 ms. In the control run at 14:13, the page was already subscribed when hand 92055aaf formed, and its first ack took about 0.7 s.

Fix (engine): each room counts its socket sessions. A first frame records the session it was sent into, or none when the owner had no socket in the room. An ack is closed as a resume, counted in `poker_lightning_render_resumes_total{why}` and not as a hand_to_first_render sample, when any of these holds:

- the frame was sent before the room had a socket (`before_subscribe`)
- the ack came from a later socket session (`resubscribed`)
- the client says the hand reached React while the tab was hidden (`hidden`)

A resume still claims the seat for the player's own client. A slow render on a room that was already watching is still measured at its full length; a test covers a 30634 ms one.

Fix (client): `scheduleLightningRenderAck` notes whether the page was hidden when the hand was committed or before its paint, and sends `r: 1` in that case. Browsers do not paint a hidden tab, so that ack would time the player's absence. An engine without this change ignores `r`.

Expected effect: the six measured breach samples become resumes. The samples left in those windows came from rooms that were already watching, and those windows' p50 was 83 to 237 ms against the 2000 ms ceiling. The ceiling and the qualifier rules are unchanged.

## Fast Fold To Next Hand (R19 Action Breaches)

The leg runs from the fold request to the next deal. It is made of fold acknowledgement and idle (about 85 ms), the pool wait (`folded_at` to `formed_at`), and match_to_hand (the form call's return to the deal). Measured for every Action fast fold between 13:54 and 14:45 (46 folds, all Samantha's):

- 13:57 window, 5777 ms: fold 13:56:29.844, formed 13:56:34.460 (4615 ms). Nobody else was free. The other player in the two-seat hand became free at 13:56:34.419 and was matched 40 ms later. This was an empty pool, not the full-ring hold.
- 14:32 window, 5763 ms: fold 14:30:59.969, formed 14:31:01.508 (1539 ms), `begin_dealing` at 14:31:01.779, then about 3.9 s to the deal (match_to_hand p95 3978 in that window). PostgREST edge logs show the cause: `loadParticipants` made three dependent reads in a row, `lightning_hand_player` (713 ms origin), then `lightning_pool_slot` (996 ms), then `profiles` (2219 ms).
- Hold-bound folds (13 of 46, waited 3034 to 3526 ms) produced legs of at most 4586 ms. Neither breach came from the 3 s full-ring hold.

Fix (engine): the participant read now embeds each participant's own pool slot (`lightning_pool_slot!lightning_hand_player_sits_in_its_own_slot`). The profiles are read at the same time for the matcher's own player list. The participant rows stay authoritative: any player the list missed gets their profile read afterwards, and a participant without its own pool session is still refused. Three serial round trips become one wave. On the 14:31 hand, match_to_hand would have been about 2.2 s instead of 3.9 s, which puts that leg at about 4.0 s. In ordinary windows this removes about two PostgREST round trips (about 200 ms) from every deal.

Trade-off, recorded: the 3 s full-ring hold is not shortened for a fast folder. Shortening it would not have fixed either breach, and it would bring back the heads-up formations the hold was added to stop (2026-10-15). Six-seat rules, P0 to P6 fairness, blind fairness and the ON/OFF thresholds are unchanged. The 13:56 case was an empty pool, and the leg's floor in that case is the time until a second player is free. This change does not remove it: a pilot pool with too few free players can still exceed 5000 ms on a single sample.

Delivery: the engine changes ship in the next daily engine release (04:00 America/Chicago). The client flag ships with the normal client publication. No migration, no money and no matcher change.
