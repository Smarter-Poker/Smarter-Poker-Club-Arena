import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const clubEntryMigrationNames = new Set([
  'club_creation_atomic_workflow.sql',
  'player_search_authoritative.sql',
  'club_entry_trust_layer.sql',
  'club_join_atomic_workflow.sql',
]);
const migrations = readdirSync(resolve(root, 'supabase/migrations'))
  .filter((file) => clubEntryMigrationNames.has(file.replace(/^\d+_/, '')))
  .sort();

describe('Phase 7 Club Entry release ordering', () => {
  it('uses unique, full-length migration versions in dependency-safe order', () => {
    expect(migrations).toEqual([
      '20260831150100_club_creation_atomic_workflow.sql',
      '20260831150200_player_search_authoritative.sql',
      '20260831150300_club_entry_trust_layer.sql',
      '20260831150400_club_join_atomic_workflow.sql',
    ]);
    expect(new Set(migrations.map((file) => file.split('_')[0])).size).toBe(migrations.length);
  });

  it('creates player preferences before the trust layer installs its trigger', () => {
    const preferences = readFileSync(resolve(root, `supabase/migrations/${migrations[1]}`), 'utf8');
    const trust = readFileSync(resolve(root, `supabase/migrations/${migrations[2]}`), 'utf8');
    expect(preferences).toContain('CREATE TABLE IF NOT EXISTS public.player_search_preferences');
    expect(trust).toContain('trg_audit_player_search_privacy');
  });
});
