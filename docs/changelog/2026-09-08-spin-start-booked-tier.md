# Spin Start Uses Its Booked Payout Tier

Audit F29: an already-booked multiplier could replace the fresh draw while leaving the earlier payout tier in memory. Tier selection now follows settlement, so the pool and payout split describe the same booked multiplier.

The regression executes the actual start fragment, with external I/O stubbed. Four of five conflicting-booking cases failed before the change and all five pass after it. The focused Spin suites passed 36 tests, server TypeScript passed, and the full server suite passed 6,488 tests across 457 files on the preceding branch containing this exact source change. The early reveal packet in a conflicting-booking race remains unverified.

The separate F30 SQL replacement of the existing Spin back-payment function is installed and tested but its repository delivery was blocked by the no-new-band-aids gate. It remains preserved on local branch agent/codex-audit-resume/fix/spin-booked-tier at 6c66c61cba. This branch carries only the original engine-path correction. No hook or allowlist was bypassed.
