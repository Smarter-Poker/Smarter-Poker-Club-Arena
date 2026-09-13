# Paid-depth creation receipt fixture

`baseline.json` captures the installed outer `fn_create_tournament(uuid,jsonb)`.
Its `source_md5` hashes `prosrc`; `body_md5` hashes the complete
`pg_get_functiondef` output. These are intentionally different fingerprints.
The current delegated creator returns `tournament_id`; its captured source
MD5 at investigation was `d00caa094f988ca352b6f7038f660c19`.

The native probe installs the exact wrapper around explicit authorization and
delegated-creation stand-ins. Those stand-ins insert synthetic event/effect
rows and can return malformed receipts or inject failed writes. They are not
financial functions and do not deal hands. The probe first reproduces the old
15/20-to-10 mismatch and swallowed failure, then applies the tracked migration
twice and checks the exact candidate, role metadata, all outcomes and rollback.
`candidate.sql` is expected-result evidence, not the production apply path.

The source-guarded migration is the only production apply artifact. No fixture
accepts a production URL. All private cluster files are cleaned up on exit;
small logs and the result receipt remain in the printed evidence directory.
