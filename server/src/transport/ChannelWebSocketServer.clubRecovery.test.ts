import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readMember = vi.hoisted(() => vi.fn());
vi.mock('../services/supabase.js', () => ({
  supabase: {
    auth: { getUser: vi.fn() },
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: readMember }) }) }) }),
  },
  default: {},
}));
import { ChannelWebSocketServer } from './ChannelWebSocketServer.js';
import { channelHub } from '../hub/ChannelHub.js';

class FakeWs {
  readyState = 1;
  sent: any[] = [];
  handlers = new Map<string, (arg?: unknown) => void>();
  on(event: string, callback: (arg?: unknown) => void) {
    this.handlers.set(event, callback);
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 3;
    this.handlers.get('close')?.();
  }
  receive(frame: unknown) {
    this.handlers.get('message')?.(Buffer.from(JSON.stringify(frame)));
  }
}
let server: ChannelWebSocketServer;
let sockets: FakeWs[];
let serial = 0;
let user: string;
function socket(id = user) {
  const ws = new FakeWs();
  sockets.push(ws);
  (server as any).onUpgraded(ws, id);
  return ws;
}
function deferred() {
  let resolve!: (value: { data: unknown; error: unknown }) => void;
  const promise = new Promise<{ data: unknown; error: unknown }>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const club = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const pendingClub = (i: number) => 'cccccccc-cccc-4ccc-8ccc-' + i.toString(16).padStart(12, '0');
const join = { type: 'JOIN_CLUB', clubId: club };
const leave = { type: 'LEAVE_CLUB', clubId: club };
const member = { data: { user_id: 'member' }, error: null };
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  readMember.mockReset().mockResolvedValue(member);
  server = new ChannelWebSocketServer();
  sockets = [];
  user = 'club-recovery-' + ++serial;
});
afterEach(() => {
  for (const ws of sockets) ws.close();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('club subscriptions survive temporary reads without reviving retired intent', () => {
  it('retries a temporary membership error without another client JOIN', async () => {
    readMember.mockResolvedValueOnce({ data: null, error: { code: 'PGRST003' } });
    const ws = socket();
    ws.receive(join);
    await flush();
    expect(channelHub.isInClub(user, club)).toBe(false);
    await vi.advanceTimersByTimeAsync(2500);
    expect(channelHub.isInClub(user, club)).toBe(true);
    expect(readMember).toHaveBeenCalledTimes(2);
  });
  it('retries a rejected read but never grants unknown membership', async () => {
    readMember.mockRejectedValueOnce(new Error('transport unavailable'));
    socket().receive(join);
    await flush();
    expect(channelHub.isInClub(user, club)).toBe(false);
    await vi.advanceTimersByTimeAsync(2500);
    expect(channelHub.isInClub(user, club)).toBe(true);
  });
  it('does not retry an explicit nonmember verdict', async () => {
    readMember.mockResolvedValue({ data: null, error: null });
    socket().receive(join);
    await flush();
    await vi.advanceTimersByTimeAsync(120000);
    expect(readMember).toHaveBeenCalledOnce();
    expect(channelHub.isInClub(user, club)).toBe(false);
  });
  it('coalesces repeated JOIN frames during the same read', async () => {
    const read = deferred();
    readMember.mockReturnValue(read.promise);
    const ws = socket();
    ws.receive(join);
    ws.receive(join);
    ws.receive(join);
    expect(readMember).toHaveBeenCalledOnce();
    read.resolve(member);
    await flush();
    expect(channelHub.isInClub(user, club)).toBe(true);
  });
  it('a late membership response cannot undo LEAVE', async () => {
    const read = deferred();
    readMember.mockReturnValue(read.promise);
    const ws = socket();
    ws.receive(join);
    ws.receive(leave);
    read.resolve(member);
    await flush();
    expect(channelHub.isInClub(user, club)).toBe(false);
  });
  it('a closed socket cannot subscribe the replacement socket', async () => {
    const read = deferred();
    readMember.mockReturnValue(read.promise);
    const ws = socket();
    ws.receive(join);
    ws.close();
    socket();
    read.resolve(member);
    await flush();
    expect(channelHub.isInClub(user, club)).toBe(false);
  });
  it.each(['leave', 'close'])('cancels pending retries on %s', async (action) => {
    readMember.mockResolvedValue({ data: null, error: { code: 'PGRST003' } });
    const ws = socket();
    ws.receive(join);
    await flush();
    if (action === 'leave') ws.receive(leave);
    else ws.close();
    await vi.advanceTimersByTimeAsync(120000);
    expect(readMember).toHaveBeenCalledOnce();
  });
  it('retains only the latest presence while membership is pending', async () => {
    const read = deferred();
    readMember.mockReturnValue(read.promise);
    const presence = vi.spyOn(channelHub, 'updatePresence');
    const ws = socket();
    ws.receive(join);
    ws.receive({ type: 'UPDATE_PRESENCE', clubId: club, status: 'online' });
    ws.receive({
      type: 'UPDATE_PRESENCE',
      clubId: club,
      status: 'at_table',
      currentTableId: 'table-a',
    });
    expect(presence).not.toHaveBeenCalled();
    read.resolve(member);
    await flush();
    expect(presence).toHaveBeenCalledOnce();
    expect(presence).toHaveBeenCalledWith(user, club, 'at_table', 'table-a');
  });
  it('does not publish queued presence for a nonmember', async () => {
    const read = deferred();
    readMember.mockReturnValue(read.promise);
    const presence = vi.spyOn(channelHub, 'updatePresence');
    const ws = socket();
    ws.receive(join);
    ws.receive({ type: 'UPDATE_PRESENCE', clubId: club, status: 'at_table' });
    read.resolve({ data: null, error: null });
    await flush();
    expect(presence).not.toHaveBeenCalled();
    expect(channelHub.isInClub(user, club)).toBe(false);
  });

  it('backs off repeated read failures and coalesces reasserts without renewing that deadline', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    readMember.mockResolvedValue({ data: null, error: { code: 'PGRST003' } });
    const ws = socket();
    ws.receive(join);
    await flush();
    await vi.advanceTimersByTimeAsync(900);
    ws.receive(join);
    ws.receive(join);
    expect(readMember).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(readMember).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(119000);
    expect(readMember).toHaveBeenCalledTimes(8);
    expect(channelHub.isInClub(user, club)).toBe(false);
  });

  it('revokes an existing feed after a fresh read confirms membership was removed', async () => {
    const ws = socket();
    ws.receive(join);
    await flush();
    expect(channelHub.isInClub(user, club)).toBe(true);
    await vi.advanceTimersByTimeAsync(60001);
    readMember.mockResolvedValue({ data: null, error: null });
    ws.receive(join);
    await flush();
    expect(readMember).toHaveBeenCalledTimes(2);
    expect(channelHub.isInClub(user, club)).toBe(false);
    await vi.advanceTimersByTimeAsync(60000);
    expect(readMember).toHaveBeenCalledTimes(2);
  });

  it('a cancelled generation cannot overwrite the replacement membership verdict', async () => {
    const oldRead = deferred();
    readMember.mockReturnValueOnce(oldRead.promise);
    const ws = socket();
    ws.receive(join);
    ws.receive(leave);
    ws.receive(join);
    await flush();
    expect(channelHub.isInClub(user, club)).toBe(true);
    oldRead.resolve({ data: null, error: null });
    await flush();
    ws.receive(join);
    await flush();
    expect(channelHub.isInClub(user, club)).toBe(true);
    expect(readMember).toHaveBeenCalledTimes(2);
  });

  it('bounds unresolved club intents and releases their capacity on Leave', async () => {
    readMember.mockReturnValue(new Promise(() => {}));
    const ws = socket();
    for (let i = 0; i < 65; i++) {
      vi.setSystemTime(Date.now() + 1001);
      ws.receive({ type: 'JOIN_CLUB', clubId: pendingClub(i) });
    }
    expect(readMember).toHaveBeenCalledTimes(64);
    expect(ws.sent).toContainEqual(
      expect.objectContaining({ type: 'CHANNEL_ERROR', code: 'CLUB_JOIN_LIMIT' })
    );
    ws.receive({ type: 'LEAVE_CLUB', clubId: pendingClub(0) });
    ws.receive({ type: 'JOIN_CLUB', clubId: pendingClub(64) });
    expect(readMember).toHaveBeenCalledTimes(65);
  });

  it('rejects malformed club IDs without starting reads or retries', async () => {
    const ws = socket();
    ws.receive({ type: 'JOIN_CLUB', clubId: 'not-a-uuid' });
    await vi.advanceTimersByTimeAsync(120000);
    expect(readMember).not.toHaveBeenCalled();
    expect(ws.sent).toContainEqual(
      expect.objectContaining({ type: 'CHANNEL_ERROR', code: 'INVALID_CLUB_ID' })
    );
  });
});

describe('tournament presentation on the authenticated channel', () => {
  const tournamentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const joinTournament = { type: 'JOIN_TOURNAMENT', tournamentId };
  it('reads after subscribing and returns the current snapshot on every reconnect', () => {
    let active: boolean | null = true;
    const observe = vi.fn((id: string) => {
      expect(id).toBe(tournamentId);
      expect(channelHub.tournamentSubscriberCount(id)).toBe(1);
      return active;
    });
    server = new ChannelWebSocketServer(observe);
    const first = socket();
    first.receive(joinTournament);
    expect(first.sent.at(-1)).toMatchObject({
      type: 'TOURNAMENT_EVENT',
      tournamentId,
      event: { type: 'tournament_presentation', payload: { handForHand: true } },
    });
    first.close();
    active = false;
    const replacement = socket();
    replacement.receive(joinTournament);
    expect(replacement.sent.at(-1).event.payload).toEqual({ handForHand: false });
    active = null;
    replacement.receive(joinTournament);
    expect(replacement.sent.at(-1).event.payload).toEqual({ handForHand: null });
    expect(observe).toHaveBeenCalledTimes(3);
  });
});
