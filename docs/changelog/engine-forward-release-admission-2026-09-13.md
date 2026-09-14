# Admit forward engine releases while protected main advances

A newer merge could reject an already built engine candidate before the next certified break. A retained deployment log records a completed bounded build followed by a stale-target refusal; continuous merges could keep repeating this cycle.

Normal releases now require the exact target and workflow control commits to remain in protected main, and require the target to contain the durable sealed high-water release. Newer unshipped commits are recorded in notices and the release receipt. A newer sealed release still refuses an older candidate, including after an intentional rollback. The three workflow admission checks follow the same rule.

Maintenance certification, locks, immutable image verification, cutover deadlines, public and leader checks, rollback reserves, and seal finalization remain mandatory. No host resources or production settings are changed here.

The engine-triggered production certificate now preserves its requested release SHA, verifies that exact commit exists in protected main, and retains the later live engine identity checks. Schedule and web-publish certificates still select the latest engine component. Production run34779238994 demonstrated the old defect: it rejected deployed81fe7fc9 solely because main had advanced to b9819e2c, before any browser fixtures ran. A real-Git counterexample reproduces that refusal on the old source.

Validation: 141 checks passed across six release law files using the normal project configuration, including 23 cases executing actual Git histories and the actual shell admission gates. The separate queue/window suite passed 10 checks. Shell syntax and whitespace checks passed. Portable clock, timeout, and lock substitutes do not establish native timing, lock, or cutover qualification. The new Git test uses a 120-second subprocess limit inside a 125-second test limit; production budgets are unchanged. CI, merge, and live verification remain required.

CI34780470873 exposed an older degraded-engine transaction fixture that omitted the newly mandatory sealed high-water value. Its seal adapter now returns the exact source high-water SHA and the test confirms that read happens before building. The existing actual HTTP503, rollback-source, database and no-mutation assertions remain intact. No production gate was weakened.
