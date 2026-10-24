# Agent downline table watching

Owner request: ensure all agents can watch their downlines on any table they are playing on.

Scope: active agent, super-agent and sub-agent recursive downlines; cash, union, other-club and Diamond/tournament tables; observer restrictions cannot defeat verified downline observation. Preserve normal spectator card visibility and all playing/buy-in/financial permissions. No player/financial writes for testing.

Owner: this chat 01a16ba1. Owned branch fix/agent-downline-watch-01a16ba1; owned checkout /Volumes/SmarterWork/agent-work/agent-downline-watch-01a16ba1-sparse. Base 1a2bd6184bc91f304a06650afe91240c19f89d3b. No prior checkpoint or PR for this task.

Policies freshly read 2026-10-24T01:58Z: canonical AGENTS.md, AGENT-OPERATING-LAW.md, AGENT-HARDENING-STANDARD.md, AGENT-REFERENCE-INDEX.md using canonical reader. Version 2.9, manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b; owner b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349; law a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5; hardening d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e; index adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555. Also read MAC-STORAGE.md and repository AGENTS/CLAUDE/playbook/publishing/deploy-paths, including fresh origin/main differences. Current engine activation is daily 04:00 Chicago; no emergency is assigned.

Access: authenticated gh and Supabase execute_sql work. Production function definitions inspected read-only: watch gate lacks downline exception; engine TableViewerAccess has the same gap. No production changes yet.

Storage: mounted external /dev/disk5s4, approximately 2 GiB free. Full worktree checkout was stopped after repeated interrupted loose-object reads. Its unregistered partial folder belongs only to this task. Supported no-checkout/sparse worktree recovery is in progress; no other task modified.

Acceptance: shared authoritative downline permission; no spoofed actor, unrelated/suspended/removed relationship access; cycle-safe recursive hierarchy; current cash/tournament presence; search and click-time results agree with engine HTTP/WebSocket entry; meaningful native PostgreSQL + engine regression checks; required protected merge/install/publication; actual live identity and behavior. Pending all implementation/check/delivery evidence.

## Implementation and local validation (2026-10-24T02:07Z)

Fresh canonical policy reread at 02:07:46Z, same version and hashes above; owned portable check --canonical passed. Required provider secret names verified present (metadata only): DATABASE_URL and maintained HETZNER/CA_ORIGIN names. No secret values read.

Implemented: authenticated cycle-safe recursive downline/current-table helper; active agent/super-agent/sub-agent support; metadata RLS, complete search (including deep managed/playing lookup and anonymous tables), click-time access, engine shared observer gate. Cross-club/union-only tables and Diamond restricted observer cases covered. October 11 no-dollar and Free Buy label correction retained after comparing production fn_search_players with maintained historical corrections. No hole-card or financial permission changes.

Checks passed: root and server npx tsc --noEmit; 101 focused engine/HTTP-handler/card-visibility tests; focused search/law tests (23 initially; final changed source contract suite 15); full law registry/source suite 1083; native PG17 fixture proves original active recursive agent refusal and then passing downline, RLS, cash/tournament/union, depth >20, cycles, all agent roles, spoofed actor, inactive relationships, departed seats and stale targets; existing privacy/fuzzy/live-table checks remain passing. Window migration static admission passed. Native fixtures run in short external SSD scratch because long socket paths cannot start PostgreSQL. Dependencies are private locked installs; initial missing vendored auth archive recovered from this exact Git revision, then install passed.

Delivery classification: engine runtime + database + regression/docs. Metadata SELECT policy needs ShareRowExclusive on hot public.tables, so migration 20261024020328 declares daily-maintenance. Routine engine activation and database installation must use existing daily 04:00 America/Chicago route. No urgent/emergency authorization inferred. No production migration, restart, player or financial write performed. Next eligible window: October 24, 2026 04:00-04:05 America/Chicago. Protected submission/checks/merge remain actionable now; installed/live proof remains pending.
