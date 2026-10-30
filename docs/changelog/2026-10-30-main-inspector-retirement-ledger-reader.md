# Exact-operation MAIN Inspector retirement evidence

The existing explicit release-recovery reader now accepts
`main_inspector_retirement_ledger` with an exact `runKey` and `releaseSha`.
It reads that failed, retired operation's existing retirement claim and receipt
without replaying the retirement. A strict failed-result receipt and unchanged
sealed EED container/health identity bind the read before and after.

The projection distinguishes absent, claim-only, positive original receipt and
unknown outcomes. Only a validated positive original receipt exports historical
close/acknowledgement facts. It exports no endpoint, process identifier, path,
claim payload or raw exception, and confers no cleanup, retry or release authority.
Unreadable, changed, malformed, foreign or oversized records refuse the read;
they never become absence. Existing root-owned regular-file and no-follow
checks bound claim reads to 32 KiB and receipt reads to 64 KiB.

No Inspector, TCP, kernel or native retirement probe is invoked by this mode.
The existing explicit workflow and native qualification hook remain unchanged.
The existing Python selector fixture exercises filesystem, operation binding,
projection privacy and no-probe regressions without changing the enforced
100-test suite cardinality. Actual production ledger observation remains with
the sole owning provider after protected publication.
