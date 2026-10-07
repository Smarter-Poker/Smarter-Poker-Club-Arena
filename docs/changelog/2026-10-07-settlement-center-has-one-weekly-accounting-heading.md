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
