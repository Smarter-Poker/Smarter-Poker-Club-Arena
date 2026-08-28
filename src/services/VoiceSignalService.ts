/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TABLE VOICE — peer-to-peer WebRTC mesh, signalled over Supabase Realtime
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-27: "FULL VOICE, BUILD IT OR FIND A OPEN SOURCE".
 *
 * WHAT THIS IS, AND WHY IT IS NOT A VENDOR
 * ────────────────────────────────────────
 * Voice at a poker table is a small number of people in one room: nine seats at
 * the absolute ceiling, six in practice. At that size a FULL MESH is tractable
 * without a media server at all - each browser holds at most eight audio peer
 * connections, which is what `RTCPeerConnection` was designed for. Everything
 * here is browser-native: `getUserMedia`, `RTCPeerConnection`, `AudioContext`.
 * There is no LiveKit, no Agora, no Twilio, no new dependency in package.json.
 *
 * That is not only a cost decision, it is the house rule. CLAUDE.md section
 * 1.1.1 (RULE 12) forbids an agent from creating new GitHub repos, Vercel
 * projects, Supabase projects, Hetzner servers or OAuth clients. Every SFU
 * answer to this problem is a new server. A mesh signalled over the Realtime
 * service this app is ALREADY connected to creates exactly zero new
 * infrastructure, which is why it is the right answer here and not merely the
 * cheap one.
 *
 * WHERE THE SIGNALLING RIDES
 * ──────────────────────────
 * On the same Supabase Realtime CONNECTION every table already opens, on its
 * own topic: `table-voice:<tableId>`. supabase-js multiplexes every channel
 * over one WebSocket, so a second topic is not a second socket - it is a second
 * logical stream on the socket TableWebSocket already holds open.
 *
 * It is a separate TOPIC rather than a second listener on `table:<tableId>`
 * because that channel is owned by TableWebSocket (created, torn down and
 * re-created on every reconnect, with RoomService rebinding to it). Attaching
 * voice to a channel with that lifecycle would put the mesh at the mercy of a
 * reconnect it cannot see, and would mean editing a file this agent does not
 * own. One topic, one owner, one lifetime.
 *
 * Payloads:
 *   broadcast event `voice-signal`
 *   { from, to, kind: 'offer' | 'answer' | 'ice', data }
 * Presence (key = userId) is peer discovery: presence sync says who is in the
 * room, join/leave says who arrived and who left.
 *
 * THE TWO THINGS A BARE MESH CANNOT DO, AND THE ONE THING THAT FIXES BOTH
 * ──────────────────────────────────────────────────────────────────────────
 * Voice shipped with public STUN only, and that has two consequences:
 *
 *   1. STUN cannot traverse a SYMMETRIC NAT, which is what most mobile carrier
 *      networks are. Those peers do not get worse audio, they get NONE.
 *   2. A p2p mesh hands every participant's PUBLIC IP ADDRESS to every other
 *      participant, because that is what an ICE candidate is. At a money table
 *      full of strangers that is a collusion and harassment surface.
 *
 * A TURN RELAY CLOSES BOTH. A relayed candidate carries the relay's address, so
 * the peer's own address never leaves the relay, and a relay is reachable from
 * behind any NAT because the client dials out to it.
 *
 * So the ICE list is no longer hardcoded: `fetchVoiceIceConfig` asks the engine
 * (`GET /voice/ice`) once per join, and the engine answers with short-lived TURN
 * credentials plus a transport policy. When a relay exists the policy is
 * `relay`, which forces ALL media through it and hides every address. When one
 * does not - which is every engine until the relay is deployed - the answer is
 * the STUN-only list and policy `all`, and voice behaves exactly as it always
 * has, symmetric-NAT failures included.
 *
 * Those failures are still said OUT LOUD (`peerStates[id] === 'failed'`, error
 * code `connection-failed`) rather than leaving a dead microphone that looks
 * alive. That property is the reason there is no automatic downgrade from
 * `relay` to `all` when a relay-only connection fails: a silent downgrade would
 * trade the privacy property away at the exact moment nobody is watching. If the
 * relay dies, voice fails honestly and an operator flips one env var on purpose.
 *
 * SAFETY POSTURE
 * ──────────────
 *  - The microphone starts MUTED and the local audio track starts DISABLED.
 *    Nothing is transmitted until the player deliberately opens it. This is a
 *    real-money table; an accidentally hot mic is a chip-EV event.
 *  - Voice is refused to observers, to tournament tables, and to any player the
 *    existing `fn_table_chat_is_silenced` authority says is silenced. That is
 *    the SAME function the text-chat RLS policy calls (see useTableChat), so
 *    voice and text can never disagree about who is muted.
 *  - Peer connections expose IP addresses between players. That is inherent to
 *    p2p, and it is the reason the relay exists: with `iceTransportPolicy:
 *    'relay'` every candidate belongs to the relay and no player learns another
 *    player's address. Until a relay is deployed the exposure is real and
 *    unmitigated, and that is a live finding, not a solved one.
 */

import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import type { RealtimeChannel } from '@supabase/supabase-js';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/** Realtime topic prefix. One topic per table, owned entirely by this module. */
export const VOICE_CHANNEL_PREFIX = 'table-voice:';

/** The single broadcast event every signalling message rides. */
export const VOICE_SIGNAL_EVENT = 'voice-signal';

/**
 * THE FALLBACK ICE LIST. Public STUN only, no relay.
 *
 * Two providers, because one operator having a bad afternoon should not take
 * voice down for the whole platform. Neither relays media - they only report the
 * public address a peer is reachable at.
 *
 * This used to be the ONLY list, hardcoded straight into every
 * `RTCPeerConnection`. It is now the floor the mesh falls back to when
 * `GET /voice/ice` cannot be reached or has nothing better to offer, so a
 * network fault or an engine mid-deploy costs voice nothing it has today.
 */
export const VOICE_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** Where the credential endpoint lives. Same engine every other call goes to. */
const ENGINE_BASE_URL: string =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_ENGINE_URL ||
  ((import.meta as unknown as { env?: { PROD?: boolean } }).env?.PROD
    ? 'https://engine.smarter.poker'
    : 'http://localhost:8080');

export const VOICE_ICE_ENDPOINT = `${ENGINE_BASE_URL}/voice/ice`;

/**
 * How long to wait for the ICE list before giving up and using STUN.
 *
 * This sits directly in front of the microphone opening, so it is a delay the
 * player is watching. Five seconds is long enough to survive a slow mobile
 * handshake and short enough that a dead engine does not look like a hung join.
 */
const ICE_FETCH_TIMEOUT_MS = 5000;

/**
 * Safety margin on the credential's own expiry. Re-fetch this long before the
 * relay would start refusing, so a session that outlives its credential renews
 * rather than silently losing every new peer.
 */
const ICE_CACHE_SAFETY_MS = 60_000;

/** Cache lifetime when the answer carries no expiry (the STUN-only case). */
const ICE_CACHE_DEFAULT_MS = 10 * 60_000;

/**
 * Normalised RMS above which a stream counts as speech.
 *
 * 0.02 is roughly -34 dBFS. Below that sits room tone and the residue that
 * survives `noiseSuppression`; conversational speech on a phone microphone sits
 * an order of magnitude above it. Too low and every table shows nine seats
 * permanently "speaking", which is the same as showing nothing.
 */
export const SPEAKING_RMS_THRESHOLD = 0.02;

/**
 * How long a speaker stays lit after they drop below the threshold.
 *
 * Speech is full of gaps - a plosive, a breath between words - and without a
 * hold the seat bubble strobes several times a second. 400ms is longer than any
 * intra-word gap and short enough that letting go of the button reads as
 * instant.
 */
export const SPEAKING_HOLD_MS = 400;

/** Level sampling interval. 10Hz is plenty for an indicator a human reads. */
const LEVEL_POLL_MS = 100;

/** Recreate a failed peer connection at most this many times before giving up. */
const MAX_PEER_RETRIES = 3;
const PEER_RETRY_BASE_MS = 800;

/**
 * `disconnected` is frequently transient (a wifi to LTE handover). Give ICE a
 * chance to recover on its own before tearing the connection down and paying
 * for a full renegotiation.
 */
const DISCONNECT_GRACE_MS = 6000;

/** Re-ask the silence authority while joined, so a mid-session mute lands. */
const SILENCE_RECHECK_MS = 60_000;

/**
 * Mesh ceiling. Nine seats means eight peers; anything past that is not a poker
 * table and a browser holding a dozen peer connections starts dropping audio.
 */
export const MAX_VOICE_PEERS = 8;

/** localStorage key for the push-to-talk vs latching preference, per user. */
const PREF_KEY_PREFIX = 'smarter-poker-voice-pref:';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type VoicePeerState = 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

export type VoiceErrorCode =
  /** The browser cannot do this at all (no RTCPeerConnection, no mediaDevices). */
  | 'unsupported'
  /** Not https and not localhost: getUserMedia is not even offered. */
  | 'insecure-context'
  /** The player pressed Block. */
  | 'permission-denied'
  /** The player closed the prompt without answering. Retryable. */
  | 'permission-dismissed'
  /** No microphone attached, or the one attached cannot be opened. */
  | 'no-device'
  /** Watching, not seated. Voice belongs to the players in the hand. */
  | 'not-seated'
  /** Tournament table. Voice is cash-only for now. */
  | 'tournament-table'
  /** `fn_table_chat_is_silenced` says this player may not speak here. */
  | 'silenced'
  /** The Realtime topic would not subscribe, so no peer can be reached. */
  | 'signalling-failed'
  /**
   * ICE gave up. On the STUN-only path that is almost always a symmetric NAT
   * with no relay to fall back on. Once a relay is deployed and the policy is
   * `relay`, it means the relay itself could not be reached - which is why the
   * mesh never silently retries with `all`, and an operator makes that call.
   */
  | 'connection-failed';

export interface VoiceError {
  code: VoiceErrorCode;
  /** Shown to the player. Title Case, no em dashes (house popup rule). */
  message: string;
}

export type VoiceStatus = 'idle' | 'checking' | 'connecting' | 'live';

export interface VoiceSessionState {
  /** Voice is possible here: the browser can do it and this player is allowed. */
  isAvailable: boolean;
  /** The mesh is up (or coming up) and the local microphone is open. */
  isJoined: boolean;
  /** The local audio track is disabled. True until the player opens the mic. */
  isMuted: boolean;
  /** The mic is open right now, whether by holding the button or latching it. */
  isTransmitting: boolean;
  /** Everyone audible right now, local player included. Stable identity. */
  speakingPlayerIds: string[];
  peerStates: Record<string, VoicePeerState>;
  error: VoiceError | null;
  status: VoiceStatus;
}

export type VoiceTalkMode = 'hold' | 'latch';

interface VoiceSignalMessage {
  from: string;
  to: string;
  kind: 'offer' | 'answer' | 'ice';
  data: unknown;
}

interface PeerRecord {
  id: string;
  pc: RTCPeerConnection;
  /** True when this side waits for the offer rather than sending one. */
  polite: boolean;
  makingOffer: boolean;
  /** ICE that arrived before the remote description could accept it. */
  pendingCandidates: RTCIceCandidateInit[];
  audio: HTMLAudioElement | null;
  meter: LevelMeter | null;
  retries: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

interface LevelMeter {
  analyser: AnalyserNode;
  source: MediaStreamAudioSourceNode;
  /**
   * Typed off the method that consumes it rather than written as `Uint8Array`.
   * Recent lib.dom narrows this parameter to `Uint8Array<ArrayBuffer>` (a plain
   * `Uint8Array` is `Uint8Array<ArrayBufferLike>` and no longer assignable), and
   * spelling the narrow form here would break the moment the TypeScript version
   * moves in either direction. This is correct in both.
   */
  data: Parameters<AnalyserNode['getByteTimeDomainData']>[0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// PURE HELPERS (exported so the tests can pin them without a browser)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * THE TIE-BREAK. Two peers discovering each other simultaneously must not both
 * send an offer - that is glare, and it costs a rollback at best and a wedged
 * connection at worst. The rule is total, deterministic and needs no
 * coordination: the LOWER user id offers, the higher one answers. Since ids are
 * distinct uuids, exactly one side of every pair is the offerer.
 */
export function shouldInitiateOffer(myId: string, peerId: string): boolean {
  return myId < peerId;
}

/** Normalised RMS (0..1) of a byte time-domain buffer centred on 128. */
export function rmsFromTimeDomain(data: ArrayLike<number>): number {
  if (!data || data.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

/** Two id lists hold the same set, order ignored. Used to keep identity stable. */
export function sameIdSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  for (const id of b) if (!seen.has(id)) return false;
  return true;
}

/** Turn whatever getUserMedia threw into something a player can act on. */
export function classifyMediaError(err: unknown): VoiceError {
  const name = (err as { name?: string })?.name || '';
  const message = String((err as { message?: string })?.message || '');

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    // Chrome reports a dismissed prompt with the same name as an outright
    // block, and the difference matters: one is retryable by asking again, the
    // other needs the player to change a browser setting.
    if (/dismiss/i.test(message)) {
      return {
        code: 'permission-dismissed',
        message: 'Microphone Request Was Closed. Tap The Mic To Ask Again.',
      };
    }
    return {
      code: 'permission-denied',
      message: 'Microphone Blocked. Allow It In Your Browser Settings To Use Voice.',
    };
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError') {
    return { code: 'no-device', message: 'No Microphone Was Found On This Device.' };
  }
  return { code: 'unsupported', message: 'Voice Is Not Available In This Browser.' };
}

/** Read the saved talk mode. Defaults to hold, the safer of the two. */
export function readTalkMode(userId: string): VoiceTalkMode {
  try {
    const raw = localStorage.getItem(PREF_KEY_PREFIX + userId);
    return raw === 'latch' ? 'latch' : 'hold';
  } catch {
    return 'hold';
  }
}

export function writeTalkMode(userId: string, mode: VoiceTalkMode): void {
  try {
    localStorage.setItem(PREF_KEY_PREFIX + userId, mode);
  } catch {
    /* private mode, quota, a browser with storage switched off: not fatal */
  }
}

/** Everything the mesh needs from the platform, so a test can hand it fakes. */
export function isVoiceSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const hasMedia = !!nav?.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function';
  const hasPeer =
    typeof (window as { RTCPeerConnection?: unknown }).RTCPeerConnection === 'function';
  return hasMedia && hasPeer;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ICE CONFIGURATION — where the relay credentials come from
// ═══════════════════════════════════════════════════════════════════════════════

/** The complete transport configuration one `RTCPeerConnection` is built with. */
export interface VoiceIceConfig {
  iceServers: RTCIceServer[];
  /**
   * `relay` forces every media path through the TURN relay, so no player ever
   * learns another player's IP address. `all` prefers a direct path and leaks
   * it. See the argument on the server side (`server/src/voice/turnCredentials.ts`
   * `resolveTransportPolicy`): the engine chooses `relay` whenever a relay
   * exists, because these are strangers playing for money.
   */
  iceTransportPolicy: RTCIceTransportPolicy;
  /** True when the list carries a real TURN relay with live credentials. */
  turn: boolean;
  /** Unix SECONDS the credential dies, or null when there is none. */
  expiresAt: number | null;
}

/**
 * What the mesh uses when the engine cannot be asked: exactly what it used
 * before this endpoint existed. `all`, because forcing `relay` with nothing to
 * relay through would mean voice for nobody.
 */
export const VOICE_ICE_FALLBACK: VoiceIceConfig = {
  iceServers: VOICE_ICE_SERVERS,
  iceTransportPolicy: 'all',
  turn: false,
  expiresAt: null,
};

/**
 * A build-time override, for a deliberate local experiment or an emergency.
 *
 * It is read only when it says something valid, and it CANNOT invent a relay:
 * asking for `relay` when the engine returned no TURN entry would silence voice
 * completely, so that combination is ignored below.
 */
const CLIENT_POLICY_OVERRIDE: RTCIceTransportPolicy | null = (() => {
  const raw = (import.meta as unknown as { env?: Record<string, string> }).env
    ?.VITE_VOICE_ICE_TRANSPORT_POLICY;
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value === 'relay' || value === 'all' ? (value as RTCIceTransportPolicy) : null;
})();

interface IceCacheEntry {
  config: VoiceIceConfig;
  /** epoch ms after which this must be fetched again. */
  until: number;
}

/**
 * CACHED PER SESSION, NOT PER PEER.
 *
 * A nine-handed table builds eight peer connections. Fetching a credential for
 * each of them would be eight authenticated round-trips at the exact moment the
 * player is waiting for the microphone, and every one would mint a credential
 * equivalent to the first. One fetch per join, shared by every peer and by every
 * table this browser has open, is the whole requirement.
 */
let iceCache: IceCacheEntry | null = null;
let iceInFlight: Promise<VoiceIceConfig> | null = null;

/** Test seam, and the thing to call if a credential is ever known to be bad. */
export function __resetVoiceIceCache(): void {
  iceCache = null;
  iceInFlight = null;
}

/** Reject anything that is not a usable ICE list, so a bad answer falls back. */
function parseIceResponse(raw: unknown): VoiceIceConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;

  const servers = Array.isArray(body.iceServers) ? (body.iceServers as RTCIceServer[]) : [];
  // An empty list is not an answer - it would gather no candidates at all, which
  // is worse than the STUN-only fallback we already have.
  const usable = servers.filter((s) => s && (typeof s.urls === 'string' || Array.isArray(s.urls)));
  if (usable.length === 0) return null;

  const turn = body.turn === true;
  const policyRaw = typeof body.iceTransportPolicy === 'string' ? body.iceTransportPolicy : '';
  let policy: RTCIceTransportPolicy = policyRaw === 'relay' ? 'relay' : 'all';

  // A build override wins, EXCEPT that it can never ask for a relay that is not
  // there. Same guard the engine applies to its own operator override.
  if (CLIENT_POLICY_OVERRIDE) policy = CLIENT_POLICY_OVERRIDE;
  if (policy === 'relay' && !turn) policy = 'all';

  const expiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : null;
  return { iceServers: usable, iceTransportPolicy: policy, turn, expiresAt };
}

/** How long this answer may be reused, bounded by the credential's own life. */
function cacheWindowMs(config: VoiceIceConfig, nowMs: number): number {
  if (!config.expiresAt) return ICE_CACHE_DEFAULT_MS;
  const remaining = config.expiresAt * 1000 - nowMs - ICE_CACHE_SAFETY_MS;
  return Math.max(0, Math.min(ICE_CACHE_DEFAULT_MS, remaining));
}

/**
 * Ask the engine for the ICE list, with the player's own JWT.
 *
 * NEVER THROWS AND NEVER BLOCKS THE JOIN FOR LONG. Every failure - no session,
 * no network, a 401, a timeout, an unparseable body - returns the STUN-only
 * fallback, so the worst case is precisely the behaviour voice shipped with.
 * A failure is not cached: the next join asks again.
 */
export async function fetchVoiceIceConfig(): Promise<VoiceIceConfig> {
  const now = Date.now();
  if (iceCache && iceCache.until > now) return iceCache.config;
  if (iceInFlight) return iceInFlight;

  iceInFlight = (async (): Promise<VoiceIceConfig> => {
    try {
      // The endpoint is authenticated on purpose (an open credential mint is an
      // open relay), so with no session there is nothing to ask with. Returning
      // early also keeps every test that has no session off the network.
      const { data } = await supabase.auth.getSession();
      const token = data?.session?.access_token;
      if (!token) return VOICE_ICE_FALLBACK;

      if (typeof fetch !== 'function') return VOICE_ICE_FALLBACK;

      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller
        ? setTimeout(() => {
            try {
              controller.abort();
            } catch {
              /* already settled */
            }
          }, ICE_FETCH_TIMEOUT_MS)
        : null;

      let parsed: VoiceIceConfig | null = null;
      try {
        const res = await fetch(VOICE_ICE_ENDPOINT, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          signal: controller?.signal,
        });
        if (res && res.ok) parsed = parseIceResponse(await res.json());
      } finally {
        if (timer) clearTimeout(timer);
      }

      if (!parsed) return VOICE_ICE_FALLBACK;

      const window = cacheWindowMs(parsed, Date.now());
      if (window > 0) iceCache = { config: parsed, until: Date.now() + window };
      return parsed;
    } catch (e) {
      // Deliberately quiet about the shape of the failure: this runs on every
      // join, and an engine mid-deploy would otherwise fill Sentry with noise
      // describing a case that is fully handled.
      reportError(e, 'VoiceSignalService.fetchVoiceIceConfig');
      return VOICE_ICE_FALLBACK;
    } finally {
      iceInFlight = null;
    }
  })();

  return iceInFlight;
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE SESSION
// ═══════════════════════════════════════════════════════════════════════════════

const INITIAL_STATE: VoiceSessionState = {
  isAvailable: false,
  isJoined: false,
  isMuted: true,
  isTransmitting: false,
  speakingPlayerIds: [],
  peerStates: {},
  error: null,
  status: 'idle',
};

type Listener = (state: VoiceSessionState) => void;

/**
 * One voice room for one table, for one local player.
 *
 * Deliberately NOT a hook. Two things need to read this session - the controls
 * in the chat header and the seat bubbles on the felt - and if each of them
 * built its own mesh the table would run two of everything: two microphones,
 * two sets of peer connections, and every remote player hearing the local one
 * twice. `acquireVoiceSession` refcounts a single instance instead.
 */
export class TableVoiceSession {
  readonly tableId: string;
  readonly userId: string;

  private state: VoiceSessionState = INITIAL_STATE;
  private listeners = new Set<Listener>();

  private channel: RealtimeChannel | null = null;
  /**
   * Resolved once at join and shared by every peer connection this session
   * builds. Starts as the STUN-only fallback so a peer created before the fetch
   * lands is still a working peer rather than a broken one.
   */
  private iceConfig: VoiceIceConfig = VOICE_ICE_FALLBACK;
  private localStream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private localMeter: LevelMeter | null = null;
  private peers = new Map<string, PeerRecord>();

  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  /** id -> epoch ms the level last crossed the threshold (the hold window). */
  private lastLoudAt = new Map<string, number>();

  private eligibilityChecked = false;
  private eligible = false;
  private destroyed = false;
  private joining: Promise<boolean> | null = null;

  constructor(tableId: string, userId: string) {
    this.tableId = tableId;
    this.userId = userId;
  }

  // ─── state plumbing ────────────────────────────────────────────────────────

  getState(): VoiceSessionState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setState(patch: Partial<VoiceSessionState>): void {
    if (this.destroyed && !patch.status) return;
    const next = { ...this.state, ...patch };

    // Identity discipline: `speakingPlayerIds` is consumed by useSeatChatBubbles
    // and by any memo hanging off it. Handing back a NEW array describing the
    // SAME set on every 100ms tick would re-run all of them ten times a second
    // for no change at all.
    if (
      patch.speakingPlayerIds &&
      sameIdSet(this.state.speakingPlayerIds, patch.speakingPlayerIds)
    ) {
      next.speakingPlayerIds = this.state.speakingPlayerIds;
    }

    const unchanged =
      next.isAvailable === this.state.isAvailable &&
      next.isJoined === this.state.isJoined &&
      next.isMuted === this.state.isMuted &&
      next.isTransmitting === this.state.isTransmitting &&
      next.speakingPlayerIds === this.state.speakingPlayerIds &&
      next.error === this.state.error &&
      next.status === this.state.status &&
      shallowEqual(next.peerStates, this.state.peerStates);
    if (unchanged) return;

    this.state = next;
    this.listeners.forEach((fn) => {
      try {
        fn(next);
      } catch (e) {
        reportError(e, 'TableVoiceSession.listener');
      }
    });
  }

  // ─── eligibility ───────────────────────────────────────────────────────────

  /**
   * May this player speak at this table?
   *
   * Three gates, all of which have to pass:
   *  1. the table is a CASH table (`tournament_id` null) - a tournament table's
   *     population changes every few minutes as tables break and merge, and a
   *     voice room whose membership churns like that is a different product;
   *  2. this player holds an open seat (`table_seats.left_at is null`) - an
   *     observer listening to the table talk is an information leak, and it is
   *     the specific one that matters at a poker table;
   *  3. `fn_table_chat_is_silenced` says no. That RPC is the SECURITY DEFINER
   *     function the table_chat RLS policy itself calls, and it reads all three
   *     ways a player can be silenced (the table's ban_chat, the parent
   *     tournament's ban_chat, and this player's own table_chat_mutes row). Two
   *     of those are unreadable from the browser by the player they apply to,
   *     which is exactly why voice must ask the authority instead of guessing.
   *
   * An unreadable answer is treated as NOT eligible. Text chat leans the other
   * way because its RLS policy is the real enforcement and the composer is only
   * a courtesy. Voice has no such backstop - there is no server in the media
   * path to refuse anything - so the client failing closed is the enforcement.
   */
  async checkEligibility(force = false): Promise<boolean> {
    if (this.destroyed) return false;
    if (this.eligibilityChecked && !force) return this.eligible;

    if (!isVoiceSupported()) {
      this.eligibilityChecked = true;
      this.eligible = false;
      this.setState({
        isAvailable: false,
        status: 'idle',
        error: { code: 'unsupported', message: 'Voice Is Not Available In This Browser.' },
      });
      return false;
    }
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      this.eligibilityChecked = true;
      this.eligible = false;
      this.setState({
        isAvailable: false,
        status: 'idle',
        error: {
          code: 'insecure-context',
          message: 'Voice Needs A Secure Connection. Open Smarter Poker Over Https.',
        },
      });
      return false;
    }

    this.setState({ status: 'checking' });

    let failure: VoiceError | null = null;
    try {
      const { data: table } = await supabase
        .from('tables')
        .select('id, tournament_id')
        .eq('id', this.tableId)
        .maybeSingle();

      if (table && (table as { tournament_id?: string | null }).tournament_id) {
        failure = {
          code: 'tournament-table',
          message: 'Voice Is Available At Cash Tables Only.',
        };
      }

      if (!failure) {
        const { data: seat } = await supabase
          .from('table_seats')
          .select('seat_number')
          .eq('table_id', this.tableId)
          .eq('user_id', this.userId)
          .is('left_at', null)
          .maybeSingle();
        if (!seat) {
          failure = {
            code: 'not-seated',
            message: 'Take A Seat To Join Table Voice.',
          };
        }
      }

      if (!failure) {
        const { data: silenced, error } = await supabase.rpc('fn_table_chat_is_silenced', {
          p_table_id: this.tableId,
        });
        // Fail closed. See the doc comment above.
        if (error || silenced === true) {
          failure = {
            code: 'silenced',
            message: 'You Cannot Use Voice At This Table.',
          };
        }
      }
    } catch (e) {
      reportError(e, 'TableVoiceSession.checkEligibility');
      failure = { code: 'signalling-failed', message: 'Voice Could Not Be Checked. Try Again.' };
    }

    if (this.destroyed) return false;

    this.eligibilityChecked = true;
    this.eligible = !failure;
    this.setState({
      isAvailable: this.eligible,
      error: failure,
      status: this.state.isJoined ? this.state.status : 'idle',
    });
    return this.eligible;
  }

  // ─── join / leave ──────────────────────────────────────────────────────────

  /**
   * Open the microphone and enter the room. Never throws: every failure comes
   * back as `false` with a readable `error` on the state, because this is
   * called straight from a button handler inside React's render tree.
   */
  join(): Promise<boolean> {
    if (this.joining) return this.joining;
    if (this.state.isJoined) return Promise.resolve(true);
    this.joining = this.runJoin().finally(() => {
      this.joining = null;
    });
    return this.joining;
  }

  private async runJoin(): Promise<boolean> {
    if (this.destroyed) return false;

    const ok = await this.checkEligibility(true);
    if (!ok || this.destroyed) return false;

    this.setState({ status: 'connecting', error: null });

    // 1. The microphone. Mono on purpose: a poker table is speech, stereo
    //    doubles the bitrate for nothing, and mono is what echoCancellation is
    //    tuned for.
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
    } catch (e) {
      const err = classifyMediaError(e);
      this.setState({ status: 'idle', isJoined: false, error: err });
      return false;
    }

    if (this.destroyed) {
      this.stopLocalStream();
      return false;
    }

    // MUTED FROM THE FIRST FRAME. The track exists so the peer connections can
    // negotiate against it, and it is disabled so nothing leaves this machine
    // until the player says so. Doing it the other way round - joining hot and
    // muting a moment later - leaks whatever was said in that moment.
    this.localStream.getAudioTracks().forEach((t) => {
      t.enabled = false;
    });

    this.attachLocalMeter();

    // 2. The transport. Asked for BEFORE the signalling topic opens, because
    //    presence sync fires the instant it does and immediately starts building
    //    peer connections - a peer built before the relay credential arrived
    //    would spend its whole life on STUN. One fetch, cached, shared by every
    //    peer; a failure here is the STUN-only fallback, never a failed join.
    this.iceConfig = await fetchVoiceIceConfig();
    if (this.destroyed) {
      this.stopLocalStream();
      return false;
    }

    // 3. The signalling topic.
    const subscribed = await this.openChannel();
    if (!subscribed || this.destroyed) {
      this.stopLocalStream();
      if (!this.destroyed) {
        this.setState({
          status: 'idle',
          isJoined: false,
          error: {
            code: 'signalling-failed',
            message: 'Voice Could Not Reach The Table. Try Again.',
          },
        });
      }
      return false;
    }

    this.startLevelPolling();
    this.startSilenceWatch();
    this.setState({ isJoined: true, isMuted: true, isTransmitting: false, status: 'live' });
    return true;
  }

  /** Leave the room, close every peer, release the microphone. Idempotent. */
  leave(): void {
    this.stopLevelPolling();
    this.stopSilenceWatch();

    for (const id of Array.from(this.peers.keys())) this.closePeer(id);
    this.peers.clear();

    if (this.channel) {
      const ch = this.channel;
      this.channel = null;
      try {
        void ch.untrack?.();
      } catch {
        /* the channel may already be dead; untrack is best effort */
      }
      try {
        void supabase.removeChannel(ch);
      } catch (e) {
        reportError(e, 'TableVoiceSession.removeChannel');
      }
    }

    this.detachLocalMeter();
    this.stopLocalStream();
    this.closeAudioContext();
    this.lastLoudAt.clear();

    this.setState({
      isJoined: false,
      isMuted: true,
      isTransmitting: false,
      speakingPlayerIds: [],
      peerStates: {},
      status: 'idle',
    });
  }

  /** Terminal teardown. The session cannot be reused afterwards. */
  destroy(): void {
    if (this.destroyed) return;
    this.leave();
    this.destroyed = true;
    this.listeners.clear();
  }

  // ─── microphone ────────────────────────────────────────────────────────────

  /**
   * The mute gate. `track.enabled = false` stops the encoder sending anything
   * at all, so a muted player is silent at the WIRE, not merely silent at the
   * far end's speaker. That distinction is the whole point on a money table.
   */
  setMuted(muted: boolean): void {
    if (!this.state.isJoined || !this.localStream) {
      // Remember the intent even when there is nothing to apply it to yet.
      this.setState({ isMuted: muted, isTransmitting: false });
      return;
    }
    // A player who has been silenced mid-session cannot un-mute. `startTalking`
    // guards the same way; both exist because either can be reached first.
    if (!muted && !this.eligible) return;

    this.localStream.getAudioTracks().forEach((t) => {
      t.enabled = !muted;
    });
    if (muted) this.lastLoudAt.delete(this.userId);
    this.setState({ isMuted: muted, isTransmitting: !muted });
  }

  startTalking(): void {
    if (!this.eligible) return;
    this.setMuted(false);
  }

  stopTalking(): void {
    this.setMuted(true);
  }

  // ─── signalling ────────────────────────────────────────────────────────────

  private openChannel(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };

      let channel: RealtimeChannel;
      try {
        channel = supabase.channel(VOICE_CHANNEL_PREFIX + this.tableId, {
          config: {
            // Keyed on the user id so presence IS the peer roster, and so a
            // player with the table open twice does not appear as two peers.
            presence: { key: this.userId },
            // Never receive our own signalling frames.
            broadcast: { self: false },
          },
        });
      } catch (e) {
        reportError(e, 'TableVoiceSession.channel');
        finish(false);
        return;
      }
      this.channel = channel;

      channel.on('broadcast', { event: VOICE_SIGNAL_EVENT }, (frame: { payload?: unknown }) => {
        void this.handleSignal(frame?.payload as VoiceSignalMessage);
      });

      channel.on('presence', { event: 'sync' }, () => {
        this.syncPeersFromPresence();
      });
      channel.on('presence', { event: 'leave' }, (payload: { key?: string }) => {
        if (payload?.key && payload.key !== this.userId) this.closePeer(payload.key);
        this.publishPeerStates();
      });
      // A join is handled by the sync that follows it, so there is exactly one
      // code path that decides who is in the room.

      try {
        channel.subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            const tracked = channel.track?.({ userId: this.userId, joinedAt: Date.now() });
            if (tracked && typeof (tracked as Promise<unknown>).catch === 'function') {
              (tracked as Promise<unknown>).catch((e: unknown) =>
                reportError(e, 'TableVoiceSession.track')
              );
            }
            this.syncPeersFromPresence();
            finish(true);
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            finish(false);
          }
        });
      } catch (e) {
        reportError(e, 'TableVoiceSession.subscribe');
        finish(false);
      }
    });
  }

  private send(message: VoiceSignalMessage): void {
    const channel = this.channel;
    if (!channel) return;
    try {
      const sent = channel.send({
        type: 'broadcast',
        event: VOICE_SIGNAL_EVENT,
        payload: message,
      });
      if (sent && typeof (sent as Promise<unknown>).catch === 'function') {
        (sent as Promise<unknown>).catch((e: unknown) => reportError(e, 'TableVoiceSession.send'));
      }
    } catch (e) {
      reportError(e, 'TableVoiceSession.send');
    }
  }

  private syncPeersFromPresence(): void {
    const channel = this.channel;
    if (!channel || !this.localStream) return;

    let ids: string[] = [];
    try {
      const state = channel.presenceState?.() ?? {};
      ids = Object.keys(state).filter((id) => id && id !== this.userId);
    } catch (e) {
      reportError(e, 'TableVoiceSession.presenceState');
      return;
    }

    // Anyone who vanished from presence without a leave event.
    for (const existing of Array.from(this.peers.keys())) {
      if (!ids.includes(existing)) this.closePeer(existing);
    }

    for (const id of ids) {
      if (this.peers.size >= MAX_VOICE_PEERS && !this.peers.has(id)) continue;
      this.ensurePeer(id);
    }
    this.publishPeerStates();
  }

  private async handleSignal(msg: VoiceSignalMessage | undefined): Promise<void> {
    if (!msg || msg.to !== this.userId || !msg.from || msg.from === this.userId) return;
    if (!this.localStream) return;

    const peer = this.ensurePeer(msg.from);
    if (!peer) return;
    const { pc } = peer;

    try {
      if (msg.kind === 'offer') {
        const description = msg.data as RTCSessionDescriptionInit;
        // Perfect-negotiation glare handling. Both sides can only reach here
        // simultaneously if presence sync raced; the polite side (the higher
        // id) yields, the impolite side ignores the incoming offer and keeps
        // its own. Without this the pair can wedge in have-local-offer forever.
        const collision = peer.makingOffer || pc.signalingState !== 'stable';
        if (collision && !peer.polite) return;
        await pc.setRemoteDescription(description);
        await this.drainCandidates(peer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send({ from: this.userId, to: msg.from, kind: 'answer', data: answer });
      } else if (msg.kind === 'answer') {
        if (pc.signalingState === 'stable') return; // A duplicate answer; harmless.
        await pc.setRemoteDescription(msg.data as RTCSessionDescriptionInit);
        await this.drainCandidates(peer);
      } else if (msg.kind === 'ice') {
        const candidate = msg.data as RTCIceCandidateInit;
        if (!candidate) return;
        // ICE routinely arrives before the description that gives it meaning.
        if (!pc.remoteDescription) {
          peer.pendingCandidates.push(candidate);
          return;
        }
        await pc.addIceCandidate(candidate);
      }
    } catch (e) {
      reportError(e, `TableVoiceSession.handleSignal.${msg.kind}`);
    }
  }

  private async drainCandidates(peer: PeerRecord): Promise<void> {
    if (peer.pendingCandidates.length === 0) return;
    const queued = peer.pendingCandidates.splice(0, peer.pendingCandidates.length);
    for (const candidate of queued) {
      try {
        await peer.pc.addIceCandidate(candidate);
      } catch (e) {
        reportError(e, 'TableVoiceSession.drainCandidates');
      }
    }
  }

  // ─── the mesh ──────────────────────────────────────────────────────────────

  private ensurePeer(peerId: string): PeerRecord | null {
    const existing = this.peers.get(peerId);
    if (existing && !existing.closed) return existing;
    if (!this.localStream) return null;

    const initiator = shouldInitiateOffer(this.userId, peerId);

    let pc: RTCPeerConnection;
    try {
      // The list and the policy both come from the engine (see fetchVoiceIceConfig).
      // `iceTransportPolicy: 'relay'` is what stops this peer's real address ever
      // appearing in a candidate the other player can read.
      pc = new RTCPeerConnection({
        iceServers: this.iceConfig.iceServers,
        iceTransportPolicy: this.iceConfig.iceTransportPolicy,
      });
    } catch (e) {
      reportError(e, 'TableVoiceSession.RTCPeerConnection');
      return null;
    }

    const peer: PeerRecord = {
      id: peerId,
      pc,
      polite: !initiator,
      makingOffer: false,
      pendingCandidates: [],
      audio: null,
      meter: null,
      retries: existing?.retries ?? 0,
      retryTimer: null,
      graceTimer: null,
      closed: false,
    };
    this.peers.set(peerId, peer);

    for (const track of this.localStream.getAudioTracks()) {
      try {
        pc.addTrack(track, this.localStream);
      } catch (e) {
        reportError(e, 'TableVoiceSession.addTrack');
      }
    }

    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (!event.candidate) return;
      this.send({
        from: this.userId,
        to: peerId,
        kind: 'ice',
        data: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
      });
    };

    pc.ontrack = (event: RTCTrackEvent) => {
      const stream = event.streams?.[0];
      if (!stream) return;
      this.attachRemoteAudio(peer, stream);
    };

    pc.onconnectionstatechange = () => {
      this.onPeerConnectionState(peer);
    };

    // Only the impolite side offers, so exactly one offer exists per pair.
    if (initiator) {
      pc.onnegotiationneeded = () => {
        void this.makeOffer(peer);
      };
      // Some engines do not fire negotiationneeded for tracks added before the
      // handler was attached, so drive the first offer explicitly. `makeOffer`
      // is guarded, and a second call is a no-op.
      void this.makeOffer(peer);
    }

    this.setPeerState(peerId, 'connecting');
    return peer;
  }

  private async makeOffer(peer: PeerRecord): Promise<void> {
    if (peer.closed || peer.makingOffer) return;
    if (peer.pc.signalingState !== 'stable') return;
    peer.makingOffer = true;
    try {
      const offer = await peer.pc.createOffer();
      if (peer.closed) return;
      await peer.pc.setLocalDescription(offer);
      this.send({ from: this.userId, to: peer.id, kind: 'offer', data: offer });
    } catch (e) {
      reportError(e, 'TableVoiceSession.makeOffer');
    } finally {
      peer.makingOffer = false;
    }
  }

  private onPeerConnectionState(peer: PeerRecord): void {
    if (peer.closed) return;
    const state = peer.pc.connectionState;

    if (peer.graceTimer && state !== 'disconnected') {
      clearTimeout(peer.graceTimer);
      peer.graceTimer = null;
    }

    if (state === 'connected') {
      peer.retries = 0;
      this.setPeerState(peer.id, 'connected');
      return;
    }
    if (state === 'connecting' || state === 'new') {
      this.setPeerState(peer.id, 'connecting');
      return;
    }
    if (state === 'disconnected') {
      this.setPeerState(peer.id, 'disconnected');
      // Wifi to LTE handovers land here and usually recover on their own.
      if (!peer.graceTimer) {
        peer.graceTimer = setTimeout(() => {
          peer.graceTimer = null;
          if (!peer.closed && peer.pc.connectionState === 'disconnected') this.retryPeer(peer);
        }, DISCONNECT_GRACE_MS);
      }
      return;
    }
    if (state === 'failed') {
      this.retryPeer(peer);
      return;
    }
    if (state === 'closed') {
      this.setPeerState(peer.id, 'closed');
    }
  }

  /**
   * Bounded retry, then an honest failure.
   *
   * A silent dead microphone is the worst outcome here: the player believes
   * they are talking to the table and nobody can hear them. After three
   * attempts this stops trying and SAYS SO, because on a mesh with no TURN
   * relay the overwhelmingly likely cause is a symmetric NAT that no number of
   * further attempts will get through.
   */
  private retryPeer(peer: PeerRecord): void {
    if (peer.closed || peer.retryTimer) return;
    const peerId = peer.id;

    if (peer.retries >= MAX_PEER_RETRIES) {
      this.setPeerState(peerId, 'failed');
      this.setState({
        error: {
          code: 'connection-failed',
          message: 'Could Not Connect To A Player. Their Network Is Blocking Voice.',
        },
      });
      return;
    }

    const attempt = peer.retries + 1;
    const delay = PEER_RETRY_BASE_MS * 2 ** peer.retries;
    peer.retries = attempt;
    this.setPeerState(peerId, 'connecting');

    peer.retryTimer = setTimeout(() => {
      peer.retryTimer = null;
      if (peer.closed || this.destroyed) return;
      // Full rebuild rather than restartIce: a connection that reached `failed`
      // has already exhausted its candidate pairs, and a fresh negotiation also
      // recovers from a peer that reloaded the page.
      const retries = peer.retries;
      this.closePeer(peerId, { keepState: true });
      const rebuilt = this.ensurePeer(peerId);
      if (rebuilt) rebuilt.retries = retries;
    }, delay);
  }

  private closePeer(peerId: string, opts: { keepState?: boolean } = {}): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.closed = true;
    if (peer.retryTimer) clearTimeout(peer.retryTimer);
    if (peer.graceTimer) clearTimeout(peer.graceTimer);

    try {
      peer.pc.onicecandidate = null;
      peer.pc.ontrack = null;
      peer.pc.onconnectionstatechange = null;
      peer.pc.onnegotiationneeded = null;
      peer.pc.close();
    } catch (e) {
      reportError(e, 'TableVoiceSession.closePeer');
    }

    if (peer.audio) {
      try {
        peer.audio.pause();
        peer.audio.srcObject = null;
      } catch {
        /* the element may already be detached */
      }
      peer.audio = null;
    }
    this.disconnectMeter(peer.meter);
    peer.meter = null;

    this.peers.delete(peerId);
    this.lastLoudAt.delete(peerId);

    if (!opts.keepState) {
      const peerStates = { ...this.state.peerStates };
      delete peerStates[peerId];
      this.setState({ peerStates });
    }
  }

  private setPeerState(peerId: string, state: VoicePeerState): void {
    if (this.state.peerStates[peerId] === state) return;
    this.setState({ peerStates: { ...this.state.peerStates, [peerId]: state } });
  }

  private publishPeerStates(): void {
    const peerStates: Record<string, VoicePeerState> = {};
    for (const [id, peer] of this.peers) {
      peerStates[id] = this.state.peerStates[id] ?? (peer.pc.connectionState as VoicePeerState);
    }
    if (!shallowEqual(peerStates, this.state.peerStates)) this.setState({ peerStates });
  }

  // ─── audio playback + who is talking ───────────────────────────────────────

  private attachRemoteAudio(peer: PeerRecord, stream: MediaStream): void {
    if (typeof document === 'undefined') return;
    if (!peer.audio) {
      const el = document.createElement('audio');
      el.autoplay = true;
      // Never render it: this element exists to play, not to be seen.
      el.style.display = 'none';
      (el as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
      peer.audio = el;
      try {
        document.body.appendChild(el);
      } catch {
        /* no body (SSR-ish harness): the element still plays when attached */
      }
    }
    try {
      peer.audio.srcObject = stream;
      const played = peer.audio.play?.();
      if (played && typeof played.catch === 'function') {
        // Autoplay policy can refuse until a gesture. Joining voice IS a
        // gesture, so this is rare, and a refusal must not break the mesh.
        played.catch(() => {});
      }
    } catch (e) {
      reportError(e, 'TableVoiceSession.attachRemoteAudio');
    }

    this.disconnectMeter(peer.meter);
    peer.meter = this.buildMeter(stream);
  }

  private getAudioContext(): AudioContext | null {
    if (this.audioCtx) return this.audioCtx;
    const Ctor =
      typeof window !== 'undefined'
        ? (
            window as unknown as {
              AudioContext?: typeof AudioContext;
              webkitAudioContext?: typeof AudioContext;
            }
          ).AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!Ctor) return null;
    try {
      this.audioCtx = new Ctor();
    } catch (e) {
      reportError(e, 'TableVoiceSession.AudioContext');
      return null;
    }
    return this.audioCtx;
  }

  private buildMeter(stream: MediaStream): LevelMeter | null {
    const ctx = this.getAudioContext();
    if (!ctx || typeof ctx.createAnalyser !== 'function') return null;
    try {
      const analyser = ctx.createAnalyser();
      // 512 samples at 48kHz is about 10ms of audio: long enough for a stable
      // RMS, short enough that the indicator tracks speech rather than lagging.
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
      return { analyser, source, data: new Uint8Array(analyser.fftSize) };
    } catch (e) {
      reportError(e, 'TableVoiceSession.buildMeter');
      return null;
    }
  }

  private attachLocalMeter(): void {
    if (!this.localStream) return;
    this.detachLocalMeter();
    this.localMeter = this.buildMeter(this.localStream);
  }

  private detachLocalMeter(): void {
    this.disconnectMeter(this.localMeter);
    this.localMeter = null;
  }

  private disconnectMeter(meter: LevelMeter | null): void {
    if (!meter) return;
    try {
      meter.source.disconnect();
      meter.analyser.disconnect();
    } catch {
      /* already torn down with its context */
    }
  }

  private startLevelPolling(): void {
    if (this.levelTimer) return;
    this.levelTimer = setInterval(() => this.sampleLevels(), LEVEL_POLL_MS);
  }

  private stopLevelPolling(): void {
    if (!this.levelTimer) return;
    clearInterval(this.levelTimer);
    this.levelTimer = null;
  }

  private sampleLevels(): void {
    const now = Date.now();

    // The local player counts as speaking only while actually transmitting.
    // Metering a disabled track would light the hero's own seat while muted,
    // which is the exact opposite of the reassurance the indicator is for.
    if (this.localMeter && !this.state.isMuted) {
      if (this.readLevel(this.localMeter) >= SPEAKING_RMS_THRESHOLD) {
        this.lastLoudAt.set(this.userId, now);
      }
    } else {
      this.lastLoudAt.delete(this.userId);
    }

    for (const peer of this.peers.values()) {
      if (!peer.meter) continue;
      if (this.readLevel(peer.meter) >= SPEAKING_RMS_THRESHOLD) {
        this.lastLoudAt.set(peer.id, now);
      }
    }

    const speaking: string[] = [];
    for (const [id, at] of this.lastLoudAt) {
      if (now - at <= SPEAKING_HOLD_MS) speaking.push(id);
      else this.lastLoudAt.delete(id);
    }
    this.setState({ speakingPlayerIds: speaking });
  }

  private readLevel(meter: LevelMeter): number {
    try {
      meter.analyser.getByteTimeDomainData(meter.data);
      return rmsFromTimeDomain(meter.data);
    } catch {
      return 0;
    }
  }

  // ─── mid-session silencing ─────────────────────────────────────────────────

  /**
   * A host can mute a player while they are already in the room. Nothing pushes
   * that fact to the browser, so the only honest option is to ask again, and the
   * only correct response is to close the microphone immediately rather than at
   * the end of the session.
   */
  private startSilenceWatch(): void {
    if (this.silenceTimer) return;
    this.silenceTimer = setInterval(() => {
      void (async () => {
        if (!this.state.isJoined) return;
        const ok = await this.checkEligibility(true);
        if (!ok && this.state.isJoined) {
          this.setMuted(true);
          this.leave();
        }
      })();
    }, SILENCE_RECHECK_MS);
  }

  private stopSilenceWatch(): void {
    if (!this.silenceTimer) return;
    clearInterval(this.silenceTimer);
    this.silenceTimer = null;
  }

  // ─── plumbing ──────────────────────────────────────────────────────────────

  private stopLocalStream(): void {
    if (!this.localStream) return;
    this.localStream.getTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* an already-ended track throws on some engines */
      }
    });
    this.localStream = null;
  }

  private closeAudioContext(): void {
    if (!this.audioCtx) return;
    const ctx = this.audioCtx;
    this.audioCtx = null;
    try {
      const closed = ctx.close?.();
      if (closed && typeof closed.catch === 'function') closed.catch(() => {});
    } catch {
      /* already closed */
    }
  }
}

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REFCOUNTED REGISTRY — one mesh per table, however many things are watching
// ═══════════════════════════════════════════════════════════════════════════════

interface Entry {
  session: TableVoiceSession;
  refs: number;
}

const registry = new Map<string, Entry>();

const keyOf = (tableId: string, userId: string) => `${tableId}|${userId}`;

/**
 * Take a reference to this table's voice session, creating it if nobody holds
 * one yet. Call the returned release exactly once; the session is destroyed
 * when the last holder lets go.
 */
export function acquireVoiceSession(
  tableId: string,
  userId: string
): { session: TableVoiceSession; release: () => void } {
  const key = keyOf(tableId, userId);
  let entry = registry.get(key);
  if (!entry) {
    entry = { session: new TableVoiceSession(tableId, userId), refs: 0 };
    registry.set(key, entry);
  }
  entry.refs++;

  let released = false;
  return {
    session: entry.session,
    release: () => {
      if (released) return;
      released = true;
      const current = registry.get(key);
      if (!current) return;
      current.refs--;
      if (current.refs <= 0) {
        registry.delete(key);
        current.session.destroy();
      }
    },
  };
}

/** Test seam: drop every session. Never called by application code. */
export function __resetVoiceRegistry(): void {
  for (const entry of registry.values()) entry.session.destroy();
  registry.clear();
}
