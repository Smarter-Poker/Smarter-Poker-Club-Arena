# Create certification follows the actual retained runtime

A test-only publication intentionally keeps the existing client bundle and emits a retained-runtime receipt. Create certification previously required a new bundle artifact and failed before fixtures. It now validates the exact same-run receipt through the existing retention validator, runs verification from its separately bound source revision, and compares both public origins to the actual retained runtime.

The original missing-artifact failure remains visible. Missing, mixed, duplicate, foreign and expired artifacts are refused. Capacity, fixture authorization, cleanup, timeout and serialization remain unchanged. Connected source and provenance regressions cover both publication modes.
