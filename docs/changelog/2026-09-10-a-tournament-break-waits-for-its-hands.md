# A Tournament Break Waits For Its Hands

The Phase 3 K05 rehearsal reproduced six break defects. Sequential persistence shifted different tournaments' countdowns by two seconds; a late entrant inherited the same drift. An entrant arriving during the drain received a countdown before all hands finished. Failed table inspection counted as parked, a 121-second hand outlasted the 120-second drain limit, and an earlier parked table could self-release after its initial 420-second budget.

The owning GameServer now waits for every participating table boundary while its generation is active. An unknown inspection cannot start the countdown. Live and recovered synchronized breaks request explicit manager release, while ordinary hand-for-hand keeps its existing safety timeout.

The countdown uses one absolute deadline for all tournament rows and the shared resume timer. A newcomer during the drain is held without a fabricated deadline and joins the final countdown participant set.

Verification: the baseline failed 6 of 8 actual-runtime behavior cases. All 8 now pass, together with 4 existing lifecycle-fence cases. Server TypeScript and the diff whitespace check pass. Persistence and table-boundary responses are controlled fixtures; no production chips or deadlines were changed.

The scope evidence is `docs/audits/2026-09-10-phase3-clock-deadline-evidence.json`. This local correction does not close the complete Phase 3 clock controls or claim deployment. Required CI, root integration and production engine adoption remain separate verification steps.
