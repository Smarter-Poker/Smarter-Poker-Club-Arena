# Club Arena Product Completion: Checkpoint

Assignment: CA-PRODUCT-COMPLETION-2026-09-22 (Prompt 1). Integration owner: Claude (cloud session linked to the
owner's Mac). Last updated 2026-09-24 13:25 UTC.

Status vocabulary (mandatory): Observed In Source; Observed In Live Definition At A Stated Time; Historical;
Proposed; Implemented; Tested; Merged; Installed; Published; Production-Verified; Unknown.

## Policy receipt

`node docs/agent-policy/agent-policy.mjs read` at a759cf82 (2026-09-22 13:49 UTC), policy version 2.9.
OWNER-POLICY 76228d75..., OPERATING-LAW a8bc3c04..., HARDENING d5fc451c..., REFERENCE-INDEX adce89c3...

## Owner-locked rules honoured

No OFC. No dollar subscriptions or rejected plans. No commerce activation in this workstream (Prompt 2 owns catalog,
prices, trials, charges). No cron, reconciler or repair loop. Horses identical to humans. Existing accounting,
hierarchy, maintenance and security safeguards preserved. Server-owned authority for money and access.

## Production database installation (done, owner-approved)

The owner approved the installs on 2026-09-24. Every migration was applied from its own file through
`apply-merged-migration.yml` (dispatched on the candidate branch, one transaction each, outside the :50-:03 UTC
window), and every `@live-proof` line was read back true afterwards.

| Version                                             | PR    | Installed (UTC) | Notes                                                                                                                                                                                                    |
| --------------------------------------------------- | ----- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20260922153234 membership cap                       | #5179 | 10:15           | 7/7 proofs                                                                                                                                                                                               |
| 20260924025555 capability registry                  | #5178 | 10:17           | 6/6 proofs; every live tournament has an acceptance row                                                                                                                                                  |
| 20260924034010 kill table settings                  | #5180 | 11:04           | first attempt refused before writing (production `tables.big_blind` is `numeric(15,2)`); precondition fixed and pinned by a harness case, owner re-approved                                              |
| 20260924033701 creation rules                       | #5182 | 11:05           | post-image md5s match                                                                                                                                                                                    |
| 20260924045822 schedule time zone                   | #5189 | 11:06           | installs on 033701's post-image                                                                                                                                                                          |
| 20260924045900 member status                        | #5183 | 11:07           |                                                                                                                                                                                                          |
| 20260924043217, 043224, 043232 multi-day foundation | #5185 | 11:08-11:10     | BAGGED validated                                                                                                                                                                                         |
| 20260924043239 multi-day stage RPCs                 | #5185 | 13:04           | first attempt refused before writing by the production money-RPC DDL guard; the owner approved registering `fn_bag_tournament_stage` and `fn_seat_stage_entitlement`; the harness now carries that guard |
| 20260924063656 multi-day stage view and doors       | #5188 | 13:05           |                                                                                                                                                                                                          |

Capability readiness is unchanged (writes to the registry need the owner's approval): `club.membership_cap`
implemented, `tournament.discovery.trait_filters` tested, `cash.fixed_limit.kill_pots` and both multi-day ids
planned. Multi-day stays unreachable until R6.

## Recorded findings reconciled

| ID     | Finding                                | Status (evidence)                                                                                                                                                                                                                                  |
| ------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1-F01 | Unbuilt multi-day guard active         | Kept deliberately; replaced only at design step R6 (not built).                                                                                                                                                                                    |
| P1-F02 | Multi-day columns without lifecycle    | Design `MULTI-DAY-DESIGN.md` (in #5188). R1, R3, R3b, R4, R5 database: Implemented + Tested (25 cases). Database Installed. R2 and R5 engine and client plus stage view and operator doors: Tested, in #5188. R6 and R7 (multi-flight): not built. |
| P1-F03 | Kill/Half-Kill unsupported             | Table settings Installed (72 cases); engine and surfaces Tested, in #5188; capability `cash.fixed_limit.kill_pots` stays planned until the engine release is verified and the owner advances it.                                                   |
| P1-F04 | Empty MTT feature filters              | Merged #5079, Published.                                                                                                                                                                                                                           |
| P1-F05 | HUD 45 s poll / 300 s backoff          | Merged #5169 (377c4d4f); Published in client fc288985 at both build-info endpoints, 2026-09-24 06:47Z.                                                                                                                                             |
| P1-F06 | Eligibility 4 vs creation 10           | Installed, Merged (#5179), Published (91837c04); live proofs 7/7.                                                                                                                                                                                  |
| P1-F07 | club_creation = 100 diamonds, no debit | Client no longer offers the no-op purchase (#5179). Catalog row is Prompt 2's.                                                                                                                                                                     |
| P1-F08 | CrossNodeBus transport seam            | Observed In Source: not wired; single engine process. No change needed for current topology.                                                                                                                                                       |
| P1-F09 | discoverNearbyClubs ignores geography  | Unused hook removed (#5171, merged).                                                                                                                                                                                                               |
| P1-F10 | Insurance / EV Cashout                 | Observed In Source: wired end to end; registry seed `deployed`.                                                                                                                                                                                    |
| P1-F11 | OFC current-facing claims              | Merged #5159, Published.                                                                                                                                                                                                                           |
| P1-F12 | No production behaviour proof          | Recorded per delivery below.                                                                                                                                                                                                                       |

Additional defects found and fixed in this workstream:

- A member could PATCH their own `club_members.status` back to active after a suspension or ban: #5183.
- Recurring schedules ran one local hour off after every daylight saving change: installed; engine and client in #5188.
- Tournament creation surfaces applied different rules and hid server refusals: client Merged #5177 and Published
  (fc288985); server refusals Installed.
- Kill settings sent in `p_overrides` were silently dropped by `fn_cash_game_create`: fixed in #5188.
- Two prepared migrations pinned the same preimage of `fn_upsert_tournament_schedule`, so the second could never
  install: the schedule change was restacked on the creation rules; both Installed.

## Decision register (integration owner, within assignment authority)

- Membership cap = 10 human memberships; horses keep the existing trigger exemption; one cap/count/lock authority.
- Kill rule `kill-v1` (docs/rules/kill-pots-kill-v1.md in #5188).
- Multi-day v1: same tournament row across days with a BAGGED status (MULTI-DAY-DESIGN, in #5188).
- Capability registry in the database; the TypeScript mirror, hook and law ship byte-identical with each consumer
  (#5188), pinned to `scripts/ci/fixtures/capability-registry/seeds.json` (#5178).
- Accepted-event continuation for Prompt 2: commerce checks must allow operations while
  `fn_event_continuation(kind, id).continuation_active` and must not create new events on it (CAPABILITY-CONTRACT.md
  in #5178).
- `MembershipService.updateStatus` requires the server to confirm exactly the requested status.

## Deliveries

| Work                                                                                                                       | PR    | State                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Tournament discovery filters                                                                                               | #5079 | Merged, Published                                                                                                                    |
| OFC not offered                                                                                                            | #5159 | Merged, Published                                                                                                                    |
| Club surfaces say what they do                                                                                             | #5171 | Merged, Published                                                                                                                    |
| Tournament HUD events                                                                                                      | #5169 | Merged, Published                                                                                                                    |
| Creation rules (client)                                                                                                    | #5177 | Merged, Published                                                                                                                    |
| Membership cap                                                                                                             | #5179 | Installed, Merged, Published (91837c04)                                                                                              |
| Capability registry + continuation                                                                                         | #5178 | Installed, Merged                                                                                                                    |
| Member status is server-owned                                                                                              | #5183 | Installed, Merged, Published (2b55625a)                                                                                              |
| Kill (database, engine, surfaces), creation rules (server), schedule time zones, multi-day foundation, engine and surfaces | #5188 | Installed; one combined PR (folds #5180, #5181, #5182, #5185, #5186, #5187, #5189); engine release at a certified window after merge |

All branches are prefixed `agent/claude-ca-product/`.

## Not built (open scope)

- Multi-day R6 (guard replacement) and R7 (multi-flight), and the `blocked` stage receipt.
- Phase 5.5 exports, 5.6 visual acceptance screenshots, 6.4 capacity measurement, 6.5 onboarding.
- Phases 7 and 9 production acceptance of Kill and multi-day behaviour (needs the engine release and the owner advancing readiness); Phase 10 final checklist.
- Owner questions in MULTI-DAY-DESIGN section 10, plus: should the app-wide tournament auto-seat open a Day 2 table
  tab as it does at the first start?
