import { expect, it, vi } from 'vitest';
import { resolveLightningSeatRooms } from '../../src/lightning/lightningSeatRecovery';
import { parseLightningMySession } from '../../src/lightning/lightningSession';
const anchor = '33333333-3333-4333-8333-333333333333';
const cluster = '22222222-2222-4222-8222-222222222222';
const room = '11111111-1111-4111-8111-111111111111';
const open = () =>
  parseLightningMySession({ pool_session_id: room, state: 'active', anchor_table_id: anchor });
it('cold recovery resolves durable anchor ownership into the private room without storage', async () => {
  sessionStorage.clear();
  const result = await resolveLightningSeatRooms(
    [{ id: anchor, cluster_id: cluster, name: 'NLH 1/2' }],
    async () => open()
  );
  expect(result.rows).toEqual([{ id: room, cluster_id: cluster, name: 'NLH 1/2' }]);
  expect(result.rooms).toEqual([{ poolSessionId: room, clusterId: cluster, meta: null }]);
});
it('does not restore another anchor or an ended session as this seat', async () => {
  for (const fields of [{ anchor_table_id: room }, { state: 'closed' }]) {
    const read = async () => ({
      ...open(),
      ...(fields.state ? { state: fields.state } : { anchorTableId: room }),
    });
    expect(
      (await resolveLightningSeatRooms([{ id: anchor, cluster_id: cluster }], read)).rooms
    ).toEqual([]);
  }
});
it('keeps ordinary and tournament recovery independent of Lightning', async () => {
  const read = vi.fn();
  const rows = [{ id: anchor }, { id: room, cluster_id: cluster, tournament_id: 'tournament' }];
  expect((await resolveLightningSeatRooms(rows, read)).rows).toEqual(rows);
  expect(read).not.toHaveBeenCalled();
});
it('failed ownership reads remain unknown instead of mounting an observer', async () => {
  await expect(
    resolveLightningSeatRooms([{ id: anchor, cluster_id: cluster }], async () => {
      throw new Error('offline');
    })
  ).rejects.toThrow('offline');
});

it('an already seated converting tab retains its explicit View Game choice', async () => {
  const read = vi.fn(async () => open());
  const rows = [{ id: anchor, cluster_id: cluster }];
  expect((await resolveLightningSeatRooms(rows, read, new Set([anchor]))).rows).toEqual(rows);
  expect(read).not.toHaveBeenCalled();
});
