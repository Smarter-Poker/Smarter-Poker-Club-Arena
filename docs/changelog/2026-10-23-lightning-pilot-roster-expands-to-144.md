# Lightning Pilot Roster Expands To 144 Funded Horses

**Owner, 2026-10-23 11:06 America/Chicago:** "FINISH UP ANY AND ALL REMAINING WORK, AND USE AS MANY FUNDED PILOT HORSES AS YOU NEED".

## What Was Measured

Both private pilots (Action `56d5d6f0`, Madness `681eb9e8`, club `e14bc9f7`) are six-seat games that hold 18 seats each. Hourly distinct seated players from `cash_player_session` over the last two days:

- 2026-10-23 05:00 to 12:00 UTC: Action 17 to 18, Madness 17 to 18 (full).
- 13:00 UTC: 14 and 13. 14:00: 13 and 9. 15:00: 12 and 3.
- 2026-10-22: Madness never above 12 and at 3 from 19:00 UTC; 2026-10-21 Madness at 0 from 22:00 UTC.

The funded 72 deliver roughly 5 pilot hours per horse per day (daily caps of 510 to 660 minutes, one rest day a week, a fixed 10 to 17 hour activity window, and the 05:00 UTC day rollover start everyone at once). Holding both pilots at or above the ON threshold (12) from 05:00 to 23:00 UTC needs about 36 seated horses for 18 hours, roughly 650 horse hours, so about 130 horses. 144 (72 more) is the target, with the new 72 chosen for the afternoon and evening gap.

## Selection

Cash-lane horses only. The first pick (cash or both lanes) was refused by its own prepare at 17:01 UTC: 33 of those 72 were seated in running tournaments an hour after selection, because "both"-lane horses enter tournaments continuously. Cash-lane horses never sit in tournaments, so no tournament field loses a horse (109 events in the next 24 hours, 866 distinct horses entered in the last 24 hours, largest horse field 542; none of those are cash-lane horses).

From the 244 active cash-lane horses outside the pilot club: never seated in a running tournament, no anti-cheat flag in 14 days, under the 10-club membership cap, not resting on Friday, not already at today's cap (146 qualify). Ranked by how many hours of 13:00 to 23:00 UTC their activity window covers (the HorseBehavior window: start `h mod 24`, length `10 + ((h >>> 5) mod 8)`), then by lowest 48 hour cash load. Every one of the 72 covers at least 6 of those 10 hours.

The second prepare (run 39997955967, read-only) refused too: the 17:30 UTC Midday Free Buy freeroll had seated 156 cash-lane horses, including pinned ones, after selection. Selection already required no running-tournament seat; preparation now records any later seat or entry instead of refusing it. Joining and funding touch no seat or entry, and the standing assignment lets running games and existing entries finish, as it does for the original 72.

The exact 72 are pinned in `docs/lightning/PILOT-ROSTER-EXPANSION-2026-10-23.json` (SHA256 `f1e1b8f58f60ed8e1ba1d4d6158c0849ef8467ce2522f75e906b47f5da2964bc`). The standing assignment manifest becomes `docs/lightning/PILOT-ASSIGNMENT-MANIFEST-2026-10-23.json` (144, SHA256 `3e61e6fc2157a833a83a5e7096b4ff2bbfef802f0ce8dfe2feb5944faa680820`).

## How It Is Done

- `Lightning Pilot Roster Expansion` workflow (`scripts/ops/lightning-pilot-roster-expand.mjs`): prepare, then one execute per operation id, with the same provider ownership guard as the roster workflow. Each horse joins through its own session (`fn_join_club_atomic`), the owner approves (`fn_review_join_request`) and the owner sends 200.00 from the club bank to the player wallet (`fn_club_bank_send`, one deterministic op id per horse), the same amount every original pilot horse received. Every funding receipt is proved against `cashier_rpc_operation_intents` and the single `club_bank_send` ledger row. An unknown outcome stops; nothing is retried or replayed.
- Migration `20261023161412`: the assignment row admits exactly one of the two reviewed manifests with its exact list; `fn_lightning_pilot_assignment_set` accepts either and records the manifest and list it was given; the zero-cost withdrawal door and receipt read admit a participant of either manifest; readiness recognizes the new reviewed control definition by md5.
- `Lightning Pilot Assignment` (`assign`, new operation id, standing, no release date) then names the 144.

Public Lightning stays off. Only the two private pilots are affected.
