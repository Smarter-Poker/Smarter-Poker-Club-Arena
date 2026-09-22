# tests/the-publisher-says-what-it-refused.law.test.ts

No guard in `publish-club-arena.yml` may stop the release without printing
what it checked, what it required and what it found. Fifty-eight bare
`test`/`[`/`[[` statements could, and on 2026-09-22 two of them did: runs
35763554815 and 35764705782 failed inside the host-owned transaction with an
empty log because a build whose `self-host-fonts` step could not reach Google
Fonts exited 0 and shipped a dist with no `fonts/`. The scanner reports any
logical line in a `run:` block whose last command is a bare conditional; the
law also pins the release-layout guards, the build job's own refusal of a
bundle the origin could never accept, and the fact that the font step no
longer reports success when it wrote no stylesheet. It adds voice, never
permission. Read by `Client Unit Tests (vitest)`.
