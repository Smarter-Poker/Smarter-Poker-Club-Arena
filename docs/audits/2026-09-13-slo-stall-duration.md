# A stalled-table alert reports the actual duration

Operational inbox event5557 displayed about14 days without table progress.
The recording rule is measured in milliseconds, but `humanizeDuration` expects
seconds. The display exaggerated the measured duration by a factor of1000.
The stall condition itself was real; this does not establish its gameplay cause.

The alert still selects the same samples above900000ms, waits the same five
minutes and obeys the existing maintenance guard. Only the selected value is
converted to seconds before annotation formatting. A960000ms sample now reads
16m0s instead of11d2h40m.

Native Prometheus2.55.1 evaluates five assertions covering the exact threshold,
pending period, readable duration, maintenance suppression and recovery. The
baseline fails the duration assertion; the candidate passes. The offline check
used temporary files and the existing Prometheus binary without changing any
loaded rules or sending alerts. Required CI runs the same fixture using the
published image digest with no network, a read-only workspace and bounded
memory. Normal monitoring publication and loaded-rule verification remain
required before closing this reporting defect.
