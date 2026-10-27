/**
 * THE HOST RULES ARE ONE READ (2026-10-26). The Lightning host's rules are the
 * physical engine's own table row (loadTable) plus the club rake defaults,
 * which now ride loadTable's club embed: `clubs` is not asked a second time.
 */
import { describe, expect, it, vi } from 'vitest';

const from = vi.fn(() => {
  throw new Error('no second read');
});
vi.mock('../services/supabase/client.js', () => ({
  supabase: { from, rpc: vi.fn() },
  maintenanceSupabase: {},
}));
const loadTable = vi.fn();
vi.mock('../services/supabase/tables.js', () => ({ loadTable }));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), describeError: String }));

const { createSupabaseLightningHandBackend } = await import('./LightningHandBackend.js');

describe('loadHostRules', () => {
  it('returns the row with its club rake defaults and makes no clubs request', async () => {
    const defaults = { rakePercent: 5, rakeCapBB: 2, unionId: null };
    loadTable.mockResolvedValue({ id: 't', club_id: 'club', club_rake_defaults: defaults });
    const rules = await createSupabaseLightningHandBackend().loadHostRules('t');
    expect(loadTable).toHaveBeenCalledWith('t');
    expect(from).not.toHaveBeenCalled();
    expect(rules.club_rake_defaults).toEqual(defaults);
  });

  it('a table with no club has no club defaults, as before', async () => {
    loadTable.mockResolvedValue({ id: 't', club_id: null, club_rake_defaults: null });
    const rules = await createSupabaseLightningHandBackend().loadHostRules('t');
    expect(rules.club_rake_defaults).toBeNull();
    expect(from).not.toHaveBeenCalled();
  });
});
