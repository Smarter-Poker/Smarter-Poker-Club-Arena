# The Settlement Center check reads the summary the page renders

Date: 2026-10-07
Spec: `tests/e2e/financial-admin-deep.spec.ts`, Settlement Center step

Two corrections to the same failure (Post-Deploy E2E run 37569802965, two
headings named "Club Weekly Accounting") landed independently:

- #6372 fixed the page: the issued summaries became "Club Weekly Summaries"
  (region and h3), leaving the workspace the one "Club Weekly Accounting".
- #6374 fixed the spec the other way: it selected the summary by the old name,
  `region "Club Weekly Accounting" > h3 "Club Weekly Accounting"`, so that the
  check proves the summaries actually rendered, not just the workspace title.

Together they cannot pass: the page no longer has that region. Run 37579424861
failed on exactly that locator, after Club Disputes, Rate Audit Trail, Agent
Portal, Credit Admin and Settlement History all passed.

Both intents are kept. The step now asserts the workspace `h2` "Club Weekly
Accounting" and the summaries region "Club Weekly Summaries" with its own `h3`.
`tests/unit/weeklyAccountingSummaryHeading.test.ts` (from #6374) is moved to the
current names and additionally refuses the old duplicate shape. In the 393px
harness each locator resolves to exactly one element.
