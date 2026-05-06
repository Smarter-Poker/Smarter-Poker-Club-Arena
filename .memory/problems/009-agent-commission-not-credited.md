# Problem 009 — Agent Commission Never Credited

**Type:** PROBLEM
**Project:** Smarter Poker Club Arena
**Date Found:** 2026-04-15 (live verification harness, immediately after BUG 008)
**Date Fixed:** 2026-04-15 (same session — fix-first protocol)
**Severity:** HIGH (financial — agents never earned a cent in production)

## Discovery

After fixing BUG 008 (rakeback settler missing), continued live verification of D-2 #2 (Agent commission credit). Result:

| Check                                   | Live value |
| --------------------------------------- | ---------- |
| Total agents in DB                      | 68         |
| Agents with `pending_commission > 0`    | 0          |
| Agents with `weekly_rake_generated > 0` | 0          |
| Agents with `lifetime_earnings > 0`     | 0          |
| `agent_commissions` rows last 7 days    | 0          |
| Total rake recorded last 7 days         | $30,136.94 |

Despite $30K in rake passing through 68 active agents' clubs in 7 days, **not one agent was ever credited a single chip**.

## Root cause (compound triple-bug)

1. **Server engine has zero references** to `queueCommissionCredits`, `agent_commissions`, `pending_commission`. The full agent commission logic exists in `src/services/RakeService.ts` (CLIENT) but was never ported to `server/src/`. After Bible V8 server-authoritative migration, the agent commission flow was orphaned.

2. **Existing `increment_agent_rake` RPC was broken** — definition was:

   ```sql
   UPDATE profiles SET rake_generated = COALESCE(rake_generated, 0) + p_amount WHERE id = p_agent_id;
   ```

   But `profiles.rake_generated` column **does not exist**. So even if some code path called the RPC, it would silently UPDATE 0 rows and return `void` with no error. A perfect silent failure.

3. **`RakebackEngine.recordHandRake` only tracks player rakeback** — it has no agent commission code path at all. Agent commission was supposed to be a parallel flow but only existed in the orphaned client service.

Combined effect: agents could be created, assigned players, set commission rates — but ZERO chips ever flowed to them. The pending_commission field was decorative.

## Fix

### Part A — SQL migration (live-applied)

`supabase/migrations/20260415_fix_agent_commission_credit.sql` (also applied directly via Supabase MCP):

1. **Replaced `increment_agent_rake`** to update the AGENTS table (correct columns: `weekly_rake_generated`, `lifetime_rake_generated`, `pending_commission` = `p_amount * commission_rate`). Computes commission inline using the agent's commission_rate. SECURITY DEFINER + idempotent (no-op if agent doesn't exist).

2. **Added `credit_agent_commission_from_rake(p_agent_user_id, p_club_id, p_rake_credit, ...)`** — looks up the agent by user_id+club_id+status='active', computes commission via integer rounding, atomically updates `agents.{weekly_rake_generated, lifetime_rake_generated, pending_commission, last_active_at, updated_at}`, AND inserts an `agent_commissions` audit row. Renamed from `credit_agent_commission` to avoid collision with an existing single-arg overload `(uuid, numeric, text default)`.

### Part B — Settler extension (server code)

Extended `RakebackSettlerService.runSettlement()` to also iterate the per-hand `rake_records` and call `credit_agent_commission_from_rake` for each dealt-in player. The RPC silently no-ops if the player has no agent in that club (clean separation: settler doesn't need to know agent topology).

This means every 30 minutes:

- Player rakeback periods get upserted (BUG 008 fix)
- Agent commissions get credited (BUG 009 fix)
- Both flow from the same `rake_records` audit log ServerTableEngine writes at end-of-hand
- Both use the FIX 144 equal-share formula (`rake_amount / dealtInCount`)

## DECISION D-001 / FIX 144 — STILL HOLDS

Both rakeback and agent commission derive from the same equal-share split. Agent commission is then `equalShare × commission_rate` per dealt-in player. Never weighted by pot contribution.

## Verification queued

After next engine deploy + 30-min settler tick:

1. Re-run live SQL: `SELECT COUNT(*), SUM(amount) FROM agent_commissions WHERE created_at > NOW() - INTERVAL '1 hour';` — should be > 0.
2. Re-run live SQL: `SELECT COUNT(*) FROM agents WHERE pending_commission > 0;` — should match number of active downline-agent users.
3. Sample one agent: pending_commission ≈ Σ(equal_share × commission_rate) for their players' hands in last hour.
4. Open `AgentDashboardPage.tsx` as an agent — should see live commission accumulating.

## Related

- BUG 008 — Rakeback settler missing (`.memory/problems/008-rakeback-settler-missing.md`) — exact same pattern, same root cause class
- DECISION D-001 — Rake equal share (FIX 144) — both bugs preserve this invariant
- Phase D signoff — `.memory/context/2026-04-15-phase-D-signoff.md` (these bugs existed at signoff time but were invisible without live verification)

## Lesson (reinforces BUG 008)

**Two compound silent-failure bugs in 30 minutes.** Both passed code-coverage inventory because every component (services, RPCs, tables, UI) was wired. Both failed the moment we asked "is the data flowing?". The Bible V8 server-authoritative migration moved the engine out of the browser but left two financial flows (rakeback + agent commission) stranded in the orphaned client service. Anything that ran ONLY in `src/services/` (client) and not also in `server/src/services/` is now suspect.

**Action item for future agents:** grep `src/services/` for financial-side operations (`rake`, `commission`, `settle`, `mint`, `wallet_transfer`, `rakeback`) and confirm there's a server-side counterpart for each. The next bug class is likely in this seam.
