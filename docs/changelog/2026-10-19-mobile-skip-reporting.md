# Named mobile check skips

Successful production runs discarded the lobby JSON report, leaving only a skip count. The client verification job now writes every Cashier, club-lobby, first-run iPhone and mobile-sweep skip to its log, job summary and a small retained JSON artifact on successful, failed and cancelled runs. Each entry includes the full test title, project, source location and exact skip/fixme descriptions, without a ten-annotation limit or text truncation.

An omitted reason or unreadable report is explicitly incomplete and fails the reporting step; it is never inferred or treated as zero skips. Test selection, skip conditions, assertions, retries, timeouts, financial actions and engine verification remain unchanged. Reporting is checked with focused parser/workflow regressions and a local Playwright skip fixture that does not launch a browser or contact production.
