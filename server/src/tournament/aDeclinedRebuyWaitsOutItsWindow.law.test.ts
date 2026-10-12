/**
 * LAW: A DECLINED REBUY WAITS OUT ITS WINDOW INSTEAD OF HAMMERING THE DOOR
 * (2026-10-09).
 *
 * A horse that declined its Free Buy rebuy was sent to the knockout door at
 * once, while its database deadline was still open. The door refuses that bust
 * (`rebuy_decision_open`) until the deadline passes, so every such horse was
 * refused on every pass for 30 seconds: 345 refusals in three hours, each one
 * an error report, a bust-refusal streak step and a stopped assignment pass for
 * the rest of the field. A player whose decision is open, horse or human, is
 * now left for the pass that runs just after the deadline.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  REBUY_DEADLINE_MARGIN_MS,
  rebuyDecisionDeadlines,
} from './TournamentManagerEliminations.js';

const src = readFileSync(
  fileURLToPath(new URL('./TournamentManagerEliminations.ts', import.meta.url)),
  'utf8'
);

describe('a declined rebuy waits out its window', () => {
  it('reads every open deadline and nothing else', () => {
    const until = '2026-10-09T13:38:04.381Z';
    const m = rebuyDecisionDeadlines([
      { user_id: 'open', decision_open: true, rebuy_prompt_until: until },
      { user_id: 'closed', decision_open: false, rebuy_prompt_until: until },
      { user_id: 'none', decision_open: true, rebuy_prompt_until: null },
      { user_id: 'junk', decision_open: true, rebuy_prompt_until: 'not a date' },
      null,
    ]);
    expect([...m.entries()]).toEqual([['open', Date.parse(until)]]);
    expect(rebuyDecisionDeadlines(null).size).toBe(0);
    expect(REBUY_DEADLINE_MARGIN_MS).toBeGreaterThan(0);
  });

  it('no longer lets an answered player past an open decision', () => {
    const start = src.indexOf("'fn_open_tournament_rebuy_decisions'");
    const block = src.slice(start, src.indexOf('let bustedOrdered', start));
    expect(block).not.toContain('answered.has(');
    expect(block).toMatch(
      /if \(!decisions\.has\(b\.user_id\)\) return false;\s*return decisions\.get\(b\.user_id\) !== true;/
    );
  });

  it('asks for the pass that runs just after the earliest open deadline', () => {
    const start = src.indexOf("'fn_open_tournament_rebuy_decisions'");
    const block = src.slice(start, src.indexOf('let bustedOrdered', start));
    expect(block).toContain('const openUntilMs = rebuyDecisionDeadlines(decisionsRaw);');
    expect(block).toMatch(
      /this\.requestUrgentEliminationSweepAfter\(\s*Math\.min\(\.\.\.nextDeadline\) - nowMs \+ REBUY_DEADLINE_MARGIN_MS\s*\)/
    );
  });
});
