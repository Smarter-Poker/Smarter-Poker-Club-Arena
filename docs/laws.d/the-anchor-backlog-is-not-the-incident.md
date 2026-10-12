# tests/the-anchor-backlog-is-not-the-incident.law.test.ts

`ca_ledger_day_manifests` hashes each day of `chip_ledger` and stores the sha
in the same database as the journal it hashes, so it proves nothing to anyone
who does not already trust that database; `docs/attestation/chip-ledger-days.tsv`
is where git owns the history, and that is the whole point.
`anchor-ledger-days.mjs` already tells the two cases apart precisely - a day
the file carries that now hashes differently with no restatement explaining it
exits 1 with an incident write-up, while days the file has not caught up with
are appended and exit 0. The workflow did not: it ran the script and then
`git diff --exit-code -- docs/attestation/`, which fails identically for both,
and the job is `contents: read` on purpose so it can never commit what the
script just generated. The first day nobody committed the file, the job went
red and stayed red. Measured 2026-09-19: it had been red since 2026-09-14,
every one of the 39 anchored days still hashed exactly the same, and the cause
was eight days attested since 2026-09-10 that nothing had anchored - while the
`refresh` job in the same workflow is skipped when this one fails, so the
schema manifest had stopped regenerating too, and the whole workflow had been
disabled. The file itself already names the failure elsewhere: a chronic alarm
that never clears is the same blind spot as no alarm. Now the backlog warns,
and past a fourteen-day bound fails on its own terms with its own wording,
while an unexplained change is still the only thing that raises the incident
issue. The law pins that the incident verdict is the default written before
the script runs - under `set -e` nothing after it runs when it exits 1 - that
`git diff --exit-code` does not come back, and that the anchor file stays well
formed with no day anchored twice as an original.

Extended 2026-10-03. Separating the two verdicts left the same trap one level
up: the backlog's only output was a `::warning` in a scheduled run, which has
no reader, so the first thing a person could see was the job going red on the
fourteenth day - arriving through `check-main-is-green` as "Schema Integrity
Audit has been red", shaped exactly like the incident and masked by any open
issue naming this workflow. It then happened: the anchor stopped at 2026-09-18
and nobody heard until run 37110065144 on 2026-10-03, with fourteen days of
`chip_ledger` unanchored and all 48 anchored days still hashing the same. The
backlog now has its own reader - its own issue, its own title, filed at three
days behind (derived from the measured one-line-a-day anchoring cadence of
2026-09-08 through 09-11, so 0 or 1 behind never files and eleven days of
warning remain before the hard bound) and closed when git catches up. The law
pins the threshold, that the alarm output is set before the hard bound fails
the step, and that the two issues can never close one another.
