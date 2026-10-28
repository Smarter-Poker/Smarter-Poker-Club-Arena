import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TournamentRecurringService } from './TournamentRecurringService.js';
import { supabase } from './supabase.js';

vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => false }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
const NOW = Date.parse('2026-10-28T20:00:00Z');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function harness(over: Record<string, unknown> = {}) {
  const event = {
    format_contract: 'mtt-v2',
    variant: 'freezeout',
    max_players: null,
    status: 'REGISTERING',
    start_time: new Date(NOW + 600001).toISOString(),
    current_players: 0,
    guaranteed_prize: 5000,
    prize_pool: 0,
    buy_in_amount: 36,
    ...over,
  };
  const svc = new TournamentRecurringService() as unknown as {
    registerHorses(id: string, count: number): Promise<number>;
    horseLoadMap(): Promise<Map<string, number> | null>;
  };
  const load = vi.spyOn(svc, 'horseLoadMap').mockResolvedValue(null);
  vi.spyOn(supabase, 'from').mockImplementation(() => {
    const builder: Record<string, unknown> = {};
    for (const key of ['select', 'eq']) builder[key] = () => builder;
    builder.maybeSingle = async () => ({ data: event, error: null });
    return builder as never;
  });
  const rpc = vi.spyOn(supabase, 'rpc');
  return { event, svc, load, rpc };
}

describe('every automated MTT caller shares the T-10 purchase choice', () => {
  it.each(['REGISTERING', 'ANNOUNCED'])(
    'rejects %s one millisecond early before picking or charging a horse',
    async (status) => {
      const h = harness({ status });
      expect(await h.svc.registerHorses('event', 139)).toBe(0);
      expect(h.load).not.toHaveBeenCalled();
      expect(h.rpc).not.toHaveBeenCalled();
    }
  );
  it.each(['mtt-v1', 'mtt-v2'])('opens at exactly T-10 for %s', async (format_contract) => {
    const h = harness({ format_contract, start_time: new Date(NOW + 600000).toISOString() });
    await h.svc.registerHorses('event', 139);
    expect(h.load).toHaveBeenCalledOnce();
  });
  it('fails closed on an unreadable scheduled clock', async () => {
    const h = harness({ start_time: null });
    await h.svc.registerHorses('event', 139);
    expect(h.load).not.toHaveBeenCalled();
  });
  it('does not top up an already ahead-of-curve field', async () => {
    const h = harness({ start_time: new Date(NOW + 300000).toISOString(), current_players: 139 });
    await h.svc.registerHorses('event', 40);
    expect(h.load).not.toHaveBeenCalled();
  });
  it('leaves running late registration on its existing admission path', async () => {
    const h = harness({ status: 'RUNNING', start_time: new Date(NOW - 600000).toISOString() });
    await h.svc.registerHorses('event', 4);
    expect(h.load).toHaveBeenCalledOnce();
  });
  it('leaves bought-seat games on their existing admission path', async () => {
    const h = harness({ format_contract: 'sng-v1', max_players: 6 });
    await h.svc.registerHorses('event', 4);
    expect(h.load).toHaveBeenCalledOnce();
  });
});
