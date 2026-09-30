# tests/the-horse-tag-ev-console-is-not-a-browser-route.law.test.ts

fn_horse_tag_ev_significance(date) is horse-brain analytics, not a browser
route. It reads horse_review_rollup and returns per-situation hand counts, big
blinds per hand, spread and z score, and until 2026-09-30 its ACL carried the
PUBLIC grant plus explicit anon and authenticated, so a logged-out visitor
could read it; a probe as anon returned 21 live rows. Migration 20260930181616
revoked PUBLIC, anon and authenticated together and left service_role alone.
The law pins that all three go together, because Supabase grants anon and
authenticated directly and revoking PUBLIC alone looks like a closure without
being one, and it fails any later migration that re-grants the function to a
browser role.

It also pins the criterion of fn_ca_browser_reachable_telemetry(). That check
tested "asks nothing about who is calling" against a routine's own text only,
so a routine refusing strangers through a helper such as fn_is_platform_admin()
or fn_is_horse_admin() read as an open console; the blind spot had already cost
ten hand-written allowlist rows and fn_ca_diamond_staff_books was the eleventh.
The criterion now follows one level into a helper that consults the caller, and
the four direct tests, the one-level hop and the allowlist lookup are all
pinned. fn_capability_available keeps EXECUTE for authenticated because the
SECURITY INVOKER trigger zz_tables_kill_pot_guard on public.tables calls it as
the role doing the write, so a revoke would fail Kill Pot table creation rather
than close anything.
