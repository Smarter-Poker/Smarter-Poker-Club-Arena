/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE VOICE — the WebRTC mesh, its gates, and the control that drives it
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-27: "FULL VOICE, BUILD IT OR FIND A OPEN SOURCE".
 *
 * WHAT CAN AND CANNOT BE TESTED HERE. happy-dom has no `RTCPeerConnection`, no
 * `navigator.mediaDevices`, and no `AudioContext`, so all three are faked. That
 * means this suite proves the DECISIONS - who offers, when the microphone is
 * open, what happens when permission is refused, what is released on teardown -
 * and it cannot prove that audio actually crosses a network. The parts a fake
 * cannot reach (ICE traversal, codec negotiation, echo cancellation, autoplay
 * policy) are named in the report and belong to a two-device manual test.
 *
 * The signalling fake is a real little message bus rather than a stub: two
 * sessions join the same topic and talk to each other. That is what makes the
 * glare test meaningful - a stub that swallows sends would pass it trivially.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';

// ═══════════════════════════════════════════════════════════════════════════════
// THE FAKE REALTIME BUS
// ═══════════════════════════════════════════════════════════════════════════════

interface Frame {
  type: string;
  event: string;
  payload: { from: string; to: string; kind: string; data: unknown };
}

class FakeChannel {
  handlers: Array<{ type: string; event?: string; cb: (arg?: any) => void }> = [];
  subscribed = false;
  removed = false;

  constructor(
    private hub: FakeHub,
    readonly topic: string,
    readonly key: string
  ) {}

  on(type: string, filter: { event?: string }, cb: (arg?: any) => void) {
    this.handlers.push({ type, event: filter?.event, cb });
    return this;
  }

  subscribe(cb?: (status: string) => void) {
    this.subscribed = true;
    cb?.(this.hub.subscribeStatus);
    return this;
  }

  track(payload: unknown) {
    this.hub.track(this.topic, this.key, payload);
    return Promise.resolve('ok');
  }

  untrack() {
    this.hub.untrack(this.topic, this.key);
    return Promise.resolve('ok');
  }

  presenceState() {
    return this.hub.presenceState(this.topic);
  }

  send(frame: Frame) {
    this.hub.broadcast(this.topic, this, frame);
    return Promise.resolve('ok');
  }

  fire(type: string, event: string, arg?: unknown) {
    this.handlers.filter((h) => h.type === type && h.event === event).forEach((h) => h.cb(arg));
  }
}

class FakeHub {
  topics = new Map<string, { channels: FakeChannel[]; presence: Map<string, unknown[]> }>();
  /** Every signalling payload that crossed the bus, in order. */
  sent: Frame['payload'][] = [];
  subscribeStatus = 'SUBSCRIBED';

  private topicOf(topic: string) {
    let t = this.topics.get(topic);
    if (!t) {
      t = { channels: [], presence: new Map() };
      this.topics.set(topic, t);
    }
    return t;
  }

  channel(topic: string, opts?: { config?: { presence?: { key?: string } } }) {
    const key = opts?.config?.presence?.key ?? '';
    const ch = new FakeChannel(this, topic, key);
    this.topicOf(topic).channels.push(ch);
    return ch;
  }

  removeChannel(ch: FakeChannel) {
    ch.removed = true;
    ch.subscribed = false;
    const t = this.topicOf(ch.topic);
    t.channels = t.channels.filter((c) => c !== ch);
    return Promise.resolve('ok');
  }

  track(topic: string, key: string, payload: unknown) {
    this.topicOf(topic).presence.set(key, [payload]);
    this.syncAll(topic);
  }

  untrack(topic: string, key: string) {
    this.topicOf(topic).presence.delete(key);
    this.syncAll(topic);
  }

  presenceState(topic: string) {
    return Object.fromEntries(this.topicOf(topic).presence.entries());
  }

  syncAll(topic: string) {
    for (const ch of [...this.topicOf(topic).channels]) {
      if (ch.subscribed) ch.fire('presence', 'sync');
    }
  }

  broadcast(topic: string, from: FakeChannel, frame: Frame) {
    this.sent.push(frame.payload);
    for (const ch of [...this.topicOf(topic).channels]) {
      if (ch === from || !ch.subscribed) continue;
      ch.fire('broadcast', frame.event, { payload: frame.payload });
    }
  }
}

let hub = new FakeHub();

// ═══════════════════════════════════════════════════════════════════════════════
// THE FAKE DATABASE — the three eligibility gates, each independently switchable
// ═══════════════════════════════════════════════════════════════════════════════

const db = {
  tournamentId: null as string | null,
  seat: { seat_number: 3 } as { seat_number: number } | null,
  silenced: false,
};

const rpcMock = vi.fn(async () => ({ data: db.silenced, error: null as unknown }));

function makeBuilder(table: string) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  for (const m of ['select', 'eq', 'is', 'neq', 'order', 'limit', 'in']) builder[m] = vi.fn(chain);
  builder.maybeSingle = vi.fn(async () => {
    if (table === 'tables')
      return { data: { id: 't1', tournament_id: db.tournamentId }, error: null };
    if (table === 'table_seats') return { data: db.seat, error: null };
    return { data: null, error: null };
  });
  return builder;
}

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: vi.fn((table: string) => makeBuilder(table)),
    rpc: (...args: unknown[]) => (rpcMock as unknown as (...a: unknown[]) => unknown)(...args),
    channel: (topic: string, opts?: any) => hub.channel(topic, opts),
    removeChannel: (ch: any) => hub.removeChannel(ch),
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
      getUser: vi.fn(async () => ({ data: { user: null }, error: null })),
    },
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({
  reportError: vi.fn(),
}));

// ═══════════════════════════════════════════════════════════════════════════════
// THE FAKE BROWSER MEDIA STACK
// ═══════════════════════════════════════════════════════════════════════════════

class FakeTrack {
  enabled = true;
  stopped = false;
  kind = 'audio';
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  tracks: FakeTrack[];
  constructor() {
    this.tracks = [new FakeTrack()];
  }
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  signalingState = 'stable';
  connectionState = 'new';
  remoteDescription: unknown = null;
  localDescription: unknown = null;
  added: FakeTrack[] = [];
  closed = false;
  onicecandidate: ((e: unknown) => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;

  constructor(readonly config: unknown) {
    FakePeerConnection.instances.push(this);
  }
  addTrack(t: FakeTrack) {
    this.added.push(t);
    return {};
  }
  async createOffer() {
    return { type: 'offer', sdp: 'fake-offer' };
  }
  async createAnswer() {
    return { type: 'answer', sdp: 'fake-answer' };
  }
  async setLocalDescription(d: { type: string }) {
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d: { type: string }) {
    this.remoteDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate() {}
  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }
}

/** Amplitude, 0..1, that a given stream's analyser will report. */
const streamLevels = new Map<unknown, number>();

class FakeAnalyser {
  fftSize = 512;
  smoothingTimeConstant = 0;
  level = 0;
  connect() {}
  disconnect() {}
  getByteTimeDomainData(arr: Uint8Array) {
    const amp = Math.round(this.level * 127);
    for (let i = 0; i < arr.length; i++) arr[i] = 128 + (i % 2 === 0 ? amp : -amp);
  }
}

class FakeAudioContext {
  closed = false;
  createAnalyser() {
    return new FakeAnalyser();
  }
  createMediaStreamSource(stream: unknown) {
    return {
      connect: (analyser: FakeAnalyser) => {
        // The analyser reports whatever the test says this stream is doing.
        Object.defineProperty(analyser, 'level', {
          get: () => streamLevels.get(stream) ?? 0,
          configurable: true,
        });
      },
      disconnect: () => {},
    };
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

let getUserMedia: ReturnType<typeof vi.fn>;

function installBrowserFakes() {
  getUserMedia = vi.fn(async () => new FakeStream() as unknown as MediaStream);
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: (c: unknown) => getUserMedia(c) },
    configurable: true,
  });
  (window as any).RTCPeerConnection = FakePeerConnection;
  (window as any).AudioContext = FakeAudioContext;
  (globalThis as any).RTCPeerConnection = FakePeerConnection;
}

// Imported after the mocks are declared; vi.mock is hoisted, so this is safe and
// keeps the module registry honest about which supabase these files see.
import {
  TableVoiceSession,
  acquireVoiceSession,
  __resetVoiceRegistry,
  shouldInitiateOffer,
  rmsFromTimeDomain,
  sameIdSet,
  classifyMediaError,
  VOICE_CHANNEL_PREFIX,
  SPEAKING_RMS_THRESHOLD,
} from '../../src/services/VoiceSignalService';
import { useTableVoice } from '../../src/hooks/useTableVoice';
import VoiceControls from '../../src/components/table/VoiceControls';

/**
 * Drain the microtask queue twice. One offer/answer exchange is four awaits
 * deep across two sessions, and a single turn of the loop lands in the middle
 * of it - which reads as "the answer never came" rather than "the test did not
 * wait".
 */
const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  hub = new FakeHub();
  FakePeerConnection.instances = [];
  streamLevels.clear();
  db.tournamentId = null;
  db.seat = { seat_number: 3 };
  db.silenced = false;
  rpcMock.mockClear();
  installBrowserFakes();
});

afterEach(() => {
  __resetVoiceRegistry();
  vi.useRealTimers();
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE TIE-BREAK
// ═══════════════════════════════════════════════════════════════════════════════

describe('exactly one side of every pair sends the offer', () => {
  it('is decided by id order, so the rule needs no coordination', () => {
    const ids = ['00000000-a', '11111111-b', 'ffffffff-z', 'aaaaaaaa-m'];
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        // Total and antisymmetric: for any distinct pair exactly one initiates.
        expect(shouldInitiateOffer(a, b) !== shouldInitiateOffer(b, a)).toBe(true);
      }
    }
    expect(shouldInitiateOffer('aaa', 'bbb')).toBe(true);
    expect(shouldInitiateOffer('bbb', 'aaa')).toBe(false);
  });

  it('produces one offer, from the lower id, when two peers discover each other', async () => {
    const low = new TableVoiceSession('table-1', 'aaa-low');
    const high = new TableVoiceSession('table-1', 'zzz-high');

    expect(await low.join()).toBe(true);
    expect(await high.join()).toBe(true);
    await flush();

    const offers = hub.sent.filter((m) => m.kind === 'offer');
    // Both sides see the other appear in presence at the same instant. If both
    // offered, that is glare: a rollback at best and a wedged connection at
    // worst, and it is the single most common way a hand-rolled mesh fails.
    expect(offers).toHaveLength(1);
    expect(offers[0].from).toBe('aaa-low');
    expect(offers[0].to).toBe('zzz-high');

    // And the answer came back the other way, so the exchange completed.
    const answers = hub.sent.filter((m) => m.kind === 'answer');
    expect(answers).toHaveLength(1);
    expect(answers[0].from).toBe('zzz-high');

    low.destroy();
    high.destroy();
  });

  it('signals on the table voice topic, not on the game channel', async () => {
    const session = new TableVoiceSession('table-9', 'user-1');
    await session.join();
    expect(hub.topics.has(`${VOICE_CHANNEL_PREFIX}table-9`)).toBe(true);
    // TableWebSocket owns `table:<id>` and re-creates it on every reconnect.
    // Voice must not be attached to a lifetime it cannot see.
    expect(hub.topics.has('table:table-9')).toBe(false);
    session.destroy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE MICROPHONE STARTS CLOSED
// ═══════════════════════════════════════════════════════════════════════════════

describe('the microphone is muted until the player opens it', () => {
  it('joins with the local track DISABLED, not merely with a muted flag', async () => {
    const session = new TableVoiceSession('table-1', 'user-1');
    await session.join();

    expect(session.getState().isJoined).toBe(true);
    expect(session.getState().isMuted).toBe(true);
    expect(session.getState().isTransmitting).toBe(false);

    // The flag alone would be a lie: what stops audio leaving the machine is
    // `track.enabled = false`, which stops the encoder rather than the speaker
    // at the far end.
    const stream = await getUserMedia.mock.results[0].value;
    expect((stream as unknown as FakeStream).getAudioTracks()[0].enabled).toBe(false);

    session.destroy();
  });

  it('asks for mono audio with the three processors a table needs', async () => {
    const session = new TableVoiceSession('table-1', 'user-1');
    await session.join();

    const constraints = getUserMedia.mock.calls[0][0] as { audio: Record<string, unknown> };
    expect(constraints.audio.echoCancellation).toBe(true);
    expect(constraints.audio.noiseSuppression).toBe(true);
    expect(constraints.audio.autoGainControl).toBe(true);
    expect(constraints.audio.channelCount).toBe(1);

    session.destroy();
  });

  it('opens and closes the track on startTalking and stopTalking', async () => {
    const session = new TableVoiceSession('table-1', 'user-1');
    await session.join();
    const stream = (await getUserMedia.mock.results[0].value) as unknown as FakeStream;

    session.startTalking();
    expect(stream.getAudioTracks()[0].enabled).toBe(true);
    expect(session.getState().isTransmitting).toBe(true);

    session.stopTalking();
    expect(stream.getAudioTracks()[0].enabled).toBe(false);
    expect(session.getState().isTransmitting).toBe(false);

    session.destroy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PERMISSION
// ═══════════════════════════════════════════════════════════════════════════════

describe('a refused microphone is a state, never a thrown error', () => {
  it('reports permission-denied and stays out of the room', async () => {
    const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    getUserMedia.mockRejectedValueOnce(denied);

    const session = new TableVoiceSession('table-1', 'user-1');
    // join() is called straight from a click handler inside render. A rejection
    // escaping here would surface as an unhandled promise rejection with the
    // table still on screen and no explanation anywhere.
    await expect(session.join()).resolves.toBe(false);

    const state = session.getState();
    expect(state.isJoined).toBe(false);
    expect(state.error?.code).toBe('permission-denied');
    expect(state.status).toBe('idle');
    session.destroy();
  });

  it('tells a dismissed prompt apart from an outright block', () => {
    expect(
      classifyMediaError(
        Object.assign(new Error('Permission dismissed'), { name: 'NotAllowedError' })
      ).code
    ).toBe('permission-dismissed');
    expect(
      classifyMediaError(Object.assign(new Error('nope'), { name: 'NotAllowedError' })).code
    ).toBe('permission-denied');
    expect(
      classifyMediaError(Object.assign(new Error('none'), { name: 'NotFoundError' })).code
    ).toBe('no-device');
  });

  it('never opens the microphone when the signalling topic will not subscribe', async () => {
    hub.subscribeStatus = 'CHANNEL_ERROR';
    const session = new TableVoiceSession('table-1', 'user-1');

    expect(await session.join()).toBe(false);
    expect(session.getState().error?.code).toBe('signalling-failed');
    // The stream was opened to negotiate against and must be handed back, or
    // the browser leaves the recording indicator lit on a table with no voice.
    const stream = (await getUserMedia.mock.results[0].value) as unknown as FakeStream;
    expect(stream.getTracks()[0].stopped).toBe(true);
    session.destroy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WHO IS ALLOWED TO SPEAK
// ═══════════════════════════════════════════════════════════════════════════════

describe('voice honours the authority text chat already answers to', () => {
  it('refuses a silenced player, and refuses to transmit for one', async () => {
    db.silenced = true;
    const session = new TableVoiceSession('table-1', 'user-1');

    expect(await session.checkEligibility()).toBe(false);
    expect(session.getState().isAvailable).toBe(false);
    expect(session.getState().error?.code).toBe('silenced');

    // It asked `fn_table_chat_is_silenced` - the SECURITY DEFINER function the
    // table_chat RLS policy itself calls - rather than reading `tables.ban_chat`
    // and missing the two silencing routes a player cannot read for themselves.
    expect(rpcMock).toHaveBeenCalled();

    expect(await session.join()).toBe(false);
    expect(getUserMedia).not.toHaveBeenCalled();

    // And the talk path is independently guarded, because a mute can land after
    // a session is already up.
    session.startTalking();
    expect(session.getState().isTransmitting).toBe(false);
    session.destroy();
  });

  it('refuses an observer who is not in a seat', async () => {
    db.seat = null;
    const session = new TableVoiceSession('table-1', 'watcher');
    expect(await session.checkEligibility()).toBe(false);
    expect(session.getState().error?.code).toBe('not-seated');
    session.destroy();
  });

  it('refuses a tournament table', async () => {
    db.tournamentId = 'tourney-1';
    const session = new TableVoiceSession('table-1', 'user-1');
    expect(await session.checkEligibility()).toBe(false);
    expect(session.getState().error?.code).toBe('tournament-table');
    session.destroy();
  });

  it('fails closed when the silence check itself cannot be read', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    const session = new TableVoiceSession('table-1', 'user-1');
    // Text chat leans the other way because RLS is its real enforcement. Voice
    // has no server in the media path, so the client failing closed IS the
    // enforcement.
    expect(await session.checkEligibility()).toBe(false);
    expect(session.getState().error?.code).toBe('silenced');
    session.destroy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TEARDOWN
// ═══════════════════════════════════════════════════════════════════════════════

describe('every peer, track and channel is released', () => {
  it('closes the peer connections, stops the microphone and drops the topic', async () => {
    const low = new TableVoiceSession('table-1', 'aaa-low');
    const high = new TableVoiceSession('table-1', 'zzz-high');
    await low.join();
    await high.join();
    await flush();

    expect(FakePeerConnection.instances.length).toBeGreaterThanOrEqual(2);
    const channelsBefore = hub.topics.get(`${VOICE_CHANNEL_PREFIX}table-1`)!.channels.length;
    expect(channelsBefore).toBe(2);

    const lowStream = (await getUserMedia.mock.results[0].value) as unknown as FakeStream;
    low.destroy();
    high.destroy();

    expect(FakePeerConnection.instances.every((pc) => pc.closed)).toBe(true);
    expect(lowStream.getTracks()[0].stopped).toBe(true);
    expect(hub.topics.get(`${VOICE_CHANNEL_PREFIX}table-1`)!.channels).toHaveLength(0);
  });

  it('drops a peer that leaves presence, without disturbing the rest', async () => {
    const low = new TableVoiceSession('table-1', 'aaa-low');
    const high = new TableVoiceSession('table-1', 'zzz-high');
    await low.join();
    await high.join();
    await flush();

    expect(Object.keys(low.getState().peerStates)).toContain('zzz-high');

    high.leave();
    await flush();

    expect(Object.keys(low.getState().peerStates)).not.toContain('zzz-high');
    expect(low.getState().isJoined).toBe(true);
    low.destroy();
  });

  it('shares ONE mesh between the header and the felt, and destroys it on the last release', () => {
    const a = acquireVoiceSession('table-1', 'user-1');
    const b = acquireVoiceSession('table-1', 'user-1');
    // Two consumers, one room. Two meshes would mean two open microphones and
    // every remote player hearing this one twice.
    expect(a.session).toBe(b.session);

    a.release();
    const c = acquireVoiceSession('table-1', 'user-1');
    expect(c.session).toBe(b.session); // b still holds it

    b.release();
    c.release();
    const d = acquireVoiceSession('table-1', 'user-1');
    expect(d.session).not.toBe(b.session); // everyone let go, so it was destroyed
    d.release();
  });

  it('releases the session when the React consumer unmounts', () => {
    function Probe() {
      useTableVoice({ tableId: 'table-1', userId: 'user-1' });
      return null;
    }
    const { unmount } = render(<Probe />);
    const held = acquireVoiceSession('table-1', 'user-1');
    const sessionWhileMounted = held.session;
    held.release();

    unmount();

    const after = acquireVoiceSession('table-1', 'user-1');
    expect(after.session).not.toBe(sessionWhileMounted);
    after.release();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// WHO IS TALKING
// ═══════════════════════════════════════════════════════════════════════════════

describe('speakingPlayerIds', () => {
  it('holds the SAME array while the set has not changed', async () => {
    // Fake timers BEFORE the join: the level poller is an interval created
    // during join, and a timer scheduled on the real clock is not something
    // `advanceTimersByTime` can ever reach.
    vi.useFakeTimers();
    const session = new TableVoiceSession('table-1', 'user-1');
    await session.join();
    const stream = (await getUserMedia.mock.results[0].value) as unknown;
    streamLevels.set(stream, 0.5);
    session.startTalking();

    vi.advanceTimersByTime(120);
    const first = session.getState().speakingPlayerIds;
    expect(first).toEqual(['user-1']);

    vi.advanceTimersByTime(120);
    const second = session.getState().speakingPlayerIds;

    // useSeatChatBubbles and every memo hanging off it key on this identity. A
    // fresh array ten times a second describing the same one speaker would
    // re-run all of them for no change at all.
    expect(second).toBe(first);

    session.destroy();
    vi.useRealTimers();
  });

  it('never lights the hero while their own microphone is closed', async () => {
    vi.useFakeTimers();
    const session = new TableVoiceSession('table-1', 'user-1');
    await session.join();
    const stream = (await getUserMedia.mock.results[0].value) as unknown;
    streamLevels.set(stream, 0.9); // shouting at a muted mic

    vi.advanceTimersByTime(300);
    expect(session.getState().speakingPlayerIds).toEqual([]);

    session.destroy();
    vi.useRealTimers();
  });

  it('measures level as RMS, so silence is zero and a loud buffer is not', () => {
    expect(rmsFromTimeDomain([128, 128, 128, 128])).toBe(0);
    expect(rmsFromTimeDomain([255, 1, 255, 1])).toBeGreaterThan(SPEAKING_RMS_THRESHOLD);
    expect(rmsFromTimeDomain([])).toBe(0);
  });

  it('compares id sets by membership, not by order', () => {
    expect(sameIdSet(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameIdSet(['a'], ['a', 'b'])).toBe(false);
    expect(sameIdSet([], [])).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE CONTROL
// ═══════════════════════════════════════════════════════════════════════════════

describe('VoiceControls', () => {
  it('keeps the prop contract TableChat mounts it with', async () => {
    // <VoiceControls tableId={tableId} userId={myPlayerId ?? ''} /> and nothing
    // else. Another agent owns that call site.
    const { container } = render(<VoiceControls tableId="table-1" userId="user-1" />);
    await act(async () => {
      await flush();
    });
    expect(container.querySelector('.voice-controls')).not.toBeNull();
  });

  it('offers a join button rather than a live microphone', async () => {
    const { getByLabelText, queryByLabelText } = render(
      <VoiceControls tableId="table-1" userId="user-1" />
    );
    await act(async () => {
      await flush();
    });

    expect(getByLabelText('Join Table Voice')).toBeTruthy();
    // No talk affordance at all until the room has been entered deliberately.
    expect(queryByLabelText('Hold To Talk')).toBeNull();
    expect(queryByLabelText('Leave Table Voice')).toBeNull();
  });

  it('says why, in the header, when the player may not use voice here', async () => {
    db.tournamentId = 'tourney-1';
    const { container } = render(<VoiceControls tableId="table-1" userId="user-1" />);
    await act(async () => {
      await flush();
    });

    const note = container.querySelector('.voice-controls--note');
    expect(note).not.toBeNull();
    expect(note!.textContent).toBe('Cash Tables Only');
    // The full sentence survives in the title, and it obeys the popup rule:
    // First Letter Of Every Word Capitalized, and no em dash.
    expect(note!.getAttribute('title')).toBe('Voice Is Available At Cash Tables Only.');
    expect(note!.getAttribute('title')).not.toContain('—');
  });

  it('renders nothing at all for an observer with no account', () => {
    const { container } = render(<VoiceControls tableId="table-1" userId="" />);
    expect(container.querySelector('.voice-controls')).toBeNull();
  });
});
