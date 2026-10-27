import { beforeEach, expect, it, vi } from 'vitest';
import { F06HandPermit } from './F06HandPermit.js';
import { TournamentTableBreakRpc } from '../tournament/tournamentTableBreakRpc.js';
import {
  currentTournamentDataAuthority,
  dataActorHeaders,
  runWithTournamentDataAuthority,
} from './supabase/dataActorContext.js';
const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('./supabase.js', () => ({
  supabase: {
    rpc: (...args: unknown[]) => {
      const result = rpc(...args);
      // Keep the lazy builder outside Vitest's promise-result observation.
      return typeof result === 'function' ? result() : result;
    },
  },
}));
const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const binding = (n = 0) => ({
  tournament_id: id(n + 1),
  lease_generation: id(n + 2),
  table_id: id(n + 3),
  lifecycle: '9007199254740993',
  permit_id: id(n + 4),
  hand_number: '9007199254740994',
  custody_id: id(n + 5),
});
const authority = (b: ReturnType<typeof binding>) => ({
  tournamentId: b.tournament_id,
  leaseGeneration: b.lease_generation,
});
const receipt = (
  b: ReturnType<typeof binding>,
  state = 'reserved',
  evidence_id: string | null = null
) => ({
  ok: true,
  tournament_id: b.tournament_id,
  generation: b.lease_generation,
  custody_id: b.custody_id,
  permit_id: b.permit_id,
  table_id: b.table_id,
  lifecycle: b.lifecycle,
  hand_number: b.hand_number,
  state,
  evidence_id,
});
function assertManager(b: ReturnType<typeof binding>) {
  const h = dataActorHeaders();
  expect(h.get('x-smarter-data-actor')).toBe('tournament-manager');
  expect(h.get('x-smarter-data-protocol')).toBe('2');
  expect(h.get('x-smarter-tournament-id')).toBe(b.tournament_id);
  expect(h.get('x-smarter-tournament-lease-generation')).toBe(b.lease_generation);
}
beforeEach(() => rpc.mockReset());
it('finishes the exact accepted permit from a process callback under its original Manager', async () => {
  const b = binding();
  const transport = vi.fn(async (name: string) => {
    await Promise.resolve();
    assertManager(b);
    return {
      data: receipt(
        b,
        name === 'fn_f06_finish_hand' ? 'accepted' : 'reserved',
        name === 'fn_f06_finish_hand' ? id(10) : null
      ),
      error: null,
    };
  });
  const p = runWithTournamentDataAuthority(
    authority(b),
    () => new F06HandPermit(b, transport, () => true)
  );
  await runWithTournamentDataAuthority(authority(b), () => p.reserve());
  p.start(() => {});
  expect(currentTournamentDataAuthority()).toBeNull();
  await p.finish('accepted', id(10));
  expect(transport.mock.calls.map((c) => c[0])).toEqual([
    'fn_f06_begin_hand',
    'fn_f06_finish_hand',
  ]);
  expect(currentTournamentDataAuthority()).toBeNull();
  expect(dataActorHeaders().get('x-smarter-data-actor')).toBe('service');
});
it('keeps parallel original permits isolated after their creating scopes returned', async () => {
  const permits = [binding(), binding(20)].map((b) => {
    const p = runWithTournamentDataAuthority(
      authority(b),
      () =>
        new F06HandPermit(
          b,
          async (name) => {
            await Promise.resolve();
            assertManager(b);
            return {
              data: receipt(
                b,
                name === 'fn_f06_finish_hand' ? 'accepted' : 'reserved',
                name === 'fn_f06_finish_hand' ? id(99) : null
              ),
              error: null,
            };
          },
          () => true
        )
    );
    return { b, p };
  });
  await Promise.all(
    permits.map(({ b, p }) => runWithTournamentDataAuthority(authority(b), () => p.reserve()))
  );
  permits.forEach(({ p }) => p.start(() => {}));
  await Promise.all(permits.map(({ p }) => p.finish('accepted', id(99))));
  expect(currentTournamentDataAuthority()).toBeNull();
});
it('refuses to exchange another Manager context for the permit owner', async () => {
  const b = binding();
  const transport = vi.fn(async (name) => ({
    data: receipt(b, name === 'fn_f06_finish_hand' ? 'accepted' : 'reserved', id(10)),
    error: null,
  }));
  const p = new F06HandPermit(b, transport, () => true);
  await runWithTournamentDataAuthority(authority(b), () => p.reserve());
  p.start(() => {});
  await expect(
    runWithTournamentDataAuthority(authority(binding(20)), () => p.finish('accepted', id(10)))
  ).rejects.toThrow('cannot be rebound');
  expect(transport).toHaveBeenCalledTimes(1);
});
it('does not authorize a permit whose original lifecycle is no longer current', async () => {
  const b = binding();
  let current = true;
  const transport = vi.fn(async () => ({ data: receipt(b), error: null }));
  const p = new F06HandPermit(b, transport, () => current);
  await runWithTournamentDataAuthority(authority(b), () => p.reserve());
  p.start(() => {});
  current = false;
  await expect(p.finish('accepted', id(10))).rejects.toThrow('owner_changed');
  expect(transport).toHaveBeenCalledTimes(1);
});
it('materializes lazy break discovery inside the exact stored Manager authority', async () => {
  const b = binding();
  rpc.mockImplementation(() => () => ({
    then: (resolve: (r: unknown) => void) => {
      assertManager(b);
      resolve({
        data: { ok: true, cursor_revision: '0', wrapped: false, operations: [] },
        error: null,
      });
    },
  }));
  const transport = runWithTournamentDataAuthority(
    authority(b),
    () => new TournamentTableBreakRpc(b.tournament_id, b.lease_generation)
  );
  expect(await transport.discover('0', 1)).toEqual({
    ok: true,
    cursor_revision: '0',
    wrapped: false,
    operations: [],
  });
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(currentTournamentDataAuthority()).toBeNull();
});
it('preserves the database refusal and sends no replacement break request', async () => {
  const b = binding();
  rpc.mockResolvedValue({
    data: null,
    error: { code: '42501', message: 'TOURNAMENT_MANAGER_FENCED' },
  });
  const transport = new TournamentTableBreakRpc(b.tournament_id, b.lease_generation);
  await expect(transport.discover('0', 1)).rejects.toThrow('TOURNAMENT_MANAGER_FENCED');
  expect(rpc).toHaveBeenCalledTimes(1);
});
