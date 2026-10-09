# A Refused Hand Whose Seats Have Closed Frees Its Table

**Date:** 2026-10-09

Three Diamond cash tables (22a9bc88, 6b47e87b, 6e1b1d4e) had not dealt since 2026-10-07. Each held exactly one hand the settlement contract refused (`diamond_hand_stale_seat`): the whole commit rolled back, so nothing of the hand was durable, and a canonical failure row recorded it. All 13 chairs those hands named belonged to horses and every one had since closed, so the request could never apply.

The resume door (`fn_ca_resume_hand_submission`) disposed a retained hand only when a later hand had committed past it. A table that never dealt again was never "dealt past", so the engine found the same refused hand on every start and held the table, recheck after recheck, while the horse fleet kept seating new horses there (17 horses and 21,745 Diamonds of their buy-ins at three tables that could not deal).

| Change                                                                                                                                                                                                                                                                                                                                                    | Where                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `smarter_private.hand_submission_dispose_refused_vacated` disposes such a hand with zero credit. It proves a cash table, no freeze, the table's disposal lock, a canonical refusal for this exact request, every named chair closed, retained over 30 minutes, and no commit, history, disposal, handoff, dispatch, open F06 permit or live dealer lease. | Migration 20261009161306               |
| The resume door calls it beside the dealt-past disposal.                                                                                                                                                                                                                                                                                                  | Migration 20261009161306               |
| A table held by a retained-hand refusal gets no horses.                                                                                                                                                                                                                                                                                                   | Engine, `HorseFleetManager` (PR #6588) |

The disposal was proved on production in a rolled-back transaction first (1, 1, 1 for the three hands), then applied. No money moved: the hand never happened, which was already the state of every stack.

Law: `tests/a-refused-hand-frees-its-table.law.test.ts`.
