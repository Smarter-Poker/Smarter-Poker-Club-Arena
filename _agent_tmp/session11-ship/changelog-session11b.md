## Cowork session 2026-08-23 (11b) — LINE-BY-LINE PARITY AUDIT: four live bugs, one panel the gate never had

Dan asked for everything pending finished and the whole tournament surface
audited line by line. The audit ran against prod behavior first (Supabase),
then the code. Four real bugs, all verified live before a line was written:

1. HEADS-UP LANE DEAD (engine): start() hard-coded a 3-player floor. A
   2-seat Heads-Up SNG is FULL at 2, so "Heads-Up Hyper Duel" (0504c8fb) sat
   REGISTERING 4+ hours at 2/2 while discovery started it and the floor stood
   it down, every pass — and the interval scheduler, seeing a live instance,
   never spawned another duel all day. Fix: startFloorFor(max_players) =
   min(3, max_players) clamped at 2, in the new pure module
   server/src/tournament/startRules.ts, unit-tested.

2. GUARANTEES WERE DISPLAY-ONLY for scheduler-spawned events (engine): the
   old recurring service pre-wrote prize_pool = max(entries, guarantee) at
   creation; the 2026-08-22 data-driven scheduler accrues per-entry through
   the register RPCs and NOTHING ever applied guaranteed_prize — Bounty
   Builder Turbo COMPLETED paying from a 12.5 pool against a 500 GTD, and the
   Sunday Midway Major was heading for the same against 10000. The lobby
   already displayed max(pool, gtd); only the money was wrong. Fix:
   effectivePrizePool(pool, gtd) written back to prize_pool at every point
   the pool stops moving — late-reg close, add-on end, and start() for
   events with no late registration — so payouts, lobby and the payout
   reconciler all read one number.

3. SATELLITE SEAT COUNT IGNORED (engine): processSatelliteAwards derived
   seats from floor(pool / ticketCost); the satellite_seats column the
   2026-08-22 template stores (Sunday Major Satellite advertises 5) was read
   by nothing. Fix: configured seats win; pool-derived remains the legacy
   fallback; no open target still falls through to the all-cash path.

4. ENTRY SPLIT INVENTED RAKE (DB, fixed live mid-session): the bounty branch
   of fn_tournament_entry_split defaulted the rake ratio to 10% when
   buy_in_fee = 0 — but zero IS the lawful fee for totals under 10 since the
   2026-08-21 floor rule. Every small bounty event was over-raked at
   registration and the pools picked up decimals (Blitz Bounty 6.8, observed;
   should be 8). fn now takes rake = fee, full stop. Applied to prod with
   passing shape assertions (3/0/1 → 2 to pool; 5/0/2 → 3; 18/2/9 → charge
   20 rake 2; 90/10 non-bounty unchanged);
   supabase/migrations/20260823000000_fix_entry_split_no_default_rake.sql is
   the repo record. History (completed pools) left as settled.

Plus, from the handoff's pending list (item 3): AUTHORIZED-TO-REGISTER
APPROVALS PANEL — the gate + table shipped 2026-08-22 with no owner surface.
RegistrationApprovalsPanel (TournamentDetails, detail tab) lists approvals,
searches club members, approves/revokes via direct RLS-backed writes
(trapp_admin_write), and renders only for club admins on gated events.

Defensive: restart-lane clones re-cut a legacy over-cap fee from the same
player-paid total before INSERT, so tournaments_rake_within_10_pct can never
hold a clone in a 24-hour retry loop.

Also this session, shipped separately: PR #320 (the rake-cap constraint had
frozen two mid-flight tournaments for 29 hours — data repair; both completed
within minutes) and PR #301 (the stranded session-10 changelog, rebased).

KNOWN LIMITS recorded: satellite seats into a BOUNTY target carry no funded
bounty head (do not point satellites at bounty events yet); multi-day remains
flag-only; ban_chat remains client-enforced (no server chat path exists);
schedule GTD configs are generous relative to horse-filled fields, so
overlays are real house spend — Dan should review the seeded guarantee
numbers if that matters.
