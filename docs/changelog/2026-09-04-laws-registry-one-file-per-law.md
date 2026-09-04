# 2026-09-04: the law registry is one file per law

`docs/LAWS.md` held one table, and every law appended a row to its last
line. So any two pull requests that each added a law conflicted with each
other on that file and on nothing else. Measured this afternoon: PR #2992
went merge-dirty **four times**, every time on that table, every time
resolved by keeping both sides - a resolution so mechanical it should not
need a person.

This is the disease `MIGRATION-CHANGELOG.md` had (18 of 108 conflicting PRs,
CLAUDE.md 10.9) and it gets the same cure: two files written independently
cannot conflict.

## What changed

- `docs/laws.d/<slug>.md`, one per law: `# <law test path>` on line one,
  then one line on what it guards. 133 files, migrated from the 189 table
  rows (the table had duplicates).
- `tests/law-registry.law.test.ts` reads the directory. Both directions are
  still enforced: a law test with no file fails CI naming the exact file to
  create; a file whose test is gone is a ghost and fails CI. A new pin
  refuses the table coming back into `docs/LAWS.md`.
- `docs/LAWS.md` keeps the rules and the resolved-conflict rulings
  (the hamburger ruling included), and points at the directory.
- `node scripts/laws-registry.mjs` prints the whole registry as one table
  for anyone who wants to read it that way.
- CLAUDE.md 10.8.1 updated.

`AGENT-PLAYBOOK.md` is byte-identical across seven repos and is not touched.
