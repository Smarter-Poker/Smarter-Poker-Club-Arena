# tests/a-recording-is-verified-not-asserted.law.test.ts

A Recording Is Verified, Not Asserted: A Migration File That Only Records SQL Production Has Already Applied Is Exempt From The File Text Guards Only Through A Row In `scripts/ci/recorded-migrations.manifest.json` Whose md5 Equals Both The File On Disk And What `supabase_migrations.schema_migrations` Holds For That Version, So A Genuinely New Migration Cannot Wear The Marker.

The legacy `-- BACKFILLED` first line remains honoured only below the frozen cutoff `RECORDING_BINDS_FROM`; at or after it a comment is not evidence. "Could not tell" is a third outcome that never reads as recorded and always leaves the file judged strictly. The live half of the evidence is asked of production by `scripts/ci/check-recorded-migrations-evidence.mjs` inside the `Applied Migrations Are Recorded` workflow, which is the reader.
