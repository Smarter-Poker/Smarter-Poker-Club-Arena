import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * A REBUY BOUNTY IS COLLECTED BY ITS EXACT OBLIGATION (2026-10-22).
 *
 * A player who busts, rebuys and busts again holds one bounty obligation per
 * bust; fn_collect_bounty names the player and refuses
 * (bounty_generation_identity_required). On two Union PKO events that refusal
 * on every rebought bust slowed the bust stage until 35 zero-chip players per
 * event waited up to 7 minutes and every table break was refused. The engine
 * must collect the exact hand's obligation by id whenever one exists.
 */
const SOURCE = readFileSync(resolve(__dirname, 'TournamentManagerEliminations.ts'), 'utf8');

function body(): string {
  const start = SOURCE.indexOf('protected async processBountyCollection(');
  expect(start).toBeGreaterThan(-1);
  return SOURCE.slice(start, start + 20_000);
}

describe('a rebuy bounty is collected by its exact obligation', () => {
  it('looks up the exact hand obligation before collecting', () => {
    const b = body();
    const lookup = b.indexOf(".eq('hand_id', handId)");
    const collect = b.indexOf("supabase.rpc('fn_collect_bounty_obligation'");
    expect(lookup).toBeGreaterThan(-1);
    expect(collect).toBeGreaterThan(lookup);
  });

  it('collects by obligation id when it exists and by player only when it does not', () => {
    const b = body();
    expect(b).toMatch(
      /exactObligationId\s*\?\s*await supabase\.rpc\('fn_collect_bounty_obligation',\s*\{\s*p_obligation_id: exactObligationId\s*\}\)\s*:\s*await supabase\.rpc\('fn_collect_bounty',/
    );
  });

  it('never collects a mystery chest through the knockout path', () => {
    expect(body()).toMatch(/\.neq\('mode', 'mystery_chest'\)/);
  });
});
