# The VPIP readers judge the same window as the eviction

Found while auditing the PLO5/PLO6 Classic 50% floor (20261024213131).

That migration turned the floor on mid-sitting and correctly started the
maintain window at the later of the player's join and the game's
`vpip_floor_since`, but only in `fn_nit_check`, the enforcer. The two readers
carried their own copy of the window and kept counting hands from before the
floor existed:

- `fn_nit_status`: the figure every horse steers by (`ownVpip`, `vpipFloorMul`).
- `fn_cash_vpip_status`: the player's own VPIP tracker on the felt.

Measured at 23:20 UTC on five live Midway tables: `fn_nit_status` flagged 20
seated players (31-49% over up to 850 hands) for eviction while the enforcer
judged the same players on the hands since 21:33 (850 vs 310 for one seat) and
stood nobody up. Horses were loosening toward a floor they already met, and a
human's tracker would have shown "below the floor" when the rule disagreed.

Fix (migration `20261024232218`): the window is one function,
`fn_nit_sitting_since(game, user, fallback)`, and all three call it.
`fn_nit_check` is patched by anchor; the two readers are replaced with bodies
identical to the live ones except the window (verified by md5 against the live
source with only that block substituted). The migration then proves, on live
floored tables, that the reader and the eviction flag exactly the same seats.

Law: `tests/the-vpip-readers-share-the-evictions-window.law.test.ts`.

## Delivery recovery, 2026-10-25

Owner requested completion of this handoff, including lobby sorting, VPIP
reader/enforcer agreement, horse tuning evidence and CI checks. Current writer:
Codex in `/Volumes/SmarterWork/agent-work/mixed-vpip-finish-20261025/tree`,
continuing existing PR #7966 and its branch. No competing registered worktree
owns that branch. Lobby fixes #7875, #7907, #7914 and #7922 are merged;
both client endpoints serve `21062fe3ac66d9e19faa5f8378e38a3bfe3c8cde`,
which contains #7922. #8000 is merged; its measured decision retains the
current horse target. No new engine behavior is required by this migration.

Read canonical owner policy, operating law, hardening standard, reference
index, storage guide, repository AGENTS/CLAUDE/AGENT-PLAYBOOK/PUBLISHING and
deploy-paths. Policy reader: 2026-10-25T14:36:18.215Z, version 2.9,
manifest `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`.
Owner SHA256 `b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349`;
operating `a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5`;
hardening `d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e`;
index `adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555`.
SSD verified on its own disk with 106 GiB free. Private dependencies on SSD.

Recovered head `f991d486fa97ac493fab03e99e4bfb980a2ba038` had passing hosted
checks but conflicted with main in the time-bank regression. Retained main's
already improved `pinHorseTempo` non-fold decision option, avoiding duplicate
mock wrapping. Live function hashes still match all three migration guards;
version `20261024232218` is absent from migration history. Required remaining
proof: final local/hosted checks, protected merge, exact guarded installation,
function/grant/history readback and live reader/enforcer comparison. Preserve
unrelated production rows and active work; no financial/seat writes for tests.
