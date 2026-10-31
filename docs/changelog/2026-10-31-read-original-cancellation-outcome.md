# Read the original cancellation outcome without repeating it

A failed withdrawal discarded its remote exception and the existing pending reader never inspected cancellation records. The retained request alone cannot establish whether an intent, stop marker, quiescence record or receipt exists.

The existing recovery reader adds one fixed cancellation_records mode for the exact original. It reads only the four private durable files twice, rejects changed or unreadable evidence, binds canonical intent bytes and receipts, and exports closed status fields and hashes. It works after release-request cleanup. Historical receipts do not certify current quiescence or authorize a retry.

The existing helper adds observe_expired_announcement using the same extracted pre-intent predicates. It creates no cancellation directory, lock, mask or record and sends no signal. The pinned seal's normal getter takes a write-opened lock, so observation instead reuses its load_state validator against the fixed private file with unchanged before/after bytes and bytecode disabled. Cancellation retains its original lock-owning seal commands. The observation is point-in-time and cannot recover the failed attempt's discarded exception.

New failures preserve only closed stage/error codes and a maintained-source line number, never raw exceptions, commands, stderr or credentials. The existing artifact step now retains either receipt or diagnostic even after failure; the failed operation stays failed, and missing artifacts remain an error.

Focused verification covers durable absence, cleanup-surviving receipts, cross-record mismatch, symlinks, no-write observation, pinned seal validation without locks or bytecode, and diagnostic redaction. Hosted Linux qualification and any actual readback remain separate from this source delivery. No production operation is claimed.
