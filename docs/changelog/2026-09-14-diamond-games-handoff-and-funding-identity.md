# Diamond Games Handoff And Funding Identity

Recovered `feat/diamond-games` at `1e922ad012` from the September 11 handoff.
The worktree and its remote agreed. PR #4001 remained open; the September 14
production commit `9f2a9dbf2cab31943f7bb55fb8e646dcfd4f438d` did not contain
the game pages. The database and a local preview must not be described as a
published frontend release.

Merged current main into this feature branch, retaining its shared Diamond
Arena lobby and access provider, the game's entry controls, the painted
console shell, and main's mobile width and bottom-navigation clearance fix.
The header route audit counts the six Diamond Games routes and the new
sponsor route together. No release controls were weakened.

## Funding Defects And Fixes

A rolled-back production probe funded one chip, then reused the key to ask
for two chips and to ask at the other host. Both requests returned
`ok: true, replayed: true`, although the journal held only the original
one-chip transfer. A replay acknowledged requests that had never happened.

Migration `20260914100738` matches the immutable journal's actor, source
wallet, destination host, account types, category and amount before returning
a successful replay. The original key namespace remains intact so existing
requests remain idempotent across the upgrade. Union ledger source IDs refer
to the wallet row; club source IDs refer to the club. The host wallet lock and
unique ledger key remain in place. No economic settings or balances were
changed by the migration.

The client also coerced missing or malformed funding replies into an answer,
which cleared the console's held key. A subsequent press could become a new
transfer. The service now accepts only an explicit refusal with an error or a
complete success with a Boolean replay flag and finite nonnegative balances.
Anything else throws into the existing unknown-outcome path, preserving the
key and rereading the console. Neither console automatically retries funding.

The funding law now resolves the latest function declaration rather than
pinning an obsolete migration filename. The original keyless-function DROP
remains checked as historical DDL.

## Evidence

- The new response tests failed before the fix; all 22 pass afterwards.
- The SQL regression failed on production before the fix. The candidate
  function passed in `pg_temp`, with all transfers rolled back and no public
  DDL used as a probe.
- The migration was applied and registered in one bounded transaction after
  comparing the live function to the initial snapshot.
- Both host shapes pass the installed regression: one journal leg, exact
  replay accepted, changed amount, host and operator refused. The original
  bug probe now returns refusals for the mismatched requests.
- Live welcome spins still pass for both hosts and roll back. The funded
  windows remain 300 and 500 chips per seven days.
- The merged client suite passed 20,500 tests with one skip; five files failed
  because the initial shared dependency set lacked packages. All five pass
  with an existing dependency set matching the branch lockfile. That rerun
  plus changed-area tests passed 98 tests across nine files. No dependencies
  were installed.
- The final funding, law registry, class names, error handling and hover-law
  checks passed 463 tests across six files. TypeScript and all four UI-copy
  gates pass.
- Authenticated local renders at 393px cover the hub, all three games, and
  both operator consoles. No horizontal overflow or browser errors. Browser
  money writes were blocked; payment execution was verified only in SQL
  transactions that rolled back.

The frontend release remains subject to the existing PR checks, automatic
merge and owning Club Arena publisher. A local render is not production proof.
