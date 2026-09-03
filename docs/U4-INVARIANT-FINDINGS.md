# U4 — Supabase Invariant Findings (2026-04-23, revised)

Initial run of `scripts/ci/check-phantom-tables.mjs` and `scripts/ci/check-stranded-writers.mjs`. These are the first-pass findings to triage before flipping the scripts from `--warn` to blocking.

## Phantom tables (CA + WH migrations both included, authoritative)

`node scripts/ci/check-phantom-tables.mjs --warn --extra-migrations=../Smarter-Poker-World-Hub/supabase/migrations`

| Table            | Refs                            | Status           | Action                                                                                                                                                                                                         |
| ---------------- | ------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blacklists`     | 3 (BlacklistManagerPage)        | **REAL PHANTOM** | BlacklistManagerPage queries `.from('blacklists').select('*').eq('club_id', ...)` — table is not defined anywhere in CA or WH migrations. Silent failure: the admin page loads but always shows an empty list. |
| `diamond_ledger` | 3 (VIPPage, AnalyticsDashboard) | Cross-orb        | Lives in Diamond Arena orb. In `ALLOWLIST` of `check-stranded-writers.mjs`. The phantom script would need `--extra-migrations=../diamond-arena/supabase/migrations` when that orb is also mounted in CI.       |
| `user_avatars`   | 2 (AvatarService)               | Cross-orb        | Lives in Identity DNA Engine. In `ALLOWLIST`.                                                                                                                                                                  |
| `announcements`  | 1 (sanitizeInput.ts:12)         | False positive   | Reference is inside a JSDoc example block — the scanner doesn't strip comments (future enhancement). Harmless.                                                                                                 |

## Initially-suspected phantoms that turned out to be cross-orb (WH-defined)

The first pass over CA migrations only flagged these; running with `--extra-migrations=../Smarter-Poker-World-Hub/supabase/migrations` resolved them:

- **`chip_ledger`** — defined in `Smarter-Poker-World-Hub/supabase/migrations/20260319_create_chip_ledger.sql`. The 11 CA references are legitimate. **NOT a phantom.**
- **`club_arena_audit_logs`** — defined in `Smarter-Poker-World-Hub/supabase/migrations/20260311000001_orb8_phase4_audit.sql`. The 5 CA references are legitimate. **NOT a phantom.**

**Lesson:** The invariant gate only functions correctly with cross-repo schema awareness. The CI workflow (`ci.yml`) runs only CA migrations by default and WILL produce false positives for cross-orb references until either:

1. The `--extra-migrations=../Smarter-Poker-World-Hub/supabase/migrations` flag is wired into CI (requires mounting WH in the CI runner), OR
2. A unified schema snapshot is committed to CA that enumerates all tables defined across all orbs.

Either approach. For now, CA's CI passes `--warn` and the findings are filtered by this document.

## Real phantoms (action required)

One table doesn't exist anywhere, in any repo's migrations:

1. **`blacklists`** — 3 sites in `src/pages/BlacklistManagerPage.tsx`. Active admin page performing `.from('blacklists').select('*').eq('club_id', ...)` plus insert and delete. Since the table doesn't exist, the select returns `error.code = '42P01'` (undefined_table), which the page swallows and displays as "0 entries." The admin features appear to work but are no-ops.

### Triage options for `blacklists`

- **(A) Create the table** — if blacklist management is a current requirement, add a migration defining `blacklists` with columns `id`, `club_id`, `user_id`, `banned_at`, `reason`, `banned_by`.
- **(B) Rewire to an existing table** — if ban tracking was merged into an existing table (e.g., `club_members` with a `is_banned` flag), update BlacklistManagerPage to query there instead.
- **(C) Remove the page** — if the feature was scoped out, delete `BlacklistManagerPage.tsx` and its route entry in `App.tsx`.

## Stranded writers

Zero real stranded writers after the ALLOWLIST tune. Any future finding is legitimate.

## CI wiring

Both scripts now run in `ci.yml` (typecheck job) with `--warn` so they do not block merges while findings are triaged. Once the three real phantoms above are fixed, flip `--warn` to blocking:

```yaml
# Change from:
node scripts/ci/check-phantom-tables.mjs --warn
# To:
node scripts/ci/check-phantom-tables.mjs
```

## Next invariants to add (U4 future)

- **RLS coverage check** — for every `.from(<table>)` in the UI, verify the table has an RLS policy defined.
- **RPC existence check** — for every `.rpc('<fn>')` call, verify the function exists in a migration.
- **Service-role detection** — flag any client-side code using the service role key.
