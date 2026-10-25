# Horses stop flatting the aggressive human's 3-bet (V53, 2026-10-24)

Dan: "PROCEED TO THE NEXT PHASE", after the V53 pressure layer went live
(bbd6db8e, serving). The next leak was read from production first (WooWoo, PLO5,
4 days, SELECT only), by preflop line, WooWoo's result per hand:

| line                     | hands | WooWoo per hand |
| ------------------------ | ----- | --------------- |
| he opens, a horse 3-bets | 92    | -14.1 bb        |
| a horse opens, he 3-bets | 146   | +5.6 bb         |
| limped                   | 116   | +5.3 bb         |
| a horse opens, he flats  | 388   | +2.2 bb         |
| he opens, no horse 3-bet | 202   | +1.5 bb         |

When a horse opened and he 3-bet, the horse's CALL lost 14.9 bb a hand (88
hands, -1,308 bb), its fold lost 4.2 bb, and its 4-bet WON 17.4 bb a hand (26
hands). The V38 maniac path flatted whenever raw equity cleared the price plus
a 3-point realization margin, and 4-bet only all in.

A river repair was considered and dropped on the same evidence: horses that
raised his river bet won +591 bb over 25 spots; calls ran -1.6 bb a spot.

## The change (read-gated, inside V38)

Hero opened, a pressure target (aggressiveBettorPressure) 3-bet it, the
3-bettor is not all in: the flat needs 10 points of realization out of
position (5 in position), and a hand clear of that bar by 6 points 4-bets (pot
in pot limit, 2.3x in no limit). Receipts `v53_pressure_four_bet`,
`v53_pressure_three_bet_priced`.

Harness (real HandController, identical decks, 600 PLO5 hands): facing the
human's 3-bet the horses went from 1 fold / 101 calls / 8 4-bets to 8 / 52 /
51, and the horses' net improved by 102 bb/100 on that seed. HorseManiacPressure
law, neutrality law and the exploit suites pass. Pinned in
HorseV53PressureBehavior.test.ts.

## Continuation checkpoint, 2026-10-25

Owner: Codex chat 01a1736b. Recovered PR #7986 at cfd410feb5 in the private
SSD worktree `plo5-resume-01a1736b/source`, branch
`codex/plo5-resume-01a1736b`. Scope is the two V53 follow-ups in the supplied
handoff: preserve #7963's barrel pressure, finish #7986's read-gated response
to a three-bet, validate the shared Classic/Lightning decision path, and
complete protected delivery and live proof. Other horse-audit programmes,
solver commissioning, balances, game rules and player settings are excluded.

Acceptance: preserve both harness tallies through integration; reject an
unaccepted horse action in the behavioral harness; pass focused strategy,
neutrality, legality, clock, shared-worker and source-contract checks plus
compilation and normal hooks; pass exact-head required CI; protected merge;
approved engine installation and serving ancestry; natural new feature
receipts. A seeded simulated win-rate difference is not a production profit
claim or a reason to alter unrelated river strategy.

Current-policy reading: canonical reader 2026-10-25T14:26:10.792Z and owned
portable reader 2026-10-25T14:35:09.398Z, policy 2.9, manifest
`a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`.
Owner/law/hardening/index SHA256 respectively:
`b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349`,
`a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5`,
`d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e`,
`adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555`.
Read the complete current repository entrypoints, publishing/deploy paths,
storage guide and applicable source; no nested server entrypoints found.
Portable policy check against canonical passed. SSD disk5s4 mounted with
free space; all new dependencies/cache/scratch remain on that disk.

Recovery evidence: #7963 merged as 899ceacc and is an ancestor of serving
0eae61b20fb4c0224618941d947fb7cdcb72b653. SELECT-only telemetry on October 25
showed 28 `v53_pressure_barrel` fires and no four-bet receipts. #7986's old
CI 40158297830 failed only the random tank-clock fixture (6762 other shard
tests passed); protected main already pins that first action to stay in the
hand. Recovered-branch focused baseline passed 32/32. Initial premature
test/import and root-install attempts encountered incomplete sparse source;
those were setup failures, not behavioral results. Owned source recovery and
locked dependencies were completed without touching another checkout.

Integrated main 21062fe3, preserving both sides of the harness and both
historical owner-window entries. The phase-two window expired at
2026-10-25T09:14:14Z and cannot authorize a new cutover. Current routine
maintenance is 04:00 America/Chicago, not hourly :55. No watcher, release
timer, off-cycle reset, migration or financial write has been initiated.
Source, new exact-head CI, merge, installation and final live proof remain
separate acceptance states.

Combined-source qualification: server compiler passed after merge 4fd06f1489.
The added invalid-raise regression first failed because the harness silently
substituted a call; the maintained harness now throws on any rejected horse
decision before fallback. Its existing real-controller arms still complete
and conserve chips. Focused final run passed all 162 tests in nine files
(58.48 seconds), including V53, data ledger, maniac pressure, exploit
neutrality, premium continuation, Lightning clocks, shared-worker wiring and
the real full-brain worker. Exact-head normal hooks and hosted CI still remain.
