# tests/the-publisher-says-what-it-refused.law.test.ts

No guard in `publish-club-arena.yml` or the origin activation transaction it
pipes may stop the release without printing what it checked, what it required
and what it found, and no `run:` step may grow past the size that makes GitHub
refuse the whole workflow. Fifty-eight bare `test`/`[`/`[[` statements could
refuse in silence, and on 2026-09-22 two of them did: runs 35763554815 and
35764705782 failed inside the host transaction with an empty log because a
build whose `self-host-fonts` step could not reach Google Fonts exited 0 and
shipped a dist with no `fonts/`. Giving them a voice then pushed one step from
17,304 to 24,626 characters and the workflow stopped parsing altogether, so
the transaction moved to a tracked script and every step now has a budget with
headroom. The law also pins the release-layout guards, the build job's refusal
of a bundle the origin could never accept, and the font step's refusal to
report success when it wrote no stylesheet. It adds voice, never permission.
Read by `Client Unit Tests (vitest)`.
