import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    '../supabase/migrations/20260907203000_an_accepted_hand_is_one_commit_and_stats_leave_the_hot_path.sql'
  ),
  'utf8'
);

function functionBody(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = MIGRATION.match(
    new RegExp(
      `CREATE OR REPLACE FUNCTION public\\.${escaped}\\([\\s\\S]*?AS \\$function\\$([\\s\\S]*?)\\$function\\$;`
    )
  );
  if (!match?.[1]) throw new Error(`missing ${name}`);
  return match[1];
}

describe('tournament hand settlements do not serialize the whole field', () => {
  const settlement = functionBody('fn_ca_commit_hand_settlement');

  it('holds the tournament lifecycle boundary in shared mode', () => {
    expect(settlement).toMatch(/FROM public\.tournaments t WHERE t\.id=v_tournament_id FOR SHARE;/);
    expect(settlement).not.toMatch(
      /FROM public\.tournaments t WHERE t\.id=v_tournament_id FOR UPDATE;/
    );
  });

  it('retains exclusive per-table and per-player settlement boundaries', () => {
    expect(settlement).toContain("hashtextextended('atomic-table:'||p_table_id::text,0)");
    expect(settlement).toMatch(
      /FROM public\.tournament_players tp[\s\S]*?ORDER BY tp\.user_id[\s\S]*?FOR UPDATE;/
    );
    expect(settlement).toMatch(
      /FROM public\.table_seats s[\s\S]*?s\.left_at IS NULL[\s\S]*?FOR UPDATE;/
    );
  });
});
