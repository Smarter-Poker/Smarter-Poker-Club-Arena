# Existing Release Recovery Cause Is Readable

The completed release observer can attest a sealed result without printing its journal. Release 38268897283-1 installed f5cc99a2 and completed its durable v3 thaw, but its public health, database deployment receipt and sanitized job output do not retain the named cause of its existing recovery window. A cause must not be guessed from an hourly maintenance window or a job deadline.

Production Integrity Audit now has one optional explicit read, selected only by an `audit-production-integrity` request containing `release_recovery_observation` with the exact `runKey` and full `releaseSha`. Its fixed pinned SSH reader reads two existing files: that run's recovery reservation and sealed result. No arbitrary command, host or file can be selected; the audit cannot create a window, advance a release or restart an engine.

The reader requires matching run and SHA, an allowed cause, the existing run's sealed completion inside its reserved recovery window, bounded regular files without links and unchanged evidence across the read. The reservation timestamp uses milliseconds; the sealed completion uses seconds. Missing evidence refuses the read and remains unknown.

The artifact retains only the run/SHA, cause class, announcement/freeze/end/seal timestamps and observation time. The underlying health or certificate deadline witness is not in those selected receipts, so `emergencyBasisStatus` explicitly remains unknown. This observation does not claim policy admission passed and does not substitute for production identity, financial or live-table certification.

Validation: fourteen native isolated filesystem/selection/export/transport fixtures, including maintained producer field and timestamp-unit contracts, executed by the existing root test suite and again before the optional audit read; YAML structure and affected workflow checks. Source publication and an actual selected read remain pending at preparation time. Existing release and ordinary audit jobs are preserved.
