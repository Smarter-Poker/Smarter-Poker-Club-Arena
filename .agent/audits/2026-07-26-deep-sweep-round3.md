# Deep Sweep (Round 3) — 2026-07-26

Second-pass sweep beyond phantom table/RPC references. Verified findings against
the live production DB. FIXED + DEPLOYED (prod serving db2c5cd2):

1. PROMOTIONS INVISIBLE PLATFORM-WIDE (high impact). PromotionService selected
   title/image_url/is_active/terms/claim_count — the real `promotions` table has
   name/banner_url/status and no terms/claim_count. Every SELECT errored (42703),
   swallowed to []. Aliased real columns (title:name, image_url:banner_url),
   derived isActive from status, fixed insert/update/mapPromotion.

2/3. SETTLEMENT WORKFLOW BROKEN. settlement_periods is service-role-write-only and
had NO write RPC (fn_create/fn_close_settlement_period act on rakeback_periods;
fn_finalize on settlement_journal). Admin "open" insert = RLS error; admin
"close" used invalid status 'closed' + silent 0-row; union closePeriod silent
0-row. Created fn_open_settlement_period + fn_set_settlement_period_status
(authorized, valid enum) and routed AdminDashboardPage + SettlementService.

4. WITHDRAWAL LOCK DEAD CODE. DepositWithdrawModal wrote wallets.locked_until (no
   such column, service-role-only) in try/catch → silent no-op every withdrawal.
   Removed the financial-safety-theater; noted a real lock needs a server RPC.

5. RAKE FALLBACK SILENT LOSS. RakeService fell back to a direct agents.update on
   RPC failure — silent 0-row under RLS, dropping agent lifetime rake while
   looking successful. Replaced with visible RPC-failure reporting.

## REMAINING (need server-side RPC changes — follow-up, NOT yet done)

- #5 AgentService.assign/referral: agents.update({total_players,active_player_count})
  is a silent RLS no-op — counts never increment. Fix: increment inside the
  assignment RPC (server side).
- #6 CreditService.reviewCreditRequest: agents.update({credit_limit}) silent no-op;
  use fn_admin_update_agent (as setCreditLine already does). NOTE: appears unwired
  (no UI caller found) — low priority.
- #8 ClubMembersPage promote fallback branch: agents.update silent no-op (role
  unchanged, success reported) + agents.insert RLS-throws. Only runs if
  promote_member RPC returns falsy. Remove the direct-write fallback.
- #9 HorseOrchestrator: union_clubs.insert RLS-throws (denormalized clubs.union_id
  succeeds → half-recorded union link). Create the join row via RPC.
- #10 lib/export.ts exportToPDF returns HTML mislabeled as PDF (no callers).
- #11 TablePage VIP menu item is a 'coming soon' stub.

## Method note

Verify every candidate against the LIVE DB (repo migrations are stale — RPCs are
applied straight to prod). Confirm: (a) column exists on the table, (b) the
table's RLS write policy (service_role-only vs public) before calling a client
write a bug. clubs + club_members ARE client-writable; wallets/agents/
settlement_periods/union_clubs/commission_records are NOT.
