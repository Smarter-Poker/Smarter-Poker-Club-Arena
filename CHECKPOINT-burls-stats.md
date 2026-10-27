# Burls player statistics accuracy audit

Owner: chat 01a17e6e. Scope: Player Stats data producers, persisted facts, RPCs, service normalization, visible stats/comparison/coaching, related profile/HUD/export consumers. Repair demonstrated connected defects with regression coverage; retain player records and financial invariants. No unrelated product redesign or strategy changes.

Checkout: /Volumes/SmarterWork/agent-work/burls-stats-01a17e6e. Branch fix/burls-stats-20261027. Base e9725f3a7a. No existing checkpoint for this new assignment found; root CHECKPOINT.md belongs to global chrome task and is preserved.

Policy reader 2026-10-27T17:35:31.197Z, v2.9, manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b. Read full four canonical policies, storage guide, repo AGENTS/CLAUDE/AGENT-PLAYBOOK, PUBLISHING, deploy paths. Owner b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349; operating a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5; hardening d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e; index adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555. Platform skill read; historical release restrictions superseded by current owner policy.

Acceptance: independently derived counters/denominators; absent observations never shown as measured zero; scope/units/time ranges consistent; relevant action types and tournament/cash paths covered; regression tests and compiler, protected merge, installation/publication and live affected behavior. No claim of universal absence of future defects.

Early access: gh authenticated Smarter-Poker. Both Supabase connectors list only pepnationlab-prod and PokerIQ-Production, not established Club Arena database; do not query unrelated project. Investigate maintained configured database route. SSD mounted separate disk, initially 4.6 GiB free, 3.4 GiB after checkout.

Finding: OverviewTab unconditionally feeds overall.three_bet_percent into BenchmarkPanel despite metric_availability; PerformanceTab uses separately loaded exact cash opportunities. Under investigation, not yet repaired or live proven.

Production identity recovered from package.json types:generate: Club Arena uses PokerIQ-Production kuklfnapbkmacvwxktbh. Earlier connector ambiguity resolved; authenticated SQL reads succeeded. Burls is 7e616640-58dd-4d8d-a18e-2f37f057bcd9, active KINGS CLUB member. No session/token was created or revoked; read-only RPC inspection used transaction-local claim context and existing server authorization.

Production baseline: all facts 2,596 hands, 45 three-bets / 1,214 opportunities (cash15/372, tournament30/842). This is the current recorded population, not the older screenshot's exact time. Club funding scope has2,481 hands,693cash,44three-bets, RPC three_bet_percent=0 with availability=false. All Clubs inherited750-hand advanced sample:52showdowns, WTSD0.0693 versus club203showdowns/540flops=0.3759. Club AF0.61 divides655-ish aggressive actions by1062checks+calls, not calls only. All Clubs lacked metric availability entirely. Full-window financial totals and generic health do not establish every stat's correctness.

Implementation in progress:3-bet/C-bet authoritative reader correction; All Clubs full-window advanced rates/denominators, tournament-count/finish/bounty wiring; client availability across comparison, advanced cards, profile, CSV and alert evaluation. AF exact call capture and true elapsed-hour coverage remain explicit acceptance gaps. No universal audit completion claimed.

Initial local stats sweep:49files/488passed, then new profile test initially failed due a fixture missing contract_version, corrected fixture. TypeScript passed before later source formatting; final rerun required. Isolated PostgreSQL predecessor/candidate regression passed before additional tournament-result assertions; final rerun underway. Artifact logs: /Volumes/SmarterArchives/agent-evidence/burls-stats-01a17e6e. No merge/install/publication yet.
