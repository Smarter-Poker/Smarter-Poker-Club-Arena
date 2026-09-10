/**
 * LAW: the stats a player reads survive the hand prune.
 *
 * hand_history is pruned after seven days for horse-only hands (Dan's
 * retention ruling, CLAUDE.md 10.5). The stats page does not read
 * hand_history for its numbers; it reads three DURABLE tables that were built
 * precisely so that day eight does not empty the page:
 *
 *   ca_hand_player_stat   the ~28 scalars per player per hand (most recent
 *                         1,000 hands per player, pruned by COUNT, never by
 *                         the hand pruner)
 *   ca_hand_facts         the engine's settlement row: exact money, all-in
 *                         equity, hole cards
 *   ca_hand_transfers     who took chips from whom (Nemesis / Target)
 *
 * ca_hand_player_idx is the one table the pruner MAY touch: it is a pointer
 * from player to hand, and a pointer to a pruned hand is garbage
 * (20260830236000_ca_hand_player_idx_prunes_with_its_hands).
 *
 * This law reads the newest definition of sp_prune_hand_history in the
 * migrations and fails if it names any of the three durable tables, and reads
 * the newest ca_prune_hand_player_stat to pin that the per-player keep is at
 * least the page's analysis window. It exists because the 2026-09-03
 * programme document described the stat table as "durable per player per
 * hand" without saying what bounded it, and the next agent to "tidy" the
 * pruner would have had nothing telling them these tables are load-bearing.
 *
 * Registered in docs/LAWS.md.
 */
import { describe, expect, it } from 'vitest';
import { migrationCorpus } from './helpers/migrationCorpus';

const DURABLE = ['ca_hand_player_stat', 'ca_hand_facts', 'ca_hand_transfers'] as const;

/** The body of the newest migration that (re)defines `fn`, by version order. */
function newestDefinition(fn: string): { file: string; body: string } {
  const re = new RegExp(`create\\s+(or\\s+replace\\s+)?function\\s+public\\.${fn}\\s*\\(`, 'i');
  /* READ THE DIRECTORY ONCE (2026-09-10): this walked all 2,849 migrations for
     every function it was asked about and crossed vitest's 5s default on a
     busy machine. tests/helpers/migrationCorpus reads it once per file. */
  let found: { file: string; body: string } | null = null;
  for (const { name: file, sql: text } of migrationCorpus()) {
    const m = re.exec(text);
    if (!m) continue;
    // From the CREATE to the end of that function's dollar-quoted body.
    const start = m.index;
    const tagMatch = /AS\s+(\$[a-zA-Z_]*\$)/i.exec(text.slice(start));
    if (!tagMatch) continue;
    const tag = tagMatch[1];
    const bodyStart = start + tagMatch.index + tagMatch[0].length;
    const bodyEnd = text.indexOf(tag, bodyStart);
    if (bodyEnd < 0) continue;
    found = { file, body: text.slice(bodyStart, bodyEnd) };
  }
  if (!found) throw new Error(`no migration defines public.${fn}`);
  return found;
}

describe('LAW: the stats a player reads survive the hand prune', () => {
  const prune = newestDefinition('sp_prune_hand_history');

  it('is read from a real migration (the newest one that defines the pruner)', () => {
    expect(prune.file).toMatch(/^\d{8,14}.*\.sql$/);
    expect(prune.body.length).toBeGreaterThan(200);
  });

  for (const table of DURABLE) {
    it(`sp_prune_hand_history never names ${table}`, () => {
      const stripped = prune.body.replace(/--[^\n]*/g, ''); // comments may mention it
      expect(stripped).not.toMatch(new RegExp(`\\b${table}\\b`, 'i'));
    });
  }

  it('sp_prune_hand_history is allowed to prune the player->hand pointer table', () => {
    // Not a requirement, a statement of where the line is: this is the one
    // table the pruner touches, and the reason the durable three are named.
    expect(prune.body).toMatch(/ca_hand_player_idx/);
  });

  it('ca_prune_hand_player_stat keeps at least the page analysis window per player', () => {
    const keep = newestDefinition('ca_prune_hand_player_stat');
    let def: RegExpExecArray | null = null;
    for (const { sql: t } of migrationCorpus()) {
      const m =
        /function\s+public\.ca_prune_hand_player_stat\s*\(\s*p_keep\s+int(?:eger)?\s+DEFAULT\s+(\d+)/i.exec(
          t
        );
      if (m) def = m;
    }
    expect(def, 'ca_prune_hand_player_stat(p_keep int DEFAULT n)').not.toBeNull();
    const keepDefault = Number(def![1]);
    // The page RPC reads the most recent c_cap = 750 rows. The keep must
    // cover that with room for the roller to prune behind it.
    expect(keepDefault).toBeGreaterThanOrEqual(750);
    expect(keep.body).toMatch(/row_number\(\)\s+OVER\s*\(PARTITION BY user_id/i);
  });

  it('the forward roll prunes by count per player, not by hand age', () => {
    const roll = newestDefinition('ca_roll_hand_stats_forward');
    const stripped = roll.body.replace(/--[^\n]*/g, '');
    // A DELETE on the stat table must be the per-player rank prune ...
    const deletes =
      stripped.match(/DELETE\s+FROM\s+(?:public\.)?ca_hand_player_stat[\s\S]*?;/gi) ?? [];
    for (const d of deletes) {
      expect(d).toMatch(/row_number\(\)\s+OVER\s*\(PARTITION BY user_id/i);
      // ... and never an age cut, which is the hand pruner's rule, not this table's.
      expect(d).not.toMatch(/interval\s+'\d+\s+days?'/i);
    }
  });
});
