# Player and rake statistics accuracy and live invalidation

The member-ledger screenshot is Rooster #1004748 in KINGS CLUB. For the applied UTC range 2026-10-26 through 2026-10-29, independent source reads matched 106 cash hands, 187 tournament hands, 43.64 cash rake, 18.50 tournament fees, +48.70 cash result and -35.45 tournament money (204.55 credited minus 240.00 charged to prize liability). Draft dates require Confirm and do not describe the displayed totals.

## Corrected behavior

- Member performance selected-game fees omitted tournament charges because tournament hand facts have zero cash rake. The reader now adds immutable tournament-fee receipt credits for that game, club, member and inclusive UTC dates, retaining the fee-counting floor. Rooster NLH had 8.00 of paid fee receipts but displayed zero. The All Variants calculation and all hands/rates/net fields stay on their existing contracts.
- Personal Stats refreshed its overview on live changes but never refreshed its separately fetched Rake and cash-opportunity readings. Those reads now share a live revision with the overview invalidation, including separate lifetime and club-comparison reads.
- Personal Stats subscribes to the existing authorized private member-record events for the selected club, or its loaded membership clubs for All Clubs. Reconnect requests an authoritative read. No raw hand-row subscription or new polling mechanism is added; the existing pulse remains as the established fallback.
- The existing two-second coalescing window keeps its first deadline. Repeated events previously reset the deadline indefinitely; an active table can no longer starve the update.

## Verification and limits

Component regression reproduced one rake read remaining at one after a live change; it passes with the maintained fix. Component tests cover live read invalidation, repeated-event starvation, subscription identity, club deduplication and reconnect. Native PostgreSQL executes the actual reader migration after reproducing the missing fee, tests game/member/club/date isolation, UTC end boundaries, counting floor, cash rake, authorization, unchanged fields and replay refusal. It runs inside the existing required Member Record / Data Console qualification.

Production observation before delivery: an open active member-performance page advanced 41,348 to 41,354 hands and its fee total without a manual refresh. A bounded 30-history sample contained 13 hands dealt to the observed player; all 13 had facts and all rake shares matched attribution receipts (27.85 total). The maximum measured fact creation delay after hand-history persistence was 3.829210 seconds. This is measured asynchronous capture, not a claim of millisecond delivery or an audit of all historical hands.

Personal Stats read for Rooster's seven-day Chicago calendar window matched independent facts: 564 total / 314 cash / 250 tournament hands, +318.61 cash net, 280.99 cash rake, 34/363 three-bet opportunities and 27/31 flop continuation-bet opportunities. These dates differ from the screenshot's applied UTC range; the totals must not be compared without matching scope. Member performance labels three-bets per hand; personal Stats uses recorded opportunities, so those rates intentionally have different denominators.

Client/database delivery only: existing private event contract, no engine replacement. Production installation, publication and post-delivery behavior require separate checkpoint evidence; local test success does not establish live adoption.
