# Weekly close receipt freshness uses recording-time indexes

The original union week's 16:01 UTC rollback trial and the separate 16:06
management attempt both exhausted their existing 240-second statements in
`fn_prepare_accounting_week` while testing whether a calculation receipt had
newer earning sources. The tournament plan used its club/event index with both
time conditions as heap filters; neither source table indexed recording time.

Two concurrent covering indexes constrain the existing club and recording-time
conditions and carry the earning/charge timestamp. Every existing query,
source freshness condition, financial amount, receipt, permission and execution
budget remains unchanged. Late and backdated sources continue to invalidate a
calculation. The maintained migration installer builds each index separately,
checks validity, then records its catalog-asserting transaction. Unknown or
invalid partial builds require durable operation readback before recovery.

Native PostgreSQL qualification reads the actual installed preparation source,
uses its unchanged predicates, checks stale/fresh/boundary/NULL cases, measures
the old and new access paths, and refuses a same-name wrong index shape. The
existing required accounting step invokes this qualification directly.
Installation and the original week's completed settlement are separate evidence.
