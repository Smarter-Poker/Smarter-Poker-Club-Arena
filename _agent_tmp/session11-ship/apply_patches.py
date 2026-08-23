#!/usr/bin/env python3
"""Apply the session-11 anchored patches. Fails loudly on any missed anchor."""
import sys, pathlib

W = pathlib.Path(sys.argv[1])
S = pathlib.Path(sys.argv[2])
applied, failed = [], []


def patch(rel, old, new, label):
    p = W / rel
    txt = p.read_text()
    if new in txt and old not in txt:
        applied.append(f"{label} (already applied)")
        return
    if txt.count(old) != 1:
        failed.append(f"{label}: anchor matched {txt.count(old)} times in {rel}")
        return
    p.write_text(txt.replace(old, new, 1))
    applied.append(label)


BASE = "server/src/tournament/TournamentManagerBase.ts"

patch(BASE,
      "import { acceleratedLevelMs } from './acceleratedLevels.js';",
      "import { acceleratedLevelMs } from './acceleratedLevels.js';\n"
      "import { startFloorFor, effectivePrizePool } from './startRules.js';",
      "P3.a import")

patch(BASE,
      "      if ((regCount || 0) < 3) {",
      "      // Heads-Up SNGs (2-seat, 2026-08-22 parity) are FULL at two players —\n"
      "      // the historical hard floor of 3 held every duel in REGISTERING forever\n"
      "      // (see startRules.ts for the incident). The floor is now min(3,\n"
      "      // max_players), never below 2.\n"
      "      const startFloor = startFloorFor(tournament.max_players);\n"
      "      if ((regCount || 0) < startFloor) {",
      "P3.b start floor")

patch(BASE,
      "          `[Tournament:${this.tournamentId.slice(0, 8)}] Only ${regCount} player(s) — standing down so the field can be filled (NOT cancelling)`",
      "          `[Tournament:${this.tournamentId.slice(0, 8)}] Only ${regCount} player(s) of the ${startFloor} needed — standing down so the field can be filled (NOT cancelling)`",
      "P3.b log line")

patch(BASE,
      "      // Set tournament to RUNNING\n      // Guard: only transition REGISTERING → RUNNING (prevents re-starting)",
      """      // ── GUARANTEE, no-late-reg case (2026-08-23) ──
      // An event with no late registration takes its last entry before this
      // line, so the pool it holds now is the pool it dies with — apply the
      // advertised guarantee here and finalize. Events WITH late reg are
      // bumped at finalization instead, where the pool truly stops moving.
      // Scheduler-spawned events accrue per-entry through the register RPCs
      // and nothing else ever applied guaranteed_prize (the old recurring
      // service pre-applied it at creation, which is why this was never seen
      // before the 2026-08-22 data-driven schedules).
      {
        const lateRegCap = Number(
          tournament.late_reg_levels ?? tournament.rebuy_levels ?? 0
        );
        const gtd = Number(tournament.guaranteed_prize) || 0;
        if (lateRegCap <= 0 && gtd > 0 && !this.prizePoolFinalized) {
          const { data: poolRow } = await supabase
            .from('tournaments')
            .select('prize_pool')
            .eq('id', this.tournamentId)
            .maybeSingle(); // FIX 168
          const poolNow = Number(poolRow?.prize_pool) || 0;
          const finalPool = effectivePrizePool(poolNow, gtd);
          if (finalPool > poolNow) {
            await supabase
              .from('tournaments')
              .update({ prize_pool: finalPool, prize_pool_finalized: true } as any)
              .eq('id', this.tournamentId);
            tournament.prize_pool = finalPool;
            if (this.tournamentCache) this.tournamentCache.prize_pool = finalPool;
            this.prizePoolFinalized = true;
            console.log(
              `[Tournament:${this.tournamentId.slice(0, 8)}] Guarantee applied at start: pool ${poolNow} -> ${finalPool}`
            );
          }
        }
      }

      // Set tournament to RUNNING
      // Guard: only transition REGISTERING → RUNNING (prevents re-starting)""",
      "P3.c guarantee at start")

patch(BASE,
      """            this.prizePoolFinalized = true;
            const { data: freshT } = await supabase
              .from('tournaments')
              .select('prize_pool')
              .eq('id', this.tournamentId)
              .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single
            if (freshT) {
              await supabase
                .from('tournaments')
                .update({
                  prize_pool: freshT.prize_pool,
                  prize_pool_finalized: true,
                } as any)
                .eq('id', this.tournamentId);
              console.log(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Late reg/rebuy closed at level ${this.currentLevel} — prize pool finalized: ${freshT.prize_pool}`
              );
            }
            await this.broadcast('late_reg_closed', { prizePool: freshT?.prize_pool || 0 });
            if (freshT) {
              await this.recalculateEliminatedPrizes(freshT.prize_pool);
            }""",
      """            this.prizePoolFinalized = true;
            const { data: freshT } = await supabase
              .from('tournaments')
              .select('prize_pool, guaranteed_prize')
              .eq('id', this.tournamentId)
              .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single
            // GUARANTEE (2026-08-23): the pool stops moving here, so this is
            // where the advertised guarantee becomes real money. Writing the
            // max back to prize_pool keeps every reader — payouts, lobby,
            // fn_tournament_payout_reconcile — agreeing on one number.
            const finalPool = freshT
              ? effectivePrizePool(freshT.prize_pool, freshT.guaranteed_prize)
              : 0;
            if (freshT) {
              await supabase
                .from('tournaments')
                .update({
                  prize_pool: finalPool,
                  prize_pool_finalized: true,
                } as any)
                .eq('id', this.tournamentId);
              console.log(
                `[Tournament:${this.tournamentId.slice(0, 8)}] Late reg/rebuy closed at level ${this.currentLevel} — prize pool finalized: ${finalPool}`
              );
            }
            await this.broadcast('late_reg_closed', { prizePool: finalPool });
            if (freshT) {
              await this.recalculateEliminatedPrizes(finalPool);
            }""",
      "P3.d guarantee at late-reg close")

patch(BASE,
      """    this.prizePoolFinalized = true;
    const { data: freshT } = await supabase
      .from('tournaments')
      .select('prize_pool')
      .eq('id', this.tournamentId)
      .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single
    if (freshT) {
      await supabase
        .from('tournaments')
        .update({
          prize_pool: freshT.prize_pool,
          prize_pool_finalized: true,
        } as any)
        .eq('id', this.tournamentId);

      await this.recalculateEliminatedPrizes(freshT.prize_pool);
    }""",
      """    this.prizePoolFinalized = true;
    const { data: freshT } = await supabase
      .from('tournaments')
      .select('prize_pool, guaranteed_prize')
      .eq('id', this.tournamentId)
      .maybeSingle(); // FIX 168: Bible safety rule — use maybeSingle over single
    if (freshT) {
      // GUARANTEE (2026-08-23): same rule as the late-reg-close site — the
      // pool is final now, so the advertised guarantee is applied here.
      const finalPool = effectivePrizePool(freshT.prize_pool, freshT.guaranteed_prize);
      await supabase
        .from('tournaments')
        .update({
          prize_pool: finalPool,
          prize_pool_finalized: true,
        } as any)
        .eq('id', this.tournamentId);

      await this.recalculateEliminatedPrizes(finalPool);
    }""",
      "P3.e guarantee at add-on end")

patch("server/src/tournament/TournamentManager.ts",
      "    const seats = ticketCost > 0 ? Math.floor(pool / ticketCost) : 0;",
      """    // 2026-08-23 parity follow-up: satellite_seats is the ADVERTISED seat
    // count and wins when set (the 2026-08-22 template stores it; the Sunday
    // Major Satellite promises 5). floor(pool / ticket) remains the fallback
    // for legacy satellites created before the column existed. With no open
    // target (ticketCost 0) seats stay 0 so the whole pool falls through to
    // the cash path below — advertised seats into a vanished target would
    // otherwise pay nothing at all.
    const configuredSeats = Math.max(
      0,
      Math.floor(Number((tournament as { satellite_seats?: unknown })?.satellite_seats) || 0)
    );
    const seats =
      ticketCost > 0
        ? configuredSeats > 0
          ? configuredSeats
          : Math.floor(pool / ticketCost)
        : 0;""",
      "P4 satellite seats honored")

patch("server/src/tournament/TournamentManagerEliminations.ts",
      "'payout_structure, prize_pool, buy_in_fee, current_players, club_id, name, status, is_bounty, is_pko, is_mystery_bounty, variant, tournament_type, spin_multiplier, satellite_target_id'",
      "'payout_structure, prize_pool, buy_in_fee, current_players, club_id, name, status, is_bounty, is_pko, is_mystery_bounty, variant, tournament_type, spin_multiplier, satellite_target_id, satellite_seats'",
      "P5 satellite_seats select")

patch("server/src/services/ScheduledTournamentService.ts",
      """    for (const col of ScheduledTournamentService.RESTART_COPY_COLUMNS) {
      if (old[col] !== undefined) row[col] = old[col];
    }""",
      """    for (const col of ScheduledTournamentService.RESTART_COPY_COLUMNS) {
      if (old[col] !== undefined) row[col] = old[col];
    }

    // A legacy instance can carry a pre-floor fee split (e.g. 22+3 = 12%)
    // that tournaments_rake_within_10_pct now rejects on INSERT — the clone
    // would fail on every poll for 24 hours. Re-cut the fee from the same
    // player-paid total (floor 10%, splitBuyIn's arithmetic without the
    // ladder snap — a manual event keeps its price). Compliant splits,
    // including every spin's fee-free 0, pass through untouched.
    {
      const amt = Number(row.buy_in_amount) || 0;
      const fee = Number(row.buy_in_fee) || 0;
      const cap = Math.floor((amt + fee) * 0.1 + 1e-9);
      if (fee > cap) {
        row.buy_in_amount = amt + fee - cap;
        row.buy_in_fee = cap;
      }
    }""",
      "P6 restart-clone rake recut")

DETAILS = "src/pages/tournament/TournamentDetails.tsx"

patch(DETAILS,
      "import { FinalTableOverlay } from '../../components/tournament/FinalTableOverlay';",
      "import { FinalTableOverlay } from '../../components/tournament/FinalTableOverlay';\n"
      "import RegistrationApprovalsPanel from '../../components/tournament/RegistrationApprovalsPanel';",
      "P7.a approvals import")

patch(DETAILS,
      """        {activeTab === 'detail' && (
          <>
            {/* Tournament Results (for completed tournaments) */}""",
      """        {activeTab === 'detail' && (
          <>
            {/* Authorized-to-register approvals (2026-08-23): the owner-facing
                whitelist manager the gate shipped without. Renders null for
                non-admins and for events without the flag. */}
            <RegistrationApprovalsPanel
              tournamentId={tournament.id}
              clubId={String((tournament as any).club_id || '')}
              authorizedToRegister={Boolean((tournament as any).authorized_to_register)}
            />
            {/* Tournament Results (for completed tournaments) */}""",
      "P7.b approvals render")

# P9 changelog
cl = W / "MIGRATION-CHANGELOG.md"
entry = (S / "changelog-session11b.md").read_text().rstrip() + "\n"
txt = cl.read_text()
if "LINE-BY-LINE PARITY AUDIT" in txt:
    applied.append("P9 changelog (already applied)")
else:
    lines = txt.split("\n")
    idx = next(i for i, l in enumerate(lines) if l.strip() == "---")
    new_txt = "\n".join(lines[: idx + 1]) + "\n\n" + entry + "\n" + "\n".join(lines[idx + 1 :]).lstrip("\n")
    cl.write_text(new_txt)
    applied.append("P9 changelog")

print("APPLIED:")
for a in applied:
    print("  +", a)
if failed:
    print("FAILED:")
    for f in failed:
        print("  !", f)
    sys.exit(1)
print("ALL ANCHORS MATCHED")
