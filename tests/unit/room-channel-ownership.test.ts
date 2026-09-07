import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../src/lib/supabase', () => ({ supabase: {} }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { roomService } from '../../src/services/RoomService';
import type { RealtimeChannel } from '@supabase/supabase-js';
function channel(userId: string) {
  const callbacks = new Map<string, (payload: any) => void>();
  const c = {
    on: vi.fn((kind, filter, callback) => {
      callbacks.set(kind + ':' + filter.event, callback);
      return c;
    }),
    presenceState: () => ({ [userId]: [{ userId, username: userId }] }),
    emit: (kind: string, event: string, payload = {}) =>
      callbacks.get(kind + ':' + event)?.(payload),
    send: vi.fn().mockResolvedValue('ok'),
  };
  return c;
}
const table = 'ownership-test';
afterEach(async () => {
  await roomService.leaveRoom(table);
});
it('rejects every obsolete channel event after a reconnect', () => {
  const old = channel('old'),
    current = channel('current'),
    receive = vi.fn();
  roomService.onMessage(table, receive);
  roomService.registerChannel(table, old as unknown as RealtimeChannel);
  roomService.registerChannel(table, current as unknown as RealtimeChannel);
  current.emit('presence', 'sync');
  receive.mockClear();
  old.emit('broadcast', 'game_event', { payload: { type: 'CHAT' } });
  old.emit('presence', 'sync');
  old.emit('presence', 'join', { key: 'old', newPresences: [] });
  old.emit('presence', 'leave', { key: 'old', leftPresences: [] });
  expect(receive).not.toHaveBeenCalled();
  expect(roomService.getPresence(table).map((p) => p.userId)).toEqual(['current']);
  current.emit('broadcast', 'game_event', { payload: { type: 'CHAT' } });
  expect(receive).toHaveBeenCalledOnce();
});
it('does not repopulate presence or deliver to new handlers after leaving', async () => {
  const old = channel('old');
  roomService.registerChannel(table, old as unknown as RealtimeChannel);
  await roomService.leaveRoom(table);
  const receive = vi.fn();
  roomService.onMessage(table, receive);
  old.emit('presence', 'sync');
  old.emit('broadcast', 'game_event', { payload: { type: 'CHAT' } });
  expect(roomService.getPresence(table)).toEqual([]);
  expect(receive).not.toHaveBeenCalled();
});
it('registering the same channel twice installs one listener set', () => {
  const c = channel('current');
  roomService.registerChannel(table, c as unknown as RealtimeChannel);
  roomService.registerChannel(table, c as unknown as RealtimeChannel);
  expect(c.on).toHaveBeenCalledTimes(4);
});
