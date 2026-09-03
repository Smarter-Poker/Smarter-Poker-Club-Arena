# Problem 021 — Hand History Viewer Showed "No Hands Recorded Yet" (4-Layer Bug)

**Type:** PROBLEM
**Project:** Smarter Poker Club Arena
**Date Found:** 2026-04-15 (Wave 5a live browser audit)
**Date Fixed:** 2026-04-16 LIVE on production
**Severity:** MEDIUM-HIGH — a visible UX feature was completely broken; user could never see their own hand history
**Commits:** WH `519eaae8`, WH `1fed86cb`, CA `f265f4bd`, SQL migration (live)

## Discovery

Wave 5a audit opened `/hub/club-arena/hand-history` as TestAlias99 with 1,269 hands in the DB. UI showed "No Hands Recorded Yet". Cold-reload didn't help. Four distinct bugs in one feature:

## Layer A — Wrong table

`HandHistoryService.getPlayerHands` queried `hand_players` with a join to `hands`. Both tables empty (0 rows in production). Canonical source is `hand_history` (5.1M rows, JSONB columns `players` / `actions` / `winners` with camelCase keys `userId` / `cards` / `stack`).

**Fix:** rewrote to `.from('hand_history').contains('players', ...)`. New `mapHandHistoryRow` helper maps JSONB to `HandRecord`.

## Layer B — Broken realtime filter

Page used `filter: 'player_ids=cs.{${user.id}}'`. Column `player_ids` doesn't exist on `hand_history`.

**Fix:** removed the filter. Realtime now fires on every INSERT; client-side `.contains` re-filter handles it.

## Layer C — Missing RLS policy

`hand_history` had ONLY a `service_role` SELECT policy. Authenticated users could never read rows, regardless of correct queries.

**Fix:** added migration `20260416_bug_021_hand_history_authenticated_select.sql`:

```sql
CREATE POLICY "hand_history_authenticated_select" ON public.hand_history
  FOR SELECT TO authenticated
  USING (
    players @> jsonb_build_array(jsonb_build_object('userId', auth.uid()::text))
  );
```

Applied LIVE via Supabase MCP.

## Layer D — Supabase JS serialization bug

After layers A/B/C, queries now reached PostgREST but errored:

```
{"code":"22P02","message":"invalid input syntax for type json","details":"Expected string or '}', but found '['"}
```

Supabase-JS `.contains('column', [{userId: x}])` serializes the JS array/object with unquoted keys, producing invalid JSON. The builder accepts strings verbatim though.

**Fix:** pre-stringify explicitly:

```ts
const containmentJson = JSON.stringify([{ userId }]);
supabase.from('hand_history').contains('players', containmentJson);
```

## Live verification (cold-load, Law 11 §11.2)

Fresh Chrome tab → `https://smarter.poker/hub/club-arena/hand-history?final=2026-04-16T00:34` →

- Served bundle `index-DX1xPYhK-v6.js` (confirmed via head fetch)
- Stats bar: **25 HANDS**, BIGGEST POT: **861.66**
- 4+ hand rows visible with pot sizes, timestamps, player counts, Replay/Analyze/Share buttons
- Tabs plain text (emoji violation also fixed in commit `519eaae8`)

## Related

- CLAUDE.md #8 emoji ban — tab labels '✅/❌/🔥' were a separate violation cleaned up in same bundle
- Eleven prior silent-failure bugs (008–020) in this session

## Lesson

**Multi-layer bugs require multi-layer audits.** A single service call can fail at: client code, client RPC params, RLS, DB schema, or the JSON/URL serialization between them. Layer A was the obvious one; it took three more rounds of "fix, deploy, cold-load, capture response body" to root-cause the rest. The `window.fetch` interception pattern was the critical tool — it's the only way to see PostgREST's exact error body in production. Adding `fetch`-intercepting helpers to the verification harness would let agents find Layer D bugs in seconds instead of 20 minutes.
