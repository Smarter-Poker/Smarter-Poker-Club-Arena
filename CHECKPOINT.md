# Global chrome mobile regression — 2026-10-18

Scope: deliver phone header/footer artwork from unpublished PR #7265, preserving current main's member/operator footer permissions, routes, portrait hairline, safe areas, desktop dimensions and sticky/fixed positioning. Inspect header finish against owner clarification. No engine or database changes.

Owned checkout: /Volumes/SmarterWork/agent-work/global-chrome-mobile-20261018
Branch: fix/global-chrome-mobile-20261018. Owner: this chat.
Base: b39e18a75. Source recovery: 56b836eee, open PR #7265 unchanged since Oct 17; no registered worktree on that branch. Only assigned chrome recovered; unrelated deck/join changes remain excluded.

Policy reader emitted 2026-10-18T20:56:05.261Z; version 2.9; manifest a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b. Full canonical references and storage guide read; SSD /dev/disk5s4 with 12 GiB available. Owner hash b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349; operating a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5; hardening d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e; index adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555.
Repository AGENTS, CLAUDE, AGENT-PLAYBOOK, PUBLISHING, deploy-paths and console skill read. Configured GitHub authenticated; normal hooks retained. Private locked npm dependencies installed on SSD.

Cause: current protected main never received dedicated phone art from PR #7265. Desktop 1648/168 header and 1866/230 footer are scaled to phone width. At 393px: 40px/48px. Recovered phone planes yield 46px/61px. Newer member footer has five doors; retain it using native CSS slices removing only four empty gaps, plus aligned five hit regions. No image distortion or Data door for ordinary members.

Acceptance: responsive rendering at 375/393/430/600/601/768/901/1680, aligned portrait and targets, both footer roles, no horizontal overflow, desktop unchanged; affected tests/compiler/copy gates; required PR checks; protected merge; publisher success; both live build-info and affected render.

Initial tests: 63 passed across GlobalHeaderNav, portrait law, footer clearance, approved hamburger suites. Remaining: final tests/render, submission and live proof.

Final local results: tsc --noEmit -p tsconfig.app.json passed; all four copy gates passed; policy check --canonical passed. 63 initial covering tests, 47 connected checks, 51 final header/footer checks passed. Chrome portrait pixel proof passed across 375/430/768/901/1280/1680; test now compares both rails with the actual unmasked black-finish artwork rather than obsolete silver brightness. Before/after geometry across eight widths and both footer roles: no horizontal overflow, exact unchanged dimensions above 600px, phone 46px header and 61px footer at 393. Evidence under /Volumes/SmarterArchives/agent-evidence/global-chrome-mobile-20261018.

Pre-push caught an obsolete Phase 6 blanket srcSet prohibition (456 tests passed, one failed). Updated that contract to allow exactly one 600px phone source and pin its approved asset hash, budget and optimizer preservation. No guard bypass. Live browser baseline on Shark Club confirmed desktop-black-v2 is already serving; phone width 385 content (393 viewport) header39.23/footer48.44. A newer desktop frame cannot yet be identified; owner clarification is pending independently.

PR #7390 at head4f9ebbb5c; local pre-push passed (457 source-contract +705 related tests). CI39165972820 started normally after hosted-runner queue. Required money authority passed. Before final validation, canonical reader freshly emitted unchanged2.9/hash receipt at2026-10-18T21:01:12.943Z. Review of scheduled CSS browser coverage identified two old footer fixture assumptions: desktop-only art/aspect and image-parent=frame. Updated responsive picture/height/aspect and frame locator. Both footer visual and header portrait browser specs passed locally (2 tests,13 width cases).
