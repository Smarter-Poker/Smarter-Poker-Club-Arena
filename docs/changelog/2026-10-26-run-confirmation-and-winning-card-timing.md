# Run Confirmation And Winning Card Timing

Owner: Codex, chat 01a17b12. Branch: agent/codex/rit-timing-01a17b12.

Scope: show the final two/three-run confirmation once for 1500ms; per-player accepts only update the consent panel. Keep each winning-card result visible 1500ms longer, including each RIT board. Preserve decisions, payouts, dealing and animation safeguards. Client and mirrored engine timing change; no database change.

Policy read 2026-10-27T01:56:50Z: version 2.9, manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b. Canonical four policies and storage guide read. Base 93d49d86f7. Required delivery: focused timing/consent tests, compiler, normal hooks, protected merge, static publication and engine activation with live behavior proof. Status: implementation in progress; no publication claimed.

Validation: 119 focused client tests across eight suites passed; 38 engine pacing/runout/showdown tests passed; client and server TypeScript checks passed. Policy canonical parity passed. Production bundle check pending. The pre-existing 25.5-second three-run timeline assertion is intentionally updated to 30 seconds (three extra 1500ms result windows).
