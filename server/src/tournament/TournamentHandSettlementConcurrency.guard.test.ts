import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    '../supabase/migrations/20260909014534_non_satellite_terminal_settlement_commits_one_stored_receipt.sql'
  ),
  'utf8'
);

function functionBody(name: string): string {
  const start = MIGRATION.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  const declaration = MIGRATION.slice(start);
  const body = declaration.match(/\bAS\s+(\$[A-Za-z0-9_]*\$)/);
  if (!body?.[1] || body.index == null) throw new Error(`missing body for ${name}`);
  const tag = body[1];
  const bodyStart = start + body.index + body[0].length;
  const end = MIGRATION.indexOf(`${tag};`, bodyStart);
  if (end < 0) throw new Error(`incomplete body for ${name}`);
  return MIGRATION.slice(bodyStart, end);
}

describe('tournament hand settlements do not serialize the whole field', () => {
  const settlement = functionBody('fn_ca_commit_hand_settlement_before_lease_generation');

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
