# Definer-function lockdown - Phase 1 record and remaining work

Supabase security advisors (run 2026-09-01): 579 SECURITY DEFINER functions
executable by `authenticated`, 27 by `anon`, 17 with mutable search_path,
185 tables with RLS enabled but no policy (deny-by-default; informational).
This is the class that produced the 2026-08-27 unguarded-definer incident.

## Phase 1 - applied (migration `definer_lockdown_phase1_server_machinery`)

Browser execute REVOKED (service_role/postgres keep theirs; engine, API
routes, pg_cron, MCP unaffected) on the unambiguous server-side machinery:

fn_ca_mint, fn_ca_post_correction, fn_union_settlement_cascade_all,
fn_union_integrity_sweep_all, fn_rakeback_recompute_all_clubs,
fn_club_rake_rollup_catchup, fn_replace_licensed_poy_rankings,
fn_anonymize_hg_user_content, verify_home_games_health_core,
fn_emergency_block_deep_stack_horse_membership, fn_enqueue_hand_daily_missions,
fn_require_explicit_club_membership_source

Verified live: `SET ROLE authenticated; SELECT fn_ca_mint(...)` returns
insufficient_privilege; migration self-asserts service_role kept execute.

Not touched: PostGIS st_estimatedextent overloads (extension-owned, cannot
ALTER; read-only estimators - accepted residual on every PostGIS project).

## Remaining work - the verified-keep methodology

271 more definer functions are browser-executable but were NOT provably
browser-called by static analysis (absent from every `.rpc('...')` in CA
src/ and WH src/+pages/, all RLS policies, views, and computed columns).
MANY are genuinely browser surfaces reached through wrappers or Home
Games/venue pages - a blanket revoke would break player features, so each
needs one of: (a) a found call site -> keep, (b) an internal auth.uid()
check -> keep, note as self-guarding, (c) neither -> revoke.

Regenerate the candidate list any time with the query in this commit's
message, or rerun the advisors: the count going DOWN is the progress metric.
Track in the follow-up issue referenced by this file's PR.
