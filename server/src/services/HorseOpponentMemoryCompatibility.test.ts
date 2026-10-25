import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveHorseDecisionSnapshot } from '../engine/horseDecision/protocol.js';
import { freshExploitCounters } from '../engine/HorseOpponentExploit.js';
import { createClient } from '@supabase/supabase-js';
const h = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), fire: vi.fn() }));
vi.mock('./supabase.js', () => ({ supabase: h }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
vi.mock('../engine/BrainTelemetry.js', () => ({ noteFire: h.fire }));
const uid = '94000000-0000-4000-8000-000000000001';
const request = (variant: string, hand = 1) =>
  ({
    fence: `table:${hand}:1:lease:turn`,
    gameState: { gameVariant: variant, players: [{ user_id: uid }], dealtSeatIds: [1, 2, 3] },
  }) as unknown as LiveHorseDecisionSnapshot;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(1_800_000_000_000);
  h.rpc.mockReset();
  h.fire.mockReset();
});
afterEach(() => vi.useRealTimers());
describe('the five-variant schema does not poison the stable games while the extension waits', () => {
  it.each(['AbortError', 'TimeoutError'])(
    'preserves the sanitized timeout class of a real SDK returned %s and retains cooldown',
    async (name) => {
      const { readHorseOpponentProfiles, opponentMemoryFailureFeature } =
        await import('./HorseOpponentMemory.js');
      const privateMessage = 'private-original-query-and-actor-do-not-copy';
      const fetch = vi.fn(async () => {
        throw new DOMException(privateMessage, name);
      });
      const sdk = createClient('https://offline.invalid', 'offline-test-key', {
        global: { fetch },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const returned = await sdk.rpc('fn_horse_exploit_profiles_read', {});
      expect(returned.error?.code).toBe('');
      expect(returned.error?.message).toBe(`${name}: ${privateMessage}`);
      h.rpc.mockImplementation((rpcName, args) => sdk.rpc(rpcName, args));
      const error = await readHorseOpponentProfiles([uid], 'nlh', 'cash', 'short').catch((e) => e);
      expect(opponentMemoryFailureFeature(error)).toBe('horse_opponent_memory_read_timeout');
      expect(error).toMatchObject({ name, code: '' });
      expect(String(error)).not.toContain(privateMessage);
      expect(JSON.stringify(error)).not.toContain(privateMessage);
      const calls = fetch.mock.calls.length;
      await expect(readHorseOpponentProfiles([uid], 'plo5', 'cash', 'short')).rejects.toThrow(
        'busy'
      );
      expect(fetch).toHaveBeenCalledTimes(calls);
      vi.advanceTimersByTime(1500);
      h.rpc.mockReturnValue({ abortSignal: async () => ({ data: [], error: null }) });
      expect(await readHorseOpponentProfiles([uid], 'plo5', 'cash', 'short')).toEqual([]);
    }
  );

  it.each(['AbortError', 'TimeoutError'])(
    'keeps thrown %s classified as timeout with the existing shared cooldown',
    async (name) => {
      const { readHorseOpponentProfiles, opponentMemoryFailureFeature } =
        await import('./HorseOpponentMemory.js');
      h.rpc.mockReturnValue({
        abortSignal: async () => {
          throw new DOMException('interrupted', name);
        },
      });
      const error = await readHorseOpponentProfiles([uid], 'nlh', 'cash', 'short').catch((e) => e);
      expect(opponentMemoryFailureFeature(error)).toBe('horse_opponent_memory_read_timeout');
      await expect(readHorseOpponentProfiles([uid], 'plo5', 'cash', 'short')).rejects.toThrow(
        'busy'
      );
      expect(h.rpc).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1500);
      h.rpc.mockReturnValue({ abortSignal: async () => ({ data: [], error: null }) });
      await readHorseOpponentProfiles([uid], 'plo5', 'cash', 'short');
      expect(h.rpc).toHaveBeenCalledTimes(2);
    }
  );

  it.each([
    { code: '', message: 'TypeError: socket closed', name: 'TypeError' },
    { code: '', message: 'request mentioned AbortError: but was not one' },
    { code: '42501', message: 'TimeoutError: this is a SQL refusal', name: 'TimeoutError' },
  ])('does not promote unrelated returned errors into a timeout: %j', async (returned) => {
    const { readHorseOpponentProfiles, opponentMemoryFailureFeature } =
      await import('./HorseOpponentMemory.js');
    h.rpc.mockReturnValue({
      abortSignal: async () => ({
        data: null,
        error: { ...returned, details: 'private-details', hint: 'private-hint' },
      }),
    });
    const error = await readHorseOpponentProfiles([uid], 'nlh', 'cash', 'short').catch((e) => e);
    expect(opponentMemoryFailureFeature(error)).toBe('horse_opponent_memory_read_failed');
    expect(error.code).toBe(returned.code);
    expect(error.name).toBe('Error');
    expect(error.message).not.toContain(returned.message);
    expect(JSON.stringify(error)).not.toMatch(/private-details|private-hint/);
    await expect(readHorseOpponentProfiles([uid], 'plo5', 'cash', 'short')).rejects.toThrow('busy');
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
  it('contains an unsupported new variant instead of putting the next stable request into global cooldown', async () => {
    const { createDecisionOpponentProfileReader } = await import('./HorseOpponentMemory.js');
    h.rpc.mockImplementation((_name, args) => ({
      abortSignal: async () =>
        args.p_variant === 'flh'
          ? { data: null, error: { code: '22023', message: 'invalid opponent memory boundary' } }
          : { data: [], error: null },
    }));
    const read = createDecisionOpponentProfileReader(async () => 'installed');
    expect(await read(request('flh'))).toEqual([]);
    expect(await read(request('nlh'))).toEqual([]);
    expect(h.rpc.mock.calls.map(([, args]) => args.p_variant)).toEqual(['flh', 'nlh']);
  });

  it('keeps all five previously installed variants active immediately after the new-schema refusal', async () => {
    const { readHorseOpponentProfiles } = await import('./HorseOpponentMemory.js');
    h.rpc.mockImplementation((_name, args) => ({
      abortSignal: async () =>
        args.p_variant === 'short_deck'
          ? { data: null, error: { code: '22023' } }
          : { data: [], error: null },
    }));
    await expect(
      readHorseOpponentProfiles([uid], 'short_deck', 'cash', 'short')
    ).rejects.toMatchObject({ code: '22023' });
    for (const variant of ['nlh', 'plo4', 'plo5', 'plo6', 'plo8'])
      expect(await readHorseOpponentProfiles([uid], variant, 'cash', 'short')).toEqual([]);
    expect(h.rpc.mock.calls.map(([, args]) => args.p_variant)).toEqual([
      'short_deck',
      'nlh',
      'plo4',
      'plo5',
      'plo6',
      'plo8',
    ]);
  });

  it.each(['flh', 'flo8', 'short_deck'])(
    'bounds unsupported %s retries and invalidates the failed original hand at expiry',
    async (variant) => {
      const { createDecisionOpponentProfileReader } = await import('./HorseOpponentMemory.js');
      let installed = false;
      h.rpc.mockImplementation(() => ({
        abortSignal: async () =>
          installed ? { data: [], error: null } : { data: null, error: { code: '22023' } },
      }));
      const read = createDecisionOpponentProfileReader(async () => 'installed');
      expect(await read(request(variant))).toEqual([]);
      expect(h.rpc).toHaveBeenCalledTimes(1);
      installed = true;
      vi.advanceTimersByTime(59_999);
      expect(await read(request(variant))).toEqual([]);
      expect(await read(request(variant, 2))).toEqual([]);
      expect(h.rpc).toHaveBeenCalledTimes(1);
      expect(h.fire).not.toHaveBeenCalledWith('horse_opponent_memory_read_ok');
      expect(h.fire).toHaveBeenCalledWith('horse_opponent_memory_read_incomplete');
      vi.advanceTimersByTime(1);
      // The same original hand must not retain the old negative promise forever.
      expect(await read(request(variant))).toEqual([]);
      expect(h.rpc).toHaveBeenCalledTimes(2);
      expect(h.fire).toHaveBeenCalledWith('horse_opponent_memory_read_ok');
      expect(await read(request(variant))).toEqual([]);
      expect(h.rpc).toHaveBeenCalledTimes(2);
    }
  );

  it('keeps an unavailable cached profile and the independent saved donor without blocking stable reads', async () => {
    const { readHorseOpponentProfiles, createDecisionOpponentProfilePacketReader } =
      await import('./HorseOpponentMemory.js');
    const row = {
      user_id: uid,
      variant: 'flh',
      mode: 'cash',
      size: 'short',
      observed_hands: 8,
      initialized: true,
      counters: freshExploitCounters(),
    };
    const donor = { ...row, size: 'full' };
    h.rpc.mockReturnValueOnce({ abortSignal: async () => ({ data: [row], error: null }) });
    await readHorseOpponentProfiles([uid], 'flh', 'cash', 'short');
    h.fire.mockClear();
    h.rpc.mockReturnValueOnce({
      abortSignal: async () => ({ data: null, error: { code: '22023' } }),
    });
    const query: any = {
      select: () => query,
      in: () => query,
      eq: () => query,
      limit: () => query,
      abortSignal: vi.fn(async () => ({ data: [donor], error: null })),
    };
    h.from.mockReturnValue(query);
    const read = createDecisionOpponentProfilePacketReader(async () => 'installed');
    expect(await read(request('flh'))).toEqual({ profiles: [row], donorProfiles: [donor] });
    expect(h.fire).toHaveBeenCalledWith('horse_opponent_memory_read_cache_fallback');
    expect(h.fire).not.toHaveBeenCalledWith('horse_opponent_memory_read_ok');
    expect(query.abortSignal).toHaveBeenCalledTimes(1);
    await read(request('flh'));
    expect(query.abortSignal).toHaveBeenCalledTimes(1);
    expect(h.rpc).toHaveBeenCalledTimes(2);
    h.rpc.mockReturnValue({ abortSignal: async () => ({ data: [], error: null }) });
    await readHorseOpponentProfiles([uid], 'nlh', 'cash', 'short');
    expect(h.rpc).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(60_000);
    await read(request('flh'));
    // Both original exact and donor promises are retired by the capability epoch.
    expect(query.abortSignal).toHaveBeenCalledTimes(2);
    expect(h.rpc).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['nlh', '22023'],
    ['flh', '57014'],
    ['flh', '42501'],
    ['flh', 'PGRST202'],
  ])('keeps normal shared cooldown and SQLSTATE for %s error %s', async (variant, code) => {
    const { readHorseOpponentProfiles } = await import('./HorseOpponentMemory.js');
    h.rpc.mockReturnValue({ abortSignal: async () => ({ data: null, error: { code } }) });
    await expect(readHorseOpponentProfiles([uid], variant, 'cash', 'short')).rejects.toMatchObject({
      code,
    });
    await expect(readHorseOpponentProfiles([uid], 'plo5', 'cash', 'short')).rejects.toThrow('busy');
    expect(h.rpc).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1500);
    h.rpc.mockReturnValue({ abortSignal: async () => ({ data: [], error: null }) });
    await readHorseOpponentProfiles([uid], 'plo5', 'cash', 'short');
    expect(h.rpc).toHaveBeenCalledTimes(2);
  });

  it('a still-old schema can retry only once in the next bounded interval, without a background query', async () => {
    const { readHorseOpponentProfiles } = await import('./HorseOpponentMemory.js');
    h.rpc.mockReturnValue({ abortSignal: async () => ({ data: null, error: { code: '22023' } }) });
    await expect(readHorseOpponentProfiles([uid], 'flo8', 'cash', 'hu')).rejects.toMatchObject({
      code: '22023',
    });
    vi.advanceTimersByTime(60_000);
    expect(h.rpc).toHaveBeenCalledTimes(1);
    await expect(readHorseOpponentProfiles([uid], 'flo8', 'cash', 'hu')).rejects.toMatchObject({
      code: '22023',
    });
    await expect(readHorseOpponentProfiles([uid], 'flo8', 'cash', 'hu')).rejects.toMatchObject({
      code: '22023',
    });
    expect(h.rpc).toHaveBeenCalledTimes(2);
  });
});
