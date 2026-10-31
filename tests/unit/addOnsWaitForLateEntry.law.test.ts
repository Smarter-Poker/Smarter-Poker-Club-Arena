import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const read = (p: string) => readFileSync(p, 'utf8');
describe('add-ons wait for the last late-entry level', () => {
  it('runs the actual PostgreSQL transition and purchase regression in required accounting CI', () => {
    expect(read('.github/workflows/ci.yml')).toContain(
      'python3 -B scripts/ci/test-addon-after-entry-levels.py'
    );
    const test = read('scripts/ci/test-addon-after-entry-levels.py');
    expect(test).toContain('RED elapsed80 opens at displayedlevel4');
    expect(test).toContain('immutable historical receipt replays after close');
    expect(test).toContain('MIG.read_text()');
    const sql = read(
      'supabase/migrations/20261031211918_add_on_waits_for_last_late_entry_level.sql'
    );
    expect(sql).toContain('public.fn_close_tournament_entry_window(uuid,text)');
    expect(sql).toContain(
      'public.process_tournament_rebuy(uuid,uuid,text,numeric,numeric,integer,text)'
    );
    expect(sql).not.toContain("d:=pg_get_functiondef('public.fn_close_tournament_addon_period");
    expect(test).toContain('legacy expired window still closes without holding old engine');
    expect(sql).toContain('ADDON_ENTRY_LEVEL_PREIMAGE_CHANGED');
  });
});
