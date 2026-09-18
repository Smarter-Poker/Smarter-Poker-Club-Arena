import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import service from '../../src/services/DiamondWheelService';

const fairness = {
  commit_id: '10000000-0000-0000-0000-000000000003',
  server_seed_hash: 'a'.repeat(64),
  server_seed: 'b'.repeat(64),
  client_seed: 'same-request',
  nonce: 1,
  roll: 0,
  weight_total: 4,
  eligible_ords: [1, 2, 3, 4],
  locked: [],
};
const games = ['plinko', 'crash', 'crossing', 'mines'].map((game, i) => ({
  ord: i + 1,
  game,
  kind: 'bonus',
  amount: '200',
  value_chips: '2',
  label: game,
  weight: 1,
  probability: '.25',
  locked: false,
  unlocks_at: null,
  multiplier: '2',
}));
function receipt() {
  return {
    ok: true,
    spin_id: '10000000-0000-0000-0000-000000000005',
    outcome: { ord: 12, kind: 'upgrade', amount: '200', value_chips: '2', label: 'Upgrade' },
    bonus: {
      id: '10000000-0000-0000-0000-000000000006',
      game: 'mines',
      base_diamonds: '200',
      boost_multiplier: '2',
    },
    secondary: { segments: games, outcome: games[3], fairness },
    fairness,
  };
}
beforeEach(() => rpc.mockReset());
const spin = () => service.spin('club', fairness.commit_id, fairness.client_seed);
describe('earned wheel result contracts', () => {
  it('normalizes the saved secondary wheel and awarded game without another request', async () => {
    rpc.mockResolvedValue({ data: receipt(), error: null });
    const result = await spin();
    expect(result.bonus).toMatchObject({ game: 'mines', base_diamonds: 200, boost_multiplier: 2 });
    expect(result.secondary?.outcome).toMatchObject({ game: 'mines', amount: 200, multiplier: 2 });
    expect(rpc).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['missing secondary', (r: any) => delete r.secondary],
    ['missing award', (r: any) => delete r.bonus],
    ['wrong game', (r: any) => (r.bonus.game = 'crash')],
    ['unfunded award', (r: any) => (r.bonus.base_diamonds = 0)],
    ['wrong boost', (r: any) => (r.bonus.boost_multiplier = 1)],
    ['different seed', (r: any) => (r.secondary.fairness = { ...fairness, client_seed: 'other' })],
    [
      'duplicate game',
      (r: any) => (r.secondary.segments = [games[0], games[1], games[2], games[2]]),
    ],
    ['unknown prize', (r: any) => (r.outcome.kind = 'unsupported')],
  ])('retains an uncertain %s instead of showing a fake success', async (_, mutate) => {
    const r = receipt();
    mutate(r);
    rpc.mockResolvedValue({ data: r, error: null });
    await expect(spin()).rejects.toThrow('Could Not Be Confirmed');
  });
  it('keeps a direct bonus bound to exactly its awarded game', async () => {
    const r = {
      ...receipt(),
      outcome: games[3],
      secondary: undefined,
      bonus: { ...receipt().bonus, boost_multiplier: 1 },
    };
    rpc.mockResolvedValue({ data: r, error: null });
    expect((await spin()).outcome.game).toBe('mines');
    rpc.mockResolvedValue({ data: { ...r, bonus: { ...r.bonus, game: 'crash' } }, error: null });
    await expect(spin()).rejects.toThrow();
  });
  it('preserves historical empty receipts without inventing a paying prize', async () => {
    rpc.mockResolvedValue({
      data: {
        ...receipt(),
        outcome: { kind: 'nothing', ord: 1, amount: 0 },
        bonus: undefined,
        secondary: undefined,
      },
      error: null,
    });
    expect((await spin()).outcome.kind).toBe('nothing');
  });
});
