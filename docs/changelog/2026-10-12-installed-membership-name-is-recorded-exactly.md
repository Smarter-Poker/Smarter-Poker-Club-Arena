# Record the actual installed membership migration name

**File:** `scripts/ci/recorded-migrations.manifest.json`, final recording entry.

The hosted naming guard refused the membership successor because its name has 69 characters. The migration was already installed; production retained its full name and exact source digest. Renaming or replaying installed source would misrepresent that ledger.

The existing recording path now binds the actual version `20261012192304`, full name and unchanged MD5 `7b6bf06fb0dac33a49d9592e00c1e73e` to its source. The naming guard explicitly accepts verified installed recordings. No guard, SQL byte, ledger row, function permission or installed name changed.

**Verified:** `fn_ca_migration_text` readback at 2026-10-12 19:41:44.638928 UTC confirms the full name and digest. Source digest and private function metadata match the existing native qualification and production readback. The maintained naming guard passes on the corrected recording; no unchanged native database proof was rerun.
