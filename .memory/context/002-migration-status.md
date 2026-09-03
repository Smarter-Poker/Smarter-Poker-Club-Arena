CONTEXT: Migration Status
DATE: 2026-03-29

CURRENT STEP: Step 6 — PORT ADVANCED
LAST ROUND: Round 19 — Bible V8 Chapter 7 Edge Cases Deep Verification
LAST FIX: FIX 145
LAST COMMITTED FIX: FIX 142 (commit 4e320f9b)
UNCOMMITTED: FIX 143, 144, 145 + Round 19 changelog

MIGRATION PHASE ORDER (SACRED):
Step 1: RIP OUT client-side engine code ✅
Step 2: VERIFY CLEAN ✅
Step 3: FIX SERVER BLOCKERS ✅
Step 4: PORT CORE ✅
Step 5: PORT SUPPORTING ✅
Step 6: PORT ADVANCED (IN PROGRESS)
Step 7: TOURNAMENT & EXTRAS
Step 8: TABLE SETTINGS & THEME CUSTOMIZATION

VERIFIED AREAS (Round 19):

- §7.1 All-in equity / side pots ✅
- §7.2 Run It Twice (2-run + 3-run) ✅
- §7.3 Insurance (per-street, leader-only) ✅
- §7.4 Insurance + RIT mutual exclusion ✅
- §7.5 Straddle posting ✅
- §7.6 Ante posting ✅
- §7.8 Table break / merge ✅
- §7.9 Tournament hand-for-hand ✅
- §7.10 Disconnection handling ✅
- §7.11 Pre-actions (auto-fold/check/call) ✅
- §7.12 Sit-out mid-hand (FIX 143) ✅ FIXED
- §7.13 Leave during hand ✅
- §7.14 Time bank ✅
- §7.15 Crash recovery ✅
- §7.16 Rabbit hunting ✅
- §7.19 OFC Pineapple ✅ (Math.random gap noted)
- §7.20 Mixed game rotation ✅ (not wired, Phase 8+)

KNOWN GAPS:

- MixedGameEngine ported but not wired (Phase 8+)
- No mid-hand resume from crash (chips conserved via DB)
- Leaderboards/achievements/VIP not in server (Phase 7+)
- OFC uses Math.random() instead of crypto (Phase 7)
