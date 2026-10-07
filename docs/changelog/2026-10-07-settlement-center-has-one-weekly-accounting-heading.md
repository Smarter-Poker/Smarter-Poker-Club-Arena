# The Settlement Center has one "Club Weekly Accounting" heading

Date: 2026-10-07
Spec: `tests/e2e/financial-admin-deep.spec.ts`, Settlement Center step

## Evidence

Post-Deploy E2E run 37569802965 (live client containing #6321 and #6363) passed
Club Disputes, Rate Audit Trail, Agent Portal, Credit Admin and Settlement
History, then failed at Settlement Center on a strict-mode violation:
`getByRole('heading', { name: 'Club Weekly Accounting' })` resolved to two
elements, the workspace's `h2` and `ClubWeeklyAccountingSummary`'s `h3`.

## Which side was wrong

The page. Two headings with the same name on one console give a screen reader
two identical landmarks and no way to tell the week picker from the list of
issued summaries. The union variant of the same workspace already names its
section for what it lists ("Recorded Union Periods").

## What changed

`ClubWeeklyAccountingSummary` heading and region label are now
"Club Weekly Summaries", matching its own copy ("Issued Weekly Summaries",
"Refresh Weekly Summaries", "Export Weekly Summaries"). The workspace keeps the
single "Club Weekly Accounting" heading. Pinned in
`tests/components/ClubWeeklyAccountingSummary.test.tsx` (fails on the old name).

## Two more, found before they could fail

Rendering the remaining consoles at 393px against production-shaped payloads
(the same local harness as #6321) and counting what each outcome locator
resolves to showed two more strict-mode collisions behind this one:

- **Settlement Center, `getByLabel('Club Transaction Records')` resolved to 2.**
  The console carries that name (pinned by
  `tests/admin-subpages-console-contract.test.ts`) and the ledger inside it was
  handed the same name as its `title`. The page was wrong: the list now keeps
  its own default name, and the contract test pins that only the console
  carries `ledgerTitle`.
- **CSV Exports, `getByRole('tablist', { name: 'Reporting Window' })` resolved
  to 2:** the page's "Reporting Window" and RakeReports' "Rake Reporting
  Window". Both names are right; the spec matched by substring. The spec now
  matches exactly.

After these, every outcome locator in test 2 resolves to exactly one element in
the harness.
