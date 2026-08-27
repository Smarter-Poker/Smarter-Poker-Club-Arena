# 2026-08-27 — findings round 3: the database, and the server HTTP surface

Two surfaces nobody had audited this session: the **production Postgres**
(via the Supabase advisors + direct `pg_catalog` queries) and the **server
HTTP handlers + club authorization**. The headline of both is _good news_ —
which in this repo needs saying explicitly, so nobody re-audits them or invents
a fix where none is warranted.

---

## Database security: clean. Do NOT "fix" the scary-looking numbers.

The raw advisor counts look alarming and are traps:

| raw finding                                       | count | verdict                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| public tables with RLS **off**                    | 1     | `spatial_ref_sys` — a **PostGIS** reference table. Extension-owned. Not ours, not fixable without breaking the extension.                                                                                                                                                                                             |
| SECURITY DEFINER funcs with mutable `search_path` | 5     | all **PostGIS / dblink** (`st_estimatedextent`, `dblink_connect_u`). Extension-owned. Altering them is reverted on the next extension upgrade.                                                                                                                                                                        |
| RLS **on** but **zero policies**                  | 88    | This is **deny-all**, the _secure_ default. All 88 are service-role-only backend tables — idempotency keys, daemon state, audit logs, dated backups, rake checkpoints. `service_role` bypasses RLS, so they work; `anon`/`authenticated` correctly cannot touch them. **Adding policies here would WEAKEN security.** |

**There is no security migration to write.** The one thing worth a follow-up
check (not a fix): confirm none of those 88 deny-all tables is read _directly_
by the client with the anon/authenticated key — if one were, it would be a
_broken feature_ (deny-all → empty result), not a hole. Nothing in the round-1/2
client audits pointed at one.

The application's own `SECURITY DEFINER` functions — all 931 of them, minus the
5 extension ones — **do** pin `search_path`. That is the thing this class of
audit exists to catch, and this codebase already got it right.

## Database performance: one real index, applied.

Of 12 foreign keys with no covering index, **ten are on empty (0-row) tables** —
indexing those is pure write overhead and was skipped. Two carry real rows:

- **`bbj_contributions.player_id`** — 703K rows, 241 MB, 59 seq-scans, written
  on every live bad-beat hand. **Index created CONCURRENTLY and verified VALID**
  (`idx_bbj_contributions_player_id`, 4776 kB, no write lock taken). This is the
  single clearest safe DB win in the whole audit.
- **`tournament_rake_settlements.club_id`** — 31K rows, a money table that only
  grows. Index **prepared** (`idx_tournament_rake_settlements_club_id`) —
  statement is in `supabase/migrations/20260827_index_two_hot_unindexed_fks.sql`,
  ready to apply CONCURRENTLY.

The migration file records both, and explains why they were applied outside the
normal `apply_migration` transaction (CONCURRENTLY cannot run inside one).

---

## Server HTTP surface: no IDOR. Two concrete fixes.

Full read of `router.ts`, `http/auth.ts|rateLimit.ts|body.ts|respond.ts`, and
every `handlers/*`. **Every state-mutating handler derives identity from
`authenticateRequest()` → `auth.userId`; none trusts a body/query `userId` for
the acting player.** RULE 5 upheld. Verified positives: the unsigned-JWT
fallback is genuinely gone (`http/auth.ts:38-45`); `handleGetActions` ignores
the `:userId` URL param and uses the token (`state.ts:41`, no hole-card leak);
admin pause/resume/kick all go through `authorizeTableAdmin()` and `/admin/kick`
is role-gated (`admin.ts:159-176`); channel-broadcast routes fail closed when
`INTERNAL_API_KEY` is unset.

### BROKEN

- **`/reject_rebuy` is a dead route.** `handleRejectRebuy` is imported
  (`router.ts:36`) but has **no dispatch** — a client's explicit rebuy-rejection
  404s silently, so the 5s pause never fast-forwards. Wire it or delete the
  handler+import. (The client side of this: `TablePage.tsx` calls
  `GameServerAPI.notifyServerRejectRebuy(...).catch(console.error)` — it swallows
  the 404, which is why nobody noticed.)

### RISKY

- **The two chip endpoints have no numeric guard.** `addchips.ts:45` and
  `withdrawchips.ts:44` check only `!amount || amount <= 0`, which a
  non-numeric string passes (`!"abc"` and `"abc" <= 0` are both false), reaching
  `engine.addChips(userId, amount)` with a non-number. Add
  `typeof amount === 'number' && Number.isFinite(amount)` — `showhand.ts`
  already validates this way.
- **`/assistant/leaks/detect` has no rate limit** and runs a 100-row
  `hand_history` scan + GTO analysis per call — an authenticated-DoS lever.
  `checkRateLimit` is applied only on `/action`.
- **`assistant.ts:23`** builds a PostgREST filter by string interpolation
  (`.contains('players', ...userId...)`). Not exploitable today (the id is a
  GoTrue-verified UUID) but the wrong pattern to leave on a filter string.

### MESSY

- `insurance.ts:104` — `Number(params.get('coveragePercent')||100)` forwards
  `NaN` on garbage (read-only path, low impact).
- Error hygiene is otherwise good: no raw-Postgres/stack leakage, generic 500s.

---

## Recommended order

1. `addchips`/`withdrawchips` numeric guard — smallest money-safety fix here,
   sits under the round-2 idempotency work.
2. Decide `/reject_rebuy`: wire the route (the handler exists and works) or
   delete it and the dead client call together.
3. Apply the prepared `tournament_rake_settlements.club_id` index.
4. Rate-limit `/assistant/leaks/detect`.

Nothing above is a security emergency. The most valuable output of this round is
the _negative_ result: the DB security posture and the server authz surface are
both sound, and the numbers that look like findings are extension noise and
secure-by-default deny-all. Verify before "fixing" either.
