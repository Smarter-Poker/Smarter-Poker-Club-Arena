import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20261003140226_stats_owner_workspace.sql'),
  'utf8'
);

const tables = [
  'reports',
  'leaks',
  'goals',
  'goal_progress',
  'collections',
  'collection_hands',
  'preferences',
  'alert_rules',
];

describe('Stats owner workspace migration', () => {
  it('is atomic and owner-only at every persisted surface', () => {
    expect(migration.trimStart().startsWith('-- 20261003140226')).toBe(true);
    expect(migration).toMatch(/\nBEGIN;[\s\S]*\nCOMMIT;\s*$/);
    for (const table of tables) {
      expect(migration).toContain(
        `ALTER TABLE public.ca_stats_workspace_${table} ENABLE ROW LEVEL SECURITY;`
      );
      expect(migration).toMatch(
        new RegExp(
          `ON public\\.ca_stats_workspace_${table}\\s+FOR ALL TO authenticated USING \\(user_id = auth\\.uid\\(\\)\\)`
        )
      );
    }
    expect(migration).toContain('FROM PUBLIC, anon;');
    expect(migration).not.toMatch(/\bp_user(?:_id)?\b/);
  });

  it('refuses a materially different replay of the same report identity', () => {
    expect(migration).toContain(
      'CONSTRAINT ca_stats_workspace_reports_identity UNIQUE (user_id, idempotency_key)'
    );
    expect(migration).toContain('extensions.digest(');
    expect(migration).toContain('ca_stats_workspace_reports.request_hash = EXCLUDED.request_hash');
    expect(migration).toContain("RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '23505'");
  });

  it('uses existing private hand notes and makes no background delivery claim', () => {
    const collectionTable = migration.match(
      /CREATE TABLE public\.ca_stats_workspace_collection_hands[\s\S]*?\n\);/
    )?.[0];
    expect(collectionTable).toBeDefined();
    expect(collectionTable).not.toMatch(/\bnote\b|\btags\b/);
    expect(migration).toContain(
      'FROM public.ca_hand_notes WHERE hand_id = p_hand_id AND user_id = v_user'
    );
    expect(migration).toContain("evaluation_mode text NOT NULL DEFAULT 'on_stats_refresh'");
    expect(migration).toContain('fn_ca_stats_workspace_alerts_evaluate');
    expect(migration).toContain('last_triggered_at');
    expect(migration).toContain("source_kind IN ('player_authored', 'rule_derived')");
    expect(migration).not.toMatch(
      /CREATE\s+(?:EXTENSION\s+)?(?:CRON|SCHEDULE)|pg_cron|setInterval/i
    );
  });
});
