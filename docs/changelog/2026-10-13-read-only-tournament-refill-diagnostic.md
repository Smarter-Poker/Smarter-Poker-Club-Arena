# Read Only Tournament Refill Diagnostic

The remaining live-table certificate could not find completed Spin/SNG coverage.
A manual bounded diagnostic reads the serving engine's existing recurring-service
console outcomes through its maintained configured, pinned SSH identity. It does
not replace or restart the engine, change configuration, open fixtures, write to
the database, or read environment files.

Only a default-branch workflow dispatch with an exact full serving SHA is admitted.
Local health and the container release label must match before and after the read;
the health instance must remain unchanged. The existing container's last45minutes
and latest10,000 lines are bounded to4MiB and25seconds, with a100second SSH limit.
Raw bytes stay inside the host process. Output reconstructs only allowlisted
recurring event names, counts, Docker timestamps, known SQLSTATE codes and known
operational categories. Unknown/private text is discarded before host stdout.
No raw log artifact or journal fallback is added. The dynamic atomic creator
contexts are bound to the real `sng` and `spin` callers, including creation
refusal and identity-mismatch events.

The retained tests verify positive extraction, dropping unknown/private/overlong
lines, manual/default-branch authority, pinned transport, strict read bounds and
unchanged health identity. Actual Python identity/main fixtures exercise stable
admission, mismatched health, mismatched container labels, an instance change
and malformed private health content, without network or host access. Refusals
emit only the fixed refusal receipt and no raw stdout. This is diagnostic
access, not a refill fix or proof
that live-table certification now succeeds.

The 45-minute selector and 10,000-line cap describe a bounded tail, not proven
coverage of all 45 minutes. Receipts include total and timestamped record counts,
oldest/newest validated Docker timestamps (null when unavailable), and whether
the tail limit was reached. Full45-minute coverage and healthy refill are
explicitly unproven: an empty event summary never establishes absence of errors
or a healthy service. These fields do not increase the read or add polling.
