import { beforeEach, describe, expect, it, vi } from 'vitest';
const channel = vi.hoisted(() => ({
  send: vi.fn(),
  events: {
    club: new Set<(m: Record<string, unknown>) => void>(),
    tournament: new Set<(m: Record<string, unknown>) => void>(),
    lobby: new Set<(m: Record<string, unknown>) => void>(),
  },
}));
vi.mock('../../src/services/EngineStateClient', () => ({
  engineChannelClient: {
    send: channel.send,
    onClubPresence: () => () => {},
    onClubEvent: (fn: (m: Record<string, unknown>) => void) => {
      channel.events.club.add(fn);
      return () => channel.events.club.delete(fn);
    },
    onTournamentEvent: (fn: (m: Record<string, unknown>) => void) => {
      channel.events.tournament.add(fn);
      return () => channel.events.tournament.delete(fn);
    },
    onLobbyUpdate: (fn: (m: Record<string, unknown>) => void) => {
      channel.events.lobby.add(fn);
      return () => channel.events.lobby.delete(fn);
    },
  },
}));
import { RealtimeChannelService } from '../../src/services/RealtimeChannelService';
type Kind = 'club' | 'tournament' | 'lobby';
function subscribe(s: RealtimeChannelService, kind: Kind, callback: () => void) {
  if (kind === 'club') return s.subscribeToClub('c1', 'u1', {} as never, { onEvent: callback });
  if (kind === 'tournament') return s.subscribeToTournament('t1', { onEvent: callback });
  return s.subscribeToLobby({ onClubActivity: callback });
}
function emit(kind: Kind) {
  const message = {
    clubId: 'c1',
    tournamentId: 't1',
    event: { type: 'level_up' },
    kind: 'club_activity',
    payload: { clubId: 'c1', playersOnline: 2 },
  };
  for (const fn of channel.events[kind]) fn(message);
}
beforeEach(() => {
  channel.send.mockClear();
  Object.values(channel.events).forEach((s) => s.clear());
});
describe('shared channel consumers', () => {
  it.each<Kind>(['club', 'tournament', 'lobby'])(
    '%s delivers once per consumer and leaves only after the last release',
    (kind) => {
      const service = new RealtimeChannelService(),
        first = vi.fn(),
        second = vi.fn();
      const releaseFirst = subscribe(service, kind, first),
        releaseSecond = subscribe(service, kind, second);
      expect(channel.send).toHaveBeenCalledTimes(1);
      emit(kind);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(1);
      releaseFirst();
      releaseFirst();
      emit(kind);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).toHaveBeenCalledTimes(2);
      expect(channel.send).toHaveBeenCalledTimes(1);
      releaseSecond();
      releaseSecond();
      expect(channel.send).toHaveBeenCalledTimes(2);
      expect(channel.send.mock.calls[1][0].type).toMatch(/^LEAVE_/);
      expect(channel.events[kind].size).toBe(0);
    }
  );
  it('ignores stale cleanup after a subscription was explicitly replaced', async () => {
    const service = new RealtimeChannelService();
    const oldRelease = subscribe(service, 'club', vi.fn());
    await service.unsubscribeFromClub('c1');
    const current = vi.fn(),
      release = subscribe(service, 'club', current);
    channel.send.mockClear();
    oldRelease();
    emit('club');
    expect(current).toHaveBeenCalledOnce();
    expect(channel.send).not.toHaveBeenCalled();
    release();
  });
});
