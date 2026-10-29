# Tournament HUD actual paid places

Scope: client-only Paid column after Left and before Avg, using the actual finalized finishing-place payout ladder. Parent task owns protected integration, publication and production proof; this helper does not push or release. Branch `fix/tournament-hud-paid-20261029`, base `cdea2991ad18998a673d9420a9edca66547f7c9e`.

The HUD reuses its existing tournament row and event refresh. `tournamentPaidPlaces` uses the canonical payout parser, requires contiguous positive awards and finalization for ordinary tournaments, uses drawn Spin tiers, and omits unsupported satellite entitlement or unavailable/malformed data. Bounties are not counted. No preview estimate, zero fallback or constant eleven. Paid prints with locale formatting. Existing painted geometry is unchanged; the maintained useFitText hook fits longer Blinds/Next text inside its existing columns.

Read-only actual data evidence: Evening Mystery Bounty (PLO5), tournament `853b3df9-9e15-4d05-97b1-7a38dd0345c1`, finalized stored ladder has places 1 through 11; NLH Heads Up 10 `0813ac86-8db6-4602-a945-d1f3eb3458f8` has only place 1. No production writes.

Validation:

- New real-HUD dynamic Paid regression fails against unchanged baseline: missing Paid, exit 1; candidate restores it and updates 11 to 3 on the existing late_reg_closed refresh.
- `vitest run tests/unit/tournamentPaidPlaces.test.ts tests/unit/tournamentHudPolling.test.tsx tests/the-tournament-box-is-under-the-action-bar.law.test.ts`: 62 passed, three files.
- `tsc -b --pretty false`: passed under Node 22.23.3.
- Isolated actual component/CSS in real Chrome, loaded fonts, 375px and 393px: all seven segments fit; no clipping of Blinds Ante 500, 2,500 / 5,000, Next 2,500/5,000, Left 13, Paid 11 or Avg 75K. This is development proof, not live DOM proof.
- Evidence and fixture archived at `/Volumes/SmarterArchives/agent-evidence/tournament-hud-paid-01a1832e-20261029`.
- Protected CI, merge, publication, both build-info readbacks and affected live proof remain pending with parent. No engine change or activation dependency.

Fresh canonical policy reader receipt 2026-10-29T00:57:40.317Z, policy 2.9, manifest `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`; owner `b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349`, operating `a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5`, hardening `d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e`, index `adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555`. Required canonical and repository/product/art references read; work is on verified external shared-capacity volume. Cleanup follows parent integration.
