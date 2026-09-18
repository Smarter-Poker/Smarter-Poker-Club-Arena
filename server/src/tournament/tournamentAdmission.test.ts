import { describe, expect, it, vi } from 'vitest';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../services/supabase.js', () => ({ supabase: { rpc } }));
import {
  projectTournamentAdmission,
  readTournamentAdmissionSnapshot,
} from './tournamentAdmission.js';
const parent = { id: 'c3000000-0000-4000-8000-000000000001', format_contract: 'mtt-v1' };
function receipt(abi = 'legacy-capacity-v1', cap: number | null = 20) {
  return {
    ok: true,
    admission_abi: abi,
    entries: [
      {
        tournament_id: parent.id,
        format_contract: parent.format_contract,
        effective_max_players: cap,
      },
    ],
  };
}
function response(ids: string[]) {
  return {
    error: null,
    data: {
      ok: true,
      admission_abi: 'legacy-capacity-v1',
      entries: ids.map((id) => ({
        tournament_id: id,
        format_contract: 'mtt-v1',
        effective_max_players: 20,
      })),
    },
  };
}
describe('per-pass admission projection preserves the database contract', () => {
  it('keeps an old MTT cap before activation and removes it only after activation', () => {
    expect(
      readTournamentAdmissionSnapshot(receipt(), [parent]).get(parent.id)?.effective_max_players
    ).toBe(20);
    expect(
      readTournamentAdmissionSnapshot(receipt('unlimited-mtt-v2', null), [parent]).get(parent.id)
        ?.effective_max_players
    ).toBeNull();
  });
  it.each(['sng-v1', 'spin-v1', 'seat-first-satellite-v1'])(
    'preserves %s capacity after activation',
    (format_contract) => {
      const row = { ...parent, format_contract };
      const result = receipt('unlimited-mtt-v2', 2);
      result.entries[0].format_contract = format_contract;
      expect(
        readTournamentAdmissionSnapshot(result, [row]).get(parent.id)?.effective_max_players
      ).toBe(2);
      result.entries[0].effective_max_players = null;
      expect(() => readTournamentAdmissionSnapshot(result, [row])).toThrow();
    }
  );
  it.each([
    'missing',
    'duplicate',
    'foreign',
    'wrong-format',
    'unknown-abi',
    'legacy-null',
    'active-numeric',
  ])('rejects %s evidence', (fault) => {
    const result = receipt();
    if (fault === 'missing') result.entries = [];
    if (fault === 'duplicate') result.entries.push({ ...result.entries[0] });
    if (fault === 'foreign') result.entries[0].tournament_id = 'another-event';
    if (fault === 'wrong-format') result.entries[0].format_contract = 'spin-v1';
    if (fault === 'unknown-abi') result.admission_abi = 'unknown';
    if (fault === 'legacy-null') result.entries[0].effective_max_players = null;
    if (fault === 'active-numeric') result.admission_abi = 'unlimited-mtt-v2';
    expect(() => readTournamentAdmissionSnapshot(result, [parent])).toThrow();
  });
  it('performs bounded complete reads without caching an ABI across passes', async () => {
    rpc.mockReset();
    const rows = Array.from({ length: 101 }, (_, i) => ({ ...parent, id: `event-${i}` }));
    rpc.mockImplementation(async (_name, args) => response(args.p_tournament_ids));
    expect(await projectTournamentAdmission(rows)).toHaveLength(101);
    expect(rpc.mock.calls.map((call) => call[1].p_tournament_ids.length)).toEqual([100, 1]);
    rpc.mockResolvedValue({ error: null, data: receipt('unlimited-mtt-v2', null) });
    expect((await projectTournamentAdmission([parent]))[0].effective_max_players).toBeNull();
  });
  it('does not expose a partial batch if a later read fails', async () => {
    rpc.mockReset();
    rpc.mockImplementationOnce(async (_name, args) => response(args.p_tournament_ids));
    rpc.mockResolvedValueOnce({ error: { message: 'read failed' }, data: null });
    const rows = Array.from({ length: 101 }, (_, i) => ({ ...parent, id: `event-${i}` }));
    await expect(projectTournamentAdmission(rows)).rejects.toThrow('read failed');
  });
});
