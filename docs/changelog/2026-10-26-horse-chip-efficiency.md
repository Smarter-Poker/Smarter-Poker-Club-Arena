# Horse chip efficiency: implementation checkpoint

Owner: Codex chat 01a1789c. Authorized October 26, 2026: fully implement, wire and test all improvements proposed in this chat. No delegation.
Branch: codex/horse-chip-efficiency-01a1789c. Base: fb048ff8c3.
Component: engine; routine activation follows certified daily 04:00 Chicago route. No forced restart.

## Acceptance register

Each item requires source/caller inspection, meaningful regression tests, exact candidate checks and deployed behavior evidence. Existing coverage counts only after verification.

1. Decision receipt correctness and intended/executed/fallback traceability.
2. Pot odds, effective calls, side pots, antes and rake-aware cash pricing.
3. Actual made-hand evaluation and draw quality, including dirty outs.
4. Position, effective stacks, preflop commitments, blinds and heads-up.
5. Multiway value/bluff discipline; blockers and calling-station adaptation.
6. Opponent context, sample confidence and stale-read handling.
7. Tournament payout, bubble, bounty and stack context.
8. Raise reopening and short all-in legality.
9. Independent decisions using only legitimately available information.
10. Value sizing and commitment decisions.
11. Reproducible paired performance gates after rake, with variant/depth regression limits.
12. Review recent costly decisions without treating losses as proof of poor decisions.

Preserve owner aggression rules, player parity, settlement/rake/payout rules, selection qualification and financial safeguards. No production synthetic chip operations. No new scheduled observer/repair/release loops.

## Reading receipt

Current canonical policies read October 26, 2026; version 2.9. Full emitted receipt retained at /Volumes/SmarterArchives/agent-evidence/horse-chip-efficiency-01a1789c/policy-receipt.txt.
Manifest SHA256 a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b.
Read root AGENTS.md, CLAUDE.md, AGENT-PLAYBOOK.md, PUBLISHING.md, deploy-paths and amended winning contract. Work only on mounted SSD.

## Status

Inspection in progress. Nothing new tested, pushed, merged or deployed yet.

## First demonstrated repairs

- PLO6 V59 raise-to-call receipt: added worker validation to the existing jack-high-flush real-brain regression. It failed before the validator change. Admit only a positive priced reduction from raise/shove in PLO6; keep foreign variants, increased amounts and fold/check-to-call refused. Not yet tied to a particular production error record.
- NLH premium value: evaluate best five and actual nut geography; board-only hands do not force value, nut straights and boats retain value despite connected board ranks. Five new assertions failed before the fix.
- NLH next-card outlook: shared board pairs are not private improvements, straight outs completing an unblocked flush are dirty, and the documented four-straight scare is now implemented. Three new assertions failed before the fix. Wired through the existing planBarrel -> HorseMind.noteOutlook -> outlookOf path; explicit drawOutlookQuality=false preserves prior algorithm for paired offline comparisons. Historical opponent-exploit neutrality isolates this independent change without altering corpus/floors.

Focused first two repairs: 4 files / 130 tests passed. Existing odds/side-pot/legal action/opponent/utility/execution checks: 14 files / 212 tests passed. Draw and existing V39 wiring: 2 files / 12 tests passed before added boundary cases. Server tsc passed after root/server locked dependencies installed. Initial compiler run overlapped root install and could not find transient chai types; repeated after installation passed. These are local results, not delivery.

Existing maintained paths under review: HorseLogic rakeDrag and contestablePot, HorsePhase5CanonicalState, authoritative HandController legalActions, HorseTournamentUtility and trusted tournament context, HorseOpponentExploit credibility, HorseScopedOpponentModel session decay, ServerTableEngineTurns publicPlayers cards firewall, HorseExecutionWitness intended/executed accounting. No new pooled private information, money rules or default strategy-pack selection.

Paired development measurement: existing runMatchup, quality on vs off, seats/depth cells (2,40), (6,40), (6,100), seeds 2601027/2601028/2601029, 10,000 duplicate pairs per cell/seed; fixed equity governor off. Retain all outcomes. Existing protected strength contracts and Lightning winning floors remain unchanged. This development sample does not replace locked qualification or prove profitability against humans.

Remaining: full final source checks (including changed-input rerun), connected worker transport proof, performance results, source/digest qualification implications, protected submission/merge, certified engine activation and scoped live readback. All other acceptance items remain open until mapped evidence is complete.

## Net call award repair

The existing rakeDrag is a marginal rate, which becomes zero at the cap. It was incorrectly used as the total deduction from a won pot. New HorseCallDeductions projects a canonical call using prepareJointPots (including unmatched returns), the controller rake, the frozen Diamond schedule and BBJ collection; main/side-pot awards use the controller's global scaling fraction. It preserves the legacy approximation on incomplete snapshots and tournament no-per-pot fees. Wired into preflop price guards/Omaha price relief, preflop call evaluation, maniac recovery pricing and postflop EV/solver-response call pricing. Existing bet-sizing marginal model is unchanged. Source closure now hashes all newly deciding dependencies.

Local final focused validation: server tsc --noEmit passed; 8 files / 157 tests passed, including real HorseLogic -> EV scalar wiring and valid premium/PLO6 receipts. Added cap, uncalled overbet, side-pot, BBJ, tournament, no-mutation, missing snapshot, preflop gross-versus-net guard cases. A reached-cap example: a 1-chip cap on a 40-chip final pot requires deducting 1/40; old marginal rate was zero. Full related test run on earlier candidate passed over 800 files without a reported failing spec before being intentionally stopped as obsolete when final source changed; not counted as a final suite pass. Final normal pre-push still required.

Read-only production review: bounded latest 10,000 seat-hand facts from a 15-minute window, then three exact hand histories. Selected costly NLH losses included KK against a set of tens (fe4fa602), AQ trips against AT full house (f6fb0a8c), and KQ top two against QQ set (8eff07e4). All inspected wager origins were horse_policy, not automatic fallback. These showdown equities are not decision-time range equities; losses are not classified as proven errors merely from the revealed cards. Private evidence retained outside Git. No production writes.

Draw-only development paired sample (before final call-pricing changes): 180,000 dealt hands, every predeclared outcome retained. No illegal actions, truncations or execution mismatches. Differences were sparse (some cells inert) and statistically unresolved; no claim of higher win rate. This is not final-candidate qualification. Locked Lightning winning floors and phase qualification thresholds remain unchanged.

Access: configured GitHub identity Smarter-Poker, repository push/maintain true; required provider secret names exist (metadata only). Both mounted SSDs used; no credential contents read. Other active chats own PLO activation and tournament aggression/reporting; their work is not overwritten or represented as this task's delivery.

Normal pre-push first attempt: root contracts 115/115 and imported-source tests 454/454 passed; changed server tests 147/147 passed. The data-ledger source contract correctly refused two unregistered ablation controls. Registered drawOutlookQuality and callDeductionPricing in the existing ledger; no guard was weakened. Stopped the obsolete local push before transport; no remote submission from that attempt. Final normal retry required.

Qualification-source precheck correction: the new call pricer reaches settlement and Diamond fee sources that some phase lists already contained. Removed a duplicate DealtSeatCensus reference (all four phase lists already hash it) and updated Phase 13's independent base-overlap cardinality check to count the four already-hashed settlement/Diamond files once. Exact closure membership, mutation-per-file checks and refusal tests are unchanged. All four phase digest/authority tests plus reference closure and call pricing now pass: 6 files / 60 tests. Added a frozen whole-Diamond fee case; chip rake columns being zero cannot imply a free Diamond pot. No selection or qualification evidence was relabeled.

Final-validation policy reread: canonical four policies emitted and fully read at 2026-10-26T15:46:45.135Z, version 2.9, unchanged manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b and file hashes above. Applicable repository/path references and this checkpoint remain the task sources. Current candidate preserves no per-pot tournament rake, canonical card firewall, exact action menu/reopening and existing qualification authority; production activation/live behavior still pending.

Connected final-rule review found a second owner of board-only value: riverNutsRaise could turn a canonical check into a full-pot bet on shared board nuts before the premium layer ran. The canonical board-quads regression failed before the repair. hasRiverNuts retains its mathematical unbeatability meaning for callers; an explicit private-value requirement is now used only by the three forced-value branches. Every board remains unbeatable, and at least one board must be improved by a hole card for forced value (Omaha retains its exact-two-hole rule). Added board-quads and board-royal-flush cases. This completes the connected repair instead of leaving the earlier helper correction bypassed. Existing river-value laws and all phase digest/authority cases pass unchanged: 6 files / 206 tests. Production remains unmodified by this branch.

Recent-hand review correction: from f6fb0a8c's public AQ-trips turn snapshot (no opponent cards in the fixture), the committed-stack branch reproduced an all-in instead of the normal raised-hand call. Controlling only MC equity isolates the early branch; its result failed the regression before this repair. The existing V21 call-only predicate now has one shared definition consumed by both the early committed branch and the later value-raise branch. The call remains available; the unnecessary extra short shove is removed. A private dry-board set still raises. The existing V21 telemetry records use; the offline-only committedRaiseDiscipline ablation is registered and isolated from the historical opponent-exploit neutrality corpus without changing any corpus bytes/floors. This is a connected bypass repair, not a blanket fold or a newly guessed equity cap. Initial related regression group: 5 files / 44 tests passed.

Final connected repair group after the committed-raise fix: 14 files / 283 tests pass, including all new cases, existing river-value laws, worker receipt checks, data ledger and all four phase qualification-source contracts. The short-shove ablation reproduces the previous all-in; a dry-board private set retains all-in and valid receipt. Compilation and final normal hook/hosted checks remain separate delivery requirements. No further strategy changes are being added to this candidate while it qualifies.

Resumption receipt: full canonical policies emitted/read at 2026-10-26T16:04:34.673Z, version 2.9 and unchanged manifest/file hashes recorded above; reread all applicable repository/publishing/area instructions and this checkpoint. Recovered clean candidate bf2b9ef1d6 and its still-running normal push before any retry. That broader run found one captured Phase 8 replay expecting the old extra shove (399521, AA facing a turn raise). The default now correctly calls; the same seeded decision with only committedRaiseDiscipline=false still shoves. Updated the replay to assert exact call cost, retained extra-stack distinction and old-behavior ablation; no legal/private/authority/phase assertions removed. Stopped only the obsolete owned local push before transport. Integrated protected main 5bb5aa8990 without conflicts, preserving its all-in-or-fold call repair. Connected replay and integration checks: 3 files / 19 tests pass. Final normal hook still required on this integrated candidate; previous interrupted broad runs are not passing evidence.

Integrated broad pre-push completed in 451.74 s: 942 server files passed, 2 failed, 1 existing skipped; 16,285 assertions passed, 3 failed, 167 existing skipped. The normal gate refused submission. Two failures were V51 historical expectations now bypassed by the new shared V21 predicate: retained the original wet-set case as an exact call, added a genuinely dry private-set jam, and isolated the V51 old-shove ablation by disabling both independent repairs. All original seeds and V51 assertions remain exercised.

The maniac-pressure failure exposed two connected issues rather than a threshold to relax. Its harness used gross pot odds; independently priced the same controller's 5%/3bb-cap award, preserving the six-point margin and all 120 hands. Two misses remained. The recovery path (unlike the direct preflop price path) sampled every unanswered seat as an already committed caller: retained J8 hearts at hand 44 was priced at 29.0% against three ranges while only the shover had committed. Preflop recovery now uses the direct pricer's existing matched-bet/all-in population; postflop includes every live opponent, and short tournament jams preserve their existing all-live responder penalty. Heads-up all-in boundary rejections now receive the same existing bounded, governor-subject confirmation as postflop. No price/range/survival threshold was lowered. Debug instrumentation was removed. The original controller pressure law plus V51 and marginal-flop/governor tests pass: 3 files / 30 tests. New direct population/net-price/refinement boundaries pass: 3 tests. Full hook must be rerun; these are local repairs, not production proof.
