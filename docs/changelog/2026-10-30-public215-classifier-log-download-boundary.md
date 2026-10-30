# Bounded Public215 classifier log download

Explicit Linux preflight41025616041 refused before SSH when gh failed to read the classifier job123838608904 log. The same exact log remained available from the Mac (170948 bytes, SHA256 cb53947701a53b7f1e85471b5970e35dace3a2bf1150ee822e030f3a173cb899). This establishes a hosted log-transport failure; the CLI's underlying error remains unknown. Existing Actions read permission is sufficient and is unchanged.

The dedicated source reader now implements GitHub's documented job-log protocol directly: one authenticated GET to the exact canonical job endpoint, require302, then one credential-free GET to its HTTPS signed storage URL and require200. Both legs use manual redirects; credentials, extra redirects, nonstandard ports and undocumented destinations are refused. Permitted storage hosts are the documented Azure blob accounts and results-receiver.actions.githubusercontent.com. No Location, raw error, token, response body or signed URL is logged. Failures retain only fixed API/download stage, HTTP status digits and allowlisted transport codes.

The two legs share one20-second log deadline inside the existing120-second/80-request source budget. Streaming bytes are bounded to16MiB and decoded as strict UTF8 with BOM preserved. There is no retry, local-log substitution, new workflow, permission expansion, source-check fallback or change to classifier witnesses. Real source qualification and the full107 Linux receipts remain required.

Focused contracts exercise the two-legged protocol, credential isolation, redirect/destination refusal, byte and UTF8 boundaries, actual stream deadline abort, fixed failure redaction and unchanged fail-closed source gates. Hosted success is still required before any Linux parity claim.

Sources: [GitHub job logs API](https://docs.github.com/en/rest/actions/workflow-jobs#download-job-logs-for-a-workflow-run), [GitHub-hosted runner communication domains](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#communication-requirements-for-github-hosted-runners).
