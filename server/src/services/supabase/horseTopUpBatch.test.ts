import { beforeEach, describe, expect, it, vi } from 'vitest';
const wire = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./client.js', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return {
    supabase: createClient('https://topup.invalid', 'test-only', {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: wire.fetch },
    }),
  };
});
vi.mock('../errorReporter.js', () => ({ reportError: vi.fn() }));
import * as wallets from './wallets.js';

describe('a whole table shares bounded reads and exact seat choices', () => {
  let seats: any[];
  let requests: Array<{ url: URL; method: string; body: any }>;
  let failure: string | null;
  let incompleteWrite: boolean;
  beforeEach(() => {
    failure = null;
    incompleteWrite = false;
    requests = [];
    seats = Array.from({ length: 10 }, (_, i) => ({
      id: `seat-${i}`,
      user_id: `horse-${i}`,
      club_id: i % 2 ? 'club-a' : 'club-b',
      auto_rebuy: i < 3,
      is_sitting_out: false,
      stack: 100,
      leave_pending: false,
    }));
    wire.fetch.mockImplementation(async (input: any, init: any = {}) => {
      const url = new URL(String(input));
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(init.body) : null;
      requests.push({ url, method, body });
      if (failure && url.pathname.endsWith(failure))
        return new Response(JSON.stringify({ message: 'unavailable' }), { status: 503 });
      let data: any[] = [];
      if (url.pathname.endsWith('table_seats')) {
        if (method === 'GET') data = seats;
        else {
          const ids = String(url.searchParams.get('id')).slice(4, -1).split(',');
          data = seats.filter((s) => ids.includes(s.id));
          if (incompleteWrite) data = [];
          for (const s of data) s.auto_rebuy = body.auto_rebuy;
          data = data.map((s) => ({ id: s.id }));
        }
      } else if (url.pathname.endsWith('cash_player_session')) {
        data = seats.map((s) => ({ player_id: s.user_id, baseline: 100 }));
      } else if (url.pathname.endsWith('club_members')) {
        data = seats.map((s) => ({ user_id: s.user_id, club_id: s.club_id, chip_balance: 10000 }));
        // A second club wallet for the SAME horse must never be substituted.
        data.unshift({ user_id: 'horse-0', club_id: 'club-a', chip_balance: 0 });
      }
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  });
  it('reads ten horses in three requests, retaining the seat funding club', async () => {
    const batch = await wallets.readHorseTopUpBatch('table', () => true, 200);
    expect(batch?.size).toBe(10);
    expect(batch?.get('horse-0')).toMatchObject({
      wallet: 10000,
      invested: 100,
      clubId: 'club-b',
      autoTopUp: true,
    });
    expect(requests).toHaveLength(3);
    expect(requests[0].url.searchParams.get('profile.is_horse')).toBe('eq.true');
    expect(requests[0].url.searchParams.get('left_at')).toBe('is.null');
  });
  it('persists only the minimum flag changes at the original hand boundary', async () => {
    seats.forEach((s) => (s.auto_rebuy = false));
    const batch = await wallets.readHorseTopUpBatch('table', () => true, 200);
    expect([...batch!.values()].filter((s) => s.autoTopUp)).toHaveLength(3);
    const writes = requests.filter((r) => r.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(writes[0].url.searchParams.get('table_id')).toBe('eq.table');
    expect(writes[0].url.searchParams.get('left_at')).toBe('is.null');
    expect(seats.filter((s) => s.auto_rebuy)).toHaveLength(3);
  });
  it('does not invent a context when any shared read fails', async () => {
    failure = 'cash_player_session';
    expect(await wallets.readHorseTopUpBatch('table', () => true, 200)).toBeNull();
  });
  it('declines the whole boundary after a partial or unknown flag write', async () => {
    seats.forEach((s) => (s.auto_rebuy = false));
    incompleteWrite = true;
    expect(await wallets.readHorseTopUpBatch('table', () => true, 200)).toBeNull();
    expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
  });
  it('never writes after lifecycle ownership is lost', async () => {
    seats.forEach((s) => (s.auto_rebuy = false));
    expect(await wallets.readHorseTopUpBatch('table', () => false, 200)).toBeNull();
    expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(0);
  });
  it('fails closed on a missing wallet or missing session rather than borrowing another club', async () => {
    const fetch = wire.fetch.getMockImplementation()!;
    wire.fetch.mockImplementation(async (input: any, init: any) => {
      if (String(input).includes('club_members') || String(input).includes('cash_player_session'))
        return new Response('[]', { headers: { 'content-type': 'application/json' } });
      return fetch(input, init);
    });
    const batch = await wallets.readHorseTopUpBatch('table', () => true, 200);
    expect(batch?.get('horse-0')).toMatchObject({ wallet: undefined, invested: undefined });
  });
  it('does not read wallets or sessions when every Auto Top Up stack is already full', async () => {
    seats.forEach((s) => (s.stack = 200));
    const batch = await wallets.readHorseTopUpBatch('table', () => true, 200);
    expect(batch?.size).toBe(10);
    expect(requests).toHaveLength(1);
  });
});
