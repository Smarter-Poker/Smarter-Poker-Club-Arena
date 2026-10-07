# The Financial Admin certificate reads a player's alias as the player's words

Date: 2026-10-07
Spec: `tests/e2e/financial-admin-deep.spec.ts` (Post-Deploy E2E, `financial-admin.json`)
Follows: `2026-10-07-financial-admin-certificate-reaches-every-console.md` (#6321)

## Evidence

Post-Deploy E2E run 37562538452 (client `6b7b01c2ad`, contains #6321) was the
first in which test 2 got past Club Disputes. Club Disputes, Rate Audit Trail
and Agent Portal passed every check. Credit Admin failed `expectNoRawBackendCopy`:
the raw-enum pattern `/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/` matched agent
handles `the_kicker`, `roc_sofia`, `whale_77`.

## Which side was wrong

The spec. Those are players' poker aliases, printed through `playerDisplayName`
and `titleCase`, which deliberately leaves a snake_case token as written. Dan's
rule is that a player is shown by their alias; rewriting `the_kicker` into
`The Kicker` to satisfy a pattern would print a name the player never chose.
The pattern exists to catch backend enums and storage paths, and it keeps doing
that everywhere else on the page.

## What changed

- Each console that prints an alias marks it `data-player-name`: Credit Admin
  agent and audit rows, the credit request inbox requester, and the Club
  Disputes submitter.
- `#6363` landed the same correction for Credit Admin's agent rows while this
  was in review (`tests/e2e/helpers/financial-console-copy.ts`, keyed on the
  agent-identity class), and a stronger Settlement History observer pin. This
  change keeps both and extends the helper to the explicit marker, so the audit
  rows, the request inbox and the Disputes submitter are covered too. The UUID
  scan still reads every character, and every unmarked word is still held to
  the raw-enum rule.
- `tests/unit/financialConsolesMarkPlayerNames.test.ts` pins the markers and the
  narrow exclusion.
