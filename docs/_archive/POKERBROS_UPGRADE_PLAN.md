# PokerBros Comprehensive Upgrade Plan

**Drafted:** 2026-04-15, awaiting Dan's approval.
**Prerequisite:** Basic hand-flow functionality shipped + verified. ✅ COMPLETE as of v5 (CA `3b126827` / WH `2fa7c88e`).

This plan is the roadmap from "core hand plays correctly" to "PokerBros-parity platform, except better." It pulls from `docs/POKERBROS_SPEC.md` and maps every spec item to the current code, flags which pieces are done vs missing vs needs-hardening, and orders the work for ship-in-chunks execution.

---

## 0. Ground truth check (first move when Chrome returns)

Take a visible-tab screenshot of the test table during an active hand. Confirm:

- [ ] Exactly ONE seat has the yellow `.seat--active` ring.
- [ ] That ring visibly shrinks 100% → 0% over 15s.
- [ ] On bust, `BuyInModal` pops for rebuy with wallet balance shown.

If all three pass, the basic-functionality phase is closed and this plan starts.

---

## 1. Core gameplay — audit + harden (Phase A, ~1 session)

Everything listed here EXISTS but deserves a final live run-through. Not about adding features, about proving the engine is rock-solid before layering on new ones.

| Item                                         | Code location                          | Verify method                         |
| -------------------------------------------- | -------------------------------------- | ------------------------------------- |
| Heads-up blind posting (dealer = SB)         | `HandController.postBlinds:172`        | 2-player hand live                    |
| Short blind (can't cover) → immediate all-in | `HandController.postBlinds:180`        | Manual: seat with 1-chip stack at 1/2 |
| Short all-in does NOT reopen betting         | `HandController.performAction:398`     | PLO 3-way all-in at uneven stacks     |
| Split pot (identical hands)                  | `determineWinners:612`                 | Two players with board-playing only   |
| Side pots (3+ all-ins at different amounts)  | `calculatePots:414`                    | 4-way all-in with staggered stacks    |
| Odd-chip clockwise from dealer               | `distributePot:643`                    | 3-way chop with 1-chip odd            |
| Rake cap vs pot                              | `completeHand:825`                     | Micro-stakes with big pot             |
| BBJ min-player threshold                     | `completeHand:814`                     | BBJ active but only 2 dealt           |
| Pre-action invalidation on raise             | `PreActionEngine.onBetPlaced:251`      | Set auto_check, opponent raises       |
| Disconnect auto-check-fold                   | `DisconnectEngine`                     | Kill test tab mid-turn                |
| Time bank auto-activation                    | `TimeBankEngine.onPrimaryTimerExpired` | Wait past 15s                         |
| Straddle — UTG + Mississippi                 | `StraddleEngine.ts`                    | Set straddles_enabled                 |
| Run It Twice                                 | `RunItTwiceEngine.ts`                  | 2-way all-in preflop                  |
| Insurance                                    | `InsuranceEngine.ts`                   | Need live all-in runout               |
| Bomb Pot                                     | `HandController.postBombPotAntes`      | Set bomb_pot config                   |

**Output:** A live E2E log with screenshots + pass/fail per row. Anything red goes to immediate fix-first. Anything green gets signed off.

---

## 2. Omaha variants — wire + polish (Phase B, ~1 session)

Engine logic already in `evaluateOmahaHand` / `evaluateOmahaLowHand`. What's missing is surfacing variants in the lobby + UI polish.

- [ ] `PLO4` — wired, verify 4-card display on hero.
- [ ] `PLO5` — card deal count should already work via `getCardsPerPlayer`.
- [ ] `PLO6` — same.
- [ ] `PLO8` (hi-lo) — `determineWinners` branches on `isHiLo`; need lobby toggle + hand-name display for LOW half.
- [ ] Short Deck (Hold'em 6+) — `PokerEngine.evaluateHand` accepts `isShortDeck`; needs deck-prep step to strip 2-5.
- [ ] Double Board — `RunItTwiceEngine` handles 2-board; needs `double_board` setting differentiated from RIT.
- [ ] Crazy Pineapple / Pineapple OFC — `OFCPineappleEngine` exists, lobby coverage missing.

**Ship target:** Each variant playable end-to-end from lobby → seat → hand → showdown.

---

## 3. Tournament polish (Phase C, ~2 sessions)

Core tournament engine in `TournamentEngine.ts`, lots of plumbing in place. Gaps:

- [ ] **Spin-It** hyper-turbo 3-player with multiplier — needs random-multiplier selector + prize-pool computation.
- [ ] **Late reg window** — partially wired; verify chips awarded match starting stack + late-reg cutoff enforced.
- [ ] **Re-entry / rebuy** — `tournamentService.canRebuy` exists; verify rebuy window, chip credit, prize-pool recalculation.
- [ ] **Add-on window** — same.
- [ ] **Payout structure generator** — `PayoutEngine.ts`; verify percentage tables for 9-max, 18-max, 27-max, 45-max, 100+.
- [ ] **Satellite tournaments** — flat-payout structure, ticket-based prizes.
- [ ] **Bounty / PKO** — `isBountyTournament` + `bountyMap` wired; verify KO credit + progressive adjustment.
- [ ] **Final table overlay** — `FinalTableOverlay-*.css` exists; verify it triggers at correct player count.

---

## 4. Club / agent / union economy (Phase D, ~2 sessions)

The economy backbone mostly exists in Supabase tables + pages. Audit:

- [ ] **Clubs** — create / edit / disband; member approval flow.
- [ ] **Unions** — cross-club pool; chip-flow rules.
- [ ] **Agents** — recruit / deposit / withdraw; agent performance metrics.
- [ ] **Diamonds → Chips** — purchase flow (Stripe? in-app?); conversion rate per club.
- [ ] **Chips ledger** — every transaction logged; correctness under high volume.
- [ ] **Rake attribution** — club owner takes X%, union Y%, platform Z%; verify `logRakeCollection`.
- [ ] **Rakeback** — `RakebackEngine.ts` exists; verify equal-share (per session memory D-001) at end of week.

---

## 5. VIP / IAP / daily rewards (Phase E, ~1 session)

- [ ] Time Bank tokens — purchase + consumption (already wired on the timer side).
- [ ] Emojis — throwable reactions; `handleThrowableSelect` exists.
- [ ] Rabbit Cam — post-hand card reveal with proper security (no revealing active hole cards).
- [ ] VIP tiers — bronze/silver/gold/platinum/diamond exist on display; verify qualifying actions.
- [ ] Daily Bonus — free chips per 24h.
- [ ] Daily Draw — prize wheel (random loot).
- [ ] Lucky Draw — rare rewards.

---

## 6. Security + anti-cheat (Phase F, ~2 sessions)

- [ ] Live Alert Engine — AI-driven collusion / bot detection, scoring.
- [ ] Photo Rotating CAPTCHA — at sit-down + random mid-session.
- [ ] GPS / IP / device-ID restrictions — `tables.security_config` shape.
- [ ] Player blacklist — club + union level.
- [ ] Trust / reputation score — `trust_score` already exists; hook into table auto-kick.
- [ ] Hole-card security — already hard-walled via `table_hole_cards` RLS; audit one more time under Bible V8 §4.6.
- [ ] RNG certification trail — crypto-random deal logged; audit log for post-facto review.

---

## 7. Real-time + multi-tabling (Phase G, ~1 session)

- [ ] Waiting list — exists; verify notification when seat opens.
- [ ] Multi-tabling up to 4 — `MultiTablePage` exists; verify sound + action-priority alerts across tiles.
- [ ] Push notifications — "your turn", tournament start, club announcements.
- [ ] Friend list + DMs — `messaging/` folder wired; verify at-table chat respects chat restrictions.

---

## 8. Analytics + reporting (Phase H, ~1 session)

- [ ] Hand history viewer — 6-day rolling buffer (`hand_history_*` tables); verify export.
- [ ] Leak analysis — VPIP / PFR / 3-bet / c-bet frequency.
- [ ] Session P/L + lifetime stats.
- [ ] Club owner revenue dashboard — rake by table, by agent, by time window.
- [ ] Table utilization — hands per hour, filling rate.

---

## 9. "Better than PokerBros" differentiators

These are Dan's specific "better" items, intentionally last so they don't block parity.

1. **Modern Bible V8 UI** — mostly done via current pass, keep refining.
2. **GTO training integration (Orb #4)** — hook training modules into in-session coaching.
3. **Reputation / trust score visible at table** — tiny badge on opponent avatars.
4. **Web + mobile + desktop** — already web; expand to native later.
5. **Faster hand turnover** — benchmark current 86 hands/hour; target 100+.
6. **Deep tournament variety** — spin-it / bounty / PKO / satellites all in phase C.

---

## Execution rules (Dan's existing standing orders)

1. Fix-first — when an audit finds a bug, write the fix inline, don't queue it.
2. No rubber-stamping — every "verified" line needs actual live test + screenshot.
3. TypeScript clean before every ship (`npx tsc --noEmit`).
4. Commit messages reference Bible V8 section + PokerBros spec row.
5. Deploy ladder: CA source push → WH bundle push → Hetzner engine redeploy → Supabase SQL migration (in that order, gated by type-check).
6. Session memory entry per phase so next session has the full context.

---

## Suggested first-session-after-approval

**Phase A items 1-5** (core gameplay verification). Chrome back → test table → one screenshot per row. Anything that regresses gets the fix-first treatment. Close out with a session-memory `phase-A-signoff.md` entry.
