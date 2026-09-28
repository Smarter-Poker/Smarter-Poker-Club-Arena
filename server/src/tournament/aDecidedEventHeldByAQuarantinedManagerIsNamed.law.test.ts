/**
 * A DECIDED EVENT HELD BY A MANAGER THAT CANNOT RETIRE IS NAMED, NOT WOKEN
 * (2026-09-28).
 *
 * From 15:00Z on 2026-09-28, 42 SNG/Spin events sat with one player left and
 * their winner unpaid. The decided-but-RUNNING recovery printed
 *
 *   [GameServer] RUNNING tournament <name> (<id>) is decided (1 playing) -
 *   recovering the winner
 *
 * 20-39 times per event per ten minutes, and `FINALIZING` never ran for any
 * of them. Every one was held by a quarantined manager: its stop had failed
 * "retained time-bank custody" after a lease loss, so it held the slot, was
 * fenced, and never swept again. Waking it did nothing; resuming was refused
 * while it held the slot. The log claimed a recovery that could not happen
 * (CLAUDE.md 10.86 rule 1). The custody taint itself came from an ambiguous
 * fn_consume_time_bank overload, removed by migration 20260928154352.
 *
 * Pinned here:
 *   - decidedOwnerAction: no manager -> resume; a manager with no quarantine
 *     record -> wake; the quarantined manager -> held, keyed by its reason;
 *   - both decided sweeps in GameServer ask decidedOwnerActionFor BEFORE they
 *     wake or print "recovering the winner", and a held event is reported
 *     through noteDecidedEventHeld (once per distinct key) and counted on
 *     /health as decidedEventsHeldByQuarantine.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decidedOwnerAction } from './decidedRunningBoard.js';

const GAME_SERVER = readFileSync(resolve(__dirname, '../GameServer.ts'), 'utf8');

function blockAfter(src: string, marker: string, length = 2600): string {
  const at = src.indexOf(marker);
  expect(at, `marker not found: ${marker}`).toBeGreaterThanOrEqual(0);
  return src.slice(at, at + length);
}

describe('a decided event held by a quarantined manager is named, not woken', () => {
  it('decides wake, resume or held from the registered manager and its quarantine', () => {
    expect(decidedOwnerAction({ managerRegistered: false, quarantine: null })).toEqual({
      kind: 'resume',
    });
    expect(decidedOwnerAction({ managerRegistered: true, quarantine: null })).toEqual({
      kind: 'wake',
    });
    const held = decidedOwnerAction({
      managerRegistered: true,
      quarantine: {
        reason: 'GameServer.quarantined_tournament_manager_stop_retry',
        custodyRefusal: 'mixed:physical_identity_unreadable',
      },
    });
    expect(held.kind).toBe('held');
    if (held.kind !== 'held') throw new Error('unreachable');
    expect(held.key).toBe(
      'GameServer.quarantined_tournament_manager_stop_retry|mixed:physical_identity_unreadable'
    );
    expect(held.because).toContain('quarantined');
    expect(held.because).toContain('mixed:physical_identity_unreadable');
    const noRefusal = decidedOwnerAction({
      managerRegistered: true,
      quarantine: { reason: 'x', custodyRefusal: null },
    });
    expect(noRefusal.kind === 'held' && noRefusal.key).toBe('x|none');
  });

  it('the decided-but-RUNNING sweep checks the owner before it claims a recovery', () => {
    const loop = blockAfter(GAME_SERVER, 'for (const t of decidedBoard)');
    const check = loop.indexOf('this.decidedOwnerActionFor(String(t.id))');
    const claim = loop.indexOf('recovering the winner');
    const wake = loop.indexOf("requestEliminationSweep('stalled_decided_survivor')");
    expect(check).toBeGreaterThan(0);
    expect(claim).toBeGreaterThan(check);
    expect(wake).toBeGreaterThan(check);
    const heldEnd = loop.indexOf('continue;', check) + 'continue;'.length;
    const heldBranch = loop.slice(check, heldEnd);
    expect(heldBranch).toContain("decidedAction.kind === 'held'");
    expect(heldBranch).toContain('this.noteDecidedEventHeld(');
    // A held event leaves before the recovery stagger and the claim.
    expect(heldBranch).not.toContain('decidedRecoveries++');
    expect(loop.indexOf('decidedRecoveries++', check)).toBeGreaterThan(heldEnd);
    expect(claim).toBeGreaterThan(heldEnd);
  });

  it('the seat-first finish sweep does not wake a quarantined manager', () => {
    const block = blockAfter(GAME_SERVER, 'const claimedManager = this.tournamentEngines.get(id);', 700);
    const check = block.indexOf('this.decidedOwnerActionFor(id)');
    const wake = block.indexOf("requestEliminationSweep('seat_first_terminal_stack')");
    expect(check).toBeGreaterThan(0);
    expect(wake).toBeGreaterThan(check);
    expect(block.slice(check, wake)).toContain('this.noteDecidedEventHeld(');
  });

  it('the quarantine it reads is the one held by exactly the registered manager', () => {
    const fn = blockAfter(GAME_SERVER, 'private decidedOwnerActionFor(tournamentId: string)', 800);
    expect(fn).toContain('quarantine.heldBy(tournamentId) === manager');
  });

  it('a held event is said once per distinct reason and counted on /health', () => {
    const fn = blockAfter(GAME_SERVER, 'private noteDecidedEventHeld(', 1200);
    expect(fn).toContain('if (reported.get(tournamentId) === action.key) return;');
    expect(fn).toContain("'GameServer.decided_event_held_by_quarantined_manager'");
    expect(fn).not.toContain('recovering the winner');
    expect(GAME_SERVER).toContain(
      'decidedEventsHeldByQuarantine: this.decidedEventsHeldByQuarantine ?? 0,'
    );
  });
});
