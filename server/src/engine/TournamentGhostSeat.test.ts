/**
 * TOURNAMENT SEAT RELEASE HAS ONE TRANSACTIONAL AUTHORITY.
 *
 * The engine used to poll the roster on every idle tick and repair a seat
 * after another writer had already changed the tournament row. That watcher
 * was evidence of a split transaction, and it could race the next deal. The
 * database hand/elimination authorities now close the exact seat generation
 * in the same transaction as the zero stack and knockout evidence.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dealing = readFileSync(resolve(here, 'ServerTableEngineDealing.ts'), 'utf8');
const terminalHand = readFileSync(
  resolve(
    here,
    '../../../supabase/migrations/20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql'
  ),
  'utf8'
);
const seatExit = readFileSync(
  resolve(
    here,
    '../../../supabase/migrations/20260910042112_stage_b_current_postimage_contraction.sql'
  ),
  'utf8'
);

describe('tournament seat release is committed at the root', () => {
  it('contains no engine ghost-seat watcher, timer, poll, or repair RPC', () => {
    expect(dealing).not.toContain('releaseDeadTournamentSeats');
    expect(dealing).not.toContain('release_dead_tournament_seats');
    expect(dealing).not.toContain('ghostSeatFirstSeen');
    expect(dealing).not.toContain('GHOST_SEAT_ESCALATE_MS');
    expect(dealing).not.toContain('tournament_ghost_seat');
    expect(dealing).not.toContain('tournament_seat_without_entrant');
  });

  it('the accepted hand returns and consumes one exact pre-vacate generation', () => {
    expect(terminalHand).toContain('v_zero_stack_seat_generations');
    expect(terminalHand).toContain('SET left_at = v_zero_stack_vacated_at');
    expect(terminalHand).toContain("'tournament_zero_stack_seat_generations'");
    expect(terminalHand).toContain("'tournament_zero_stack_vacated_at'");
    expect(terminalHand).toContain('accepted tournament hand lost exact closed seat generation');
    expect(terminalHand).toContain('INSERT INTO public.tournament_knockout_candidates(');
    expect(terminalHand).toContain('AND s.left_at=');
  });

  it('ordinary and bounty eliminations hold the same scoped seat-exit capability', () => {
    expect(seatExit).toContain('fn_eliminate_tournament_player_atomic_pre_seat_guard');
    expect(seatExit).toContain('fn_claim_tournament_bounty_elimination_pre_seat_guard');
    expect(seatExit).toContain('fn_ca_open_tournament_seat_exit_authority');
    expect(seatExit).toContain('fn_ca_close_tournament_seat_exit_authority');
    expect(seatExit).toContain('zy_tournament_live_seat_exit_requires_authority');
  });
});
