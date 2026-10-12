import { beforeEach, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../src/lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return {
    supabase: createClient('https://fixture.example.invalid', 'fixture-public-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (...args: Parameters<typeof fetch>) => fixture.fetch(...args) },
    }),
  };
});
import service from '../../src/services/PlayerHistoryService';
const club = '10000000-0000-4000-8000-000000000001';
const id = '20000000-0000-4000-8000-000000000001';
const actor = '30000000-0000-4000-8000-000000000001';
const entry = {
  id,
  club_id: club,
  created_at: '2026-10-12T12:00:00+00:00',
  target_user_id: id,
  actor_id: actor,
  actor_name: null,
  actor_role: 'admin',
  action: 'set_member_role',
  kind: 'roles',
  before: { role: 'player' },
  after: { role: 'agent' },
};
const page = {
  club_id: club,
  scope_club_ids: [club],
  rows: [entry],
  has_more: false,
  next_cursor: null,
};
beforeEach(() => {
  fixture.fetch.mockReset();
});
function answer(v: unknown) {
  fixture.fetch.mockResolvedValue(new Response(JSON.stringify(v), { status: 200 }));
}
it('preserves authoritative identity, role changes and absent alias', async () => {
  answer(page);
  expect(await service.getPlayerHistory(club)).toEqual({
    rows: [
      {
        id,
        clubId: club,
        createdAt: entry.created_at,
        targetUserId: id,
        actorId: actor,
        actorName: null,
        actorRole: 'admin',
        action: 'set_member_role',
        kind: 'roles',
        before: { role: 'player' },
        after: { role: 'agent' },
      },
    ],
    hasMore: false,
    nextCursor: null,
    scopeClubIds: [club],
  });
  expect(JSON.parse(fixture.fetch.mock.calls[0][1].body)).toEqual({
    p_club_id: club,
    p_target_user_id: null,
    p_kind: 'all',
    p_from: null,
    p_to: null,
    p_cursor: null,
    p_limit: 50,
  });
});
it.each([
  null,
  [],
  {},
  { ...page, has_more: 'false' },
  { ...page, rows: [null] },
  { ...page, rows: [{ ...entry, actor_id: '' }] },
  { ...page, rows: [{ ...entry, after: { role: 'agent', credit_limit: 500 } }] },
  { ...page, rows: [{ ...entry, before: { role: false } }] },
  { ...page, rows: [entry, entry] },
  { ...page, has_more: true },
  { ...page, next_cursor: { created_at: entry.created_at, id } },
  { ...page, has_more: true, next_cursor: { created_at: entry.created_at, id } },
  { ...page, rows: [{ ...entry, kind: 'mystery' }] },
  { ...page, rows: [{ ...entry, action: 'unknown' }] },
  { ...page, rows: [{ ...entry, after: {} }] },
  { ...page, rows: [{ ...entry, kind: 'notes', action: 'set_member_role' }] },
  { ...page, rows: [{ ...entry, club_id: actor }] },
  { ...page, club_id: actor },
])('rejects malformed history without fabricating empty success (%#)', async (value) => {
  answer(value);
  await expect(service.getPlayerHistory(club)).rejects.toThrow('Incomplete');
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
});
it('rejects wrong player, kind, order and cursor continuation', async () => {
  answer(page);
  await expect(service.getPlayerHistory(club, { playerId: actor })).rejects.toThrow('Incomplete');
  answer(page);
  await expect(service.getPlayerHistory(club, { kind: 'notes' })).rejects.toThrow('Incomplete');
  answer({ ...page, rows: [entry, { ...entry, id: actor }] });
  await expect(service.getPlayerHistory(club)).rejects.toThrow('Incomplete');
  answer(page);
  await expect(
    service.getPlayerHistory(club, { cursor: { id, createdAt: entry.created_at } })
  ).rejects.toThrow('Incomplete');
});
it('preserves numeric-string note metadata but rejects boolean counts', async () => {
  answer({
    ...page,
    rows: [
      {
        ...entry,
        kind: 'notes',
        action: 'update_member_notes',
        before: {
          nickname_present: false,
          remark_present: false,
          nickname_length: '0',
          remark_length: '0',
        },
        after: {
          nickname_present: true,
          remark_present: false,
          nickname_length: '4',
          remark_length: 0,
        },
      },
    ],
  });
  expect((await service.getPlayerHistory(club)).rows[0].after.nickname_length).toBe(4);
  answer({ ...page, rows: [{ ...entry, after: { nickname_length: true } }] });
  await expect(service.getPlayerHistory(club)).rejects.toThrow('Incomplete');
});
it('returns explicit denial once', async () => {
  fixture.fetch.mockResolvedValue(
    new Response(JSON.stringify({ code: '42501', message: 'History Access Denied' }), {
      status: 403,
    })
  );
  await expect(service.getPlayerHistory(club)).rejects.toMatchObject({ code: '42501' });
  expect(fixture.fetch).toHaveBeenCalledTimes(1);
});
it('keeps sub-millisecond chronological order without false UUID ties', async () => {
  answer({
    ...page,
    rows: [
      { ...entry, id, created_at: '2026-10-12T12:00:00.000002+00:00' },
      { ...entry, id: actor, created_at: '2026-10-12T12:00:00.000001+00:00' },
    ],
  });
  expect((await service.getPlayerHistory(club)).rows).toHaveLength(2);
});
it('exposes validated authorized child scope without duplicate subscriptions', async () => {
  answer({ ...page, scope_club_ids: [club, actor, club] });
  expect((await service.getPlayerHistory(club)).scopeClubIds).toEqual([club, actor]);
  answer({ ...page, scope_club_ids: [club, 'not-a-club'] });
  await expect(service.getPlayerHistory(club)).rejects.toThrow('Incomplete');
});
it.each([
  { dateFrom: '2026-02-30' },
  { dateFrom: '2026-10-13', dateTo: '2026-10-12' },
  { limit: 51 },
  { cursor: { id: 'wrong', createdAt: entry.created_at } },
])('refuses invalid inputs before an RPC (%#)', async (options) => {
  await expect(service.getPlayerHistory(club, options)).rejects.toThrow();
  expect(fixture.fetch).not.toHaveBeenCalled();
});
it('owns one deadline and never replays a stalled read', async () => {
  vi.useFakeTimers();
  try {
    fixture.fetch.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) =>
          (options?.signal ?? _url.signal).addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError'))
          )
        )
    );
    const pending = service.getPlayerHistory(club);
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(8001);
    await assertion;
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
it('propagates external cancellation', async () => {
  fixture.fetch.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) =>
        (options?.signal ?? _url.signal).addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        )
      )
  );
  const controller = new AbortController();
  const pending = service.getPlayerHistory(club, {}, controller.signal);
  const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(fixture.fetch).toHaveBeenCalledTimes(1));
  controller.abort();
  await assertion;
});

it('canonicalizes valid mixed-case route UUIDs before scoped reads', async () => {
  const scopedClub = 'abcdef00-1234-4000-8000-000000000001';
  const player = 'bcdefa00-1234-4000-8000-000000000001';
  answer({
    ...page,
    club_id: scopedClub,
    scope_club_ids: [scopedClub],
    rows: [{ ...entry, club_id: scopedClub, target_user_id: player }],
  });
  const result = await service.getPlayerHistory(scopedClub.toUpperCase(), {
    playerId: player.toUpperCase(),
  });
  expect(result.rows[0].targetUserId).toBe(player);
  expect(JSON.parse(fixture.fetch.mock.calls[0][1].body)).toMatchObject({
    p_club_id: scopedClub,
    p_target_user_id: player,
  });
});
