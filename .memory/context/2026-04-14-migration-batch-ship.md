# CONTEXT: Migration Batch Ship — 2026-04-14

**Type:** CONTEXT
**Captured:** 2026-04-14
**Project:** smarter.poker / club-arena
**Phase:** REALIGN + STEP 8 (Bible V8 Chapter 11) + Phase 2 PokerBros parity

---

## Summary

Single-session ship of four atomic migration units plus a Supabase schema
patch. All REALIGN kill switches (K1, K2, K3, K6, K10) now GREEN on
production. V8 Bible compliance at 97% verified across 115 tracked items.

## Commits Landed (Smarter-Poker-Club-Arena main)

| SHA        | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `11fa041d` | NO-GO-2 client (TablePage event-router migration to engineLastEvent + Supabase `broadcastHandState` pipe deletion) + NO-GO-3 server (4 parallel clocks → `DeadlineScheduler`: InsuranceEngine, RunItTwiceEngine, TableBreakEngine, ServerTableEngine.heartbeatCheckInterval — horse heartbeat synthesis preserved) + Phase 1.3 PR-C+D (ActionErrorToast wired with `submitActionWithToast` wrapper across 11 call sites + Snap-to-hint) + Phase 2 Batch A (T1-02 vertical slider, T1-08 dot toggles + swipe, T1-03 numeric keypad, T1-05 pot shipping curved-arc fan) |
| `b9992387` | STEP 8 / V8 §11.1 dead-toggle wiring (voice/text_message, emoji_enabled, auto_time_bank, enhanced_view) + Phase 2 Batch B (§5.6 Fold Protection Dialog, §5.7 Timebank Counter bottom-left widget)                                                                                                                                                                                                                                                                                                                                                                     |
| `15801e90` | Phase 2 Batch C (T1-09 GTO 4-preset postflop 33/50/75/POT + T1-10 Q/W/E desktop keyboard shortcuts) + COMPLIANCE-TRACKER Chapter 11 entries                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `3f60fa3a` | `supabase/migrations/20260414_user_table_settings_alias_columns.sql` — adds `use_alias` + `table_alias` columns the client hook was upserting into silently (applied to prod via Supabase MCP)                                                                                                                                                                                                                                                                                                                                                                        |

## Bundle Commits (Smarter-Poker-World-Hub main)

- `510cc6f3`, `def57faa`, `1ee52649` — bundle syncs for each source PR. Live
  bundle: `index-DrxiOYA3.js` + `TablePage-34QbxWNW.js` (310,093 bytes).

## REALIGN Kill Switches

| Switch | Meaning                                                      | Status |
| ------ | ------------------------------------------------------------ | ------ |
| K1     | Supabase hand-state channel still live                       | GREEN  |
| K2     | `subscribeToHandState` still exported/called                 | GREEN  |
| K3     | Dead parallel engine paths                                   | GREEN  |
| K6     | Parallel clocks (engines running own setTimeout/setInterval) | GREEN  |
| K10    | Pending deadlines lost on engine restart                     | GREEN  |

## Infrastructure

- **Hetzner engine** (`engine.smarter.poker`): CA HEAD `15801e9`, `/health`
  OK, 18 active tables, 16 tournaments, 1652 hands dealt. All timers now
  flow through the process-global `DeadlineScheduler` singleton.
- **Vercel hub-vanguard** (`prj_op66GkZyZcygXQKm76iyycfVFAQx`): latest
  deploy ready, live bundle matches dist exactly.
- **Supabase** (`kuklfnapbkmacvwxktbh`): `user_table_settings` has all 18
  expected columns (15 spec fields + user_id + 2 timestamps);
  `user_theme_settings` matches Bible V8 §11.2.4 exactly.

## V8 Bible Compliance Tracker

- 115 tracked items
- 112 VERIFIED (97%)
- 2 NEEDS-VERIFY: `gestures_enabled`, `card_slide` — toggles persist but UI
  consumers (swipe-action dispatch, hole-card peek animation) not yet wired
- 1 PARTIAL: 4-tier hand history layering (design choice, not a bug)
- 0 MISSING, 0 BROKEN

## Deferred

- **50-table load test** — requires dedicated harness; the live engine is
  currently serving real users so piling on would be disruptive. Best run
  against a staging instance or during a maintenance window.
- **`gestures_enabled` wiring** — swipe/drag → action dispatch; own batch
- **`card_slide` wiring** — hole-card peek/reveal animation; own batch
- **4-tier hand history** — export tier not yet implemented (design debate)

## Related Memories

- Prior sessions' ship history in `SUMMARY.md`
- Migration governance: `MIGRATION-LAW.md`, `MASTER-MIGRATION-DOCUMENT.md`
- V8 spec source of truth: `skills/bible-v8/BIBLE-V8-REFERENCE.md`
- V8 compliance tracking: `skills/bible-v8/COMPLIANCE-TRACKER.md`

## How to Retrieve

- Summary line in `.memory/SUMMARY.md`
- Full entry at `.memory/context/2026-04-14-migration-batch-ship.md`
- Next-session agents should skim both before planning new work
