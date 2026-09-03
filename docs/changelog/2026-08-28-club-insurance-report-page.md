# 2026-08-28 — Club Insurance Report page

The dashboard's revenue card has shown the insurance net since 2026-08-27;
this adds the page that number needs behind it: the decision FUNNEL beside
the MONEY, per day, for club staff.

- **RPC `ca_club_insurance_report(p_club_id, p_days)`** (APPLIED to
  production; mirrored in `supabase/migrations/20260828200000_...sql`).
  SECURITY DEFINER, gated on `ca_can_view_club_finances`, ERRCODE 42501 —
  same shape as `ca_club_dashboard_stats`. Returns totals (offers /
  accepted / declined / timeouts / cashouts, avg offer equity + pot), money
  (contracts by kind, bank in / out / net, union-vs-club bank label) and a
  per-day merge of both, capped at 90 days.
  **Grant lesson caught during verification:** the authz helper deliberately
  passes when `auth.uid()` IS NULL (service-role convention), so the default
  PUBLIC/anon EXECUTE grant on a new function is a live anon-key leak.
  Probed anonymously right after creation, refused-then-fixed: EXECUTE is
  authenticated + service_role only, matching every sibling.
- **Page `/clubs/:clubId/insurance-report`**
  (`ClubInsuranceReportPage.tsx`): 7/30/90-day windows, funnel cards with
  take rate, money cards, per-day table, CSV export (`downloadCsv`).
  Mobile-first (375px), no emoji, 42501 renders the staff-only card. Route
  behind AuthGuard + ClubMemberGuard (server gate is the real one).
- **Dashboard link**: "View Full Insurance Report" under the revenue
  metrics whenever the insurance block renders.

Verified: RPC probed live as a real club owner (rolled-back JWT-claim
simulation) returning today's actual funnel — 12 offered / 1 accepted / 11
declined — and money — 377.86 in / 626.00 out / −248.14 net; anonymous call
refused (42501 path); client `tsc` clean in all touched files.
