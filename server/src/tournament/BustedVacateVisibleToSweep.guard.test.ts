/**
 * A busted tournament seat and its standings zero are one hand transaction.
 *
 * The old runtime vacated table_seats, then separately zeroed
 * tournament_players, while a later elimination sweep tried to repair either
 * half. A crash or race between those writers stranded a player or overwrote
 * a newer stack. The hand-stack authority now owns all three results: settled
 * seat stacks, the standings mirror, and zero-stack seat release.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dealing = readFileSync(join(__dirname, '../engine/ServerTableEngineDealing.ts'), 'utf8');
const migration = readFileSync(
  join(
    __dirname,
    '../../../supabase/migrations/20260908045932_non_satellite_terminal_settlement_commits_one_stored_receipt.sql'
  ),
  'utf8'
);

describe('busted tournament seats close at the stack authority', () => {
  it('has no process-side standings or seat writer after a bust', () => {
    const marker = dealing.indexOf("reason: 'busted_awaiting_rebuy_decision'");
    expect(marker).toBeGreaterThan(-1);
    const block = dealing.slice(Math.max(0, marker - 2_000), marker + 500);
    expect(block).not.toContain(".from('table_seats')");
    expect(block).not.toContain(".from('tournament_players')");
    expect(block).not.toContain('.update({ chips: 0 })');
  });

  it('mirrors standings before atomically releasing named zero-stack seats', () => {
    const start = migration.lastIndexOf(
      'CREATE OR REPLACE FUNCTION public.fn_ca_settle_hand_stacks_absolute('
    );
    const body = migration.slice(start);
    const mirror = body.indexOf('UPDATE public.tournament_players');
    const vacate = body.indexOf('UPDATE public.table_seats', mirror + 1);
    expect(start).toBeGreaterThan(-1);
    expect(mirror).toBeGreaterThan(-1);
    expect(vacate).toBeGreaterThan(mirror);
    expect(body.slice(vacate, vacate + 800)).toMatch(/left_at[\s\S]*stack\s*=\s*0/);
  });
});
