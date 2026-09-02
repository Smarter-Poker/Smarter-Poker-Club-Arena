/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TURN REST CREDENTIALS — the coturn `use-auth-secret` derivation, and nothing else
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS FILE EXISTS AT ALL
 * ───────────────────────────
 * Table voice shipped on 2026-08-27 as a peer-to-peer WebRTC audio mesh with
 * PUBLIC STUN ONLY (see `src/services/VoiceSignalService.ts`). That has two
 * consequences, and neither is cosmetic:
 *
 *   1. STUN cannot traverse a SYMMETRIC NAT. Most mobile carrier networks are
 *      symmetric. Those players do not get degraded audio, they get NO audio -
 *      ICE exhausts its candidate pairs and the connection reaches `failed`.
 *   2. A p2p mesh hands every participant's PUBLIC IP ADDRESS to every other
 *      participant, because that is what an ICE candidate is. At a real-money
 *      table full of strangers that is a collusion and harassment surface, not
 *      a networking detail.
 *
 * A TURN relay closes both: a relayed candidate carries the RELAY's address, so
 * the peer's own address never leaves the relay, and a relay is reachable from
 * behind any NAT because the client opens the connection outbound.
 *
 * WHAT THIS FILE IS
 * ─────────────────
 * The credential derivation, the ICE-server list assembly, and the env reading -
 * all PURE. No HTTP, no Supabase, no `console`. That separation is deliberate:
 * the HTTP handler in `../handlers/voice.ts` imports the real authenticator and
 * therefore the whole Supabase client, and none of this arithmetic should need a
 * database to be tested.
 *
 * THE SCHEME (coturn `use-auth-secret`, a.k.a. the TURN REST API,
 * draft-uberti-behave-turn-rest-00)
 * ──────────────────────────────────────────────────────────────────────────────
 *
 *     username   = "<unix-expiry-timestamp>:<userId>"
 *     credential = base64( HMAC-SHA1( username, static-auth-secret ) )
 *
 * The relay stores NO user records. It recomputes that HMAC from the username it
 * is handed and its own copy of the secret, and it refuses the allocation if the
 * timestamp has passed. So the credential is self-describing and self-expiring,
 * and the engine can mint one per player without ever telling coturn anybody
 * exists.
 *
 * SHA-1 IS CORRECT HERE AND IS NOT A SECURITY DEFECT. This is HMAC-SHA1, whose
 * security rests on the secret and not on SHA-1's collision resistance, and the
 * algorithm is fixed by what coturn computes on the other side. Changing it to
 * SHA-256 does not make anything stronger; it makes every credential invalid.
 *
 * THE SECRET NEVER LEAVES THE SERVER. It is read from the environment, used to
 * compute one HMAC, and the HMAC is what goes over the wire. It must never be
 * written into source, into a test fixture, into a client bundle, or into a log
 * line. `tests/unit/voiceIceCredentials.test.ts` asserts the client half of that
 * by reading the client source and failing if the env name appears in it.
 */

import { createHmac } from 'crypto';

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Default credential lifetime: four hours.
 *
 * The tension is real in both directions. Too SHORT and a player who joins
 * voice, plays a long session and reconnects mid-session gets a credential the
 * relay has already stopped honouring, so voice dies for no visible reason. Too
 * LONG and a credential lifted from a browser's memory is an anonymous relay
 * allocation for that whole window, billed to us.
 *
 * Four hours covers a poker session comfortably while keeping a leaked
 * credential from being worth passing around. The runbook
 * (`docs/voice-turn-relay.md`) documents the knob; `TURN_CREDENTIAL_TTL_SECONDS`
 * sets it, clamped below.
 */
export const DEFAULT_TURN_TTL_SECONDS = 4 * 60 * 60;

/** Never shorter than this: below it a slow join can outlive its own credential. */
export const MIN_TURN_TTL_SECONDS = 5 * 60;

/** Never longer than this, whatever the env says. A day-long credential is a key. */
export const MAX_TURN_TTL_SECONDS = 12 * 60 * 60;

/** Default relay port. coturn's `listening-port`; the install script sets 3478. */
export const DEFAULT_TURN_PORT = 3478;

/**
 * Public STUN, kept even when TURN is configured.
 *
 * Two providers, because one operator having a bad afternoon should not take
 * voice down for the platform. They only report the public address a peer is
 * reachable at; they relay nothing. When the transport policy is `relay` the
 * browser ignores them for candidate GATHERING, and they cost nothing to send.
 */
export const DEFAULT_STUN_URLS: readonly string[] = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/** One entry of the list handed to `new RTCPeerConnection({ iceServers })`. */
export interface IceServerEntry {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * `relay` forces every media path through the TURN relay, so no peer ever learns
 * another peer's address. `all` prefers a direct path and leaks addresses. The
 * choice is argued at `resolveTransportPolicy` below.
 */
export type IceTransportPolicy = 'all' | 'relay';

/** The credential pair a client presents to the relay. */
export interface TurnCredential {
  /** `<unix-expiry>:<userId>` — coturn parses the expiry straight out of this. */
  username: string;
  /** base64(HMAC-SHA1(username, secret)). */
  credential: string;
  /** Unix SECONDS at which the relay stops honouring it. */
  expiresAt: number;
}

/** What `/voice/ice` answers with. The client mirrors this shape. */
export interface VoiceIceResponse {
  iceServers: IceServerEntry[];
  iceTransportPolicy: IceTransportPolicy;
  /** False means STUN-only: no relay is configured, and voice runs as it did. */
  turn: boolean;
  /** Unix SECONDS the TURN credential dies, or null when there is no TURN. */
  expiresAt: number | null;
  /** Seconds the client may cache this before asking again. */
  ttlSeconds: number;
}

/** The relay-shaped half of the environment, already validated. */
export interface TurnEnvConfig {
  /** Present only when a relay is fully configured (secret AND at least one url). */
  secret: string | null;
  turnUrls: string[];
  stunUrls: string[];
  ttlSeconds: number;
  /** An explicit operator override, or null to let the code decide. */
  policyOverride: IceTransportPolicy | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DERIVATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Mint one short-lived TURN credential for one player.
 *
 * `nowMs` is injected rather than read from the clock so the expiry arithmetic
 * can be pinned by a test without freezing timers for the whole file.
 */
export function buildTurnCredential(
  userId: string,
  secret: string,
  ttlSeconds: number = DEFAULT_TURN_TTL_SECONDS,
  nowMs: number = Date.now()
): TurnCredential {
  const expiresAt = Math.floor(nowMs / 1000) + clampTtl(ttlSeconds);
  const username = `${expiresAt}:${userId}`;
  return {
    username,
    credential: createHmac('sha1', secret).update(username).digest('base64'),
    expiresAt,
  };
}

/**
 * The check coturn performs, mirrored here.
 *
 * Nothing in the request path calls this - the relay is the authority, and a
 * second copy of an authority is a way to disagree with it. It exists so the
 * tests can prove the derivation is the one coturn will accept, and so an
 * operator debugging a refused allocation can reproduce the verdict without
 * shelling into the relay.
 *
 * Order matters: EXPIRY is checked before the HMAC, exactly as coturn does, so
 * an expired-but-well-formed credential reports `expired` rather than the
 * misleading `bad-signature`.
 */
export function verifyTurnCredential(
  username: string,
  credential: string,
  secret: string,
  nowMs: number = Date.now()
): { ok: boolean; reason?: 'malformed' | 'expired' | 'bad-signature' } {
  const separator = username.indexOf(':');
  if (separator <= 0) return { ok: false, reason: 'malformed' };

  const expiry = Number(username.slice(0, separator));
  if (!Number.isFinite(expiry) || !Number.isInteger(expiry)) {
    return { ok: false, reason: 'malformed' };
  }
  if (expiry * 1000 <= nowMs) return { ok: false, reason: 'expired' };

  const expected = createHmac('sha1', secret).update(username).digest('base64');
  if (expected !== credential) return { ok: false, reason: 'bad-signature' };
  return { ok: true };
}

/** Pull the userId back out of a REST username. Null when it is not one. */
export function userIdFromTurnUsername(username: string): string | null {
  const separator = username.indexOf(':');
  if (separator <= 0 || separator === username.length - 1) return null;
  return username.slice(separator + 1);
}

function clampTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds)) return DEFAULT_TURN_TTL_SECONDS;
  return Math.min(MAX_TURN_TTL_SECONDS, Math.max(MIN_TURN_TTL_SECONDS, Math.floor(ttlSeconds)));
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENVIRONMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Read the relay configuration out of the environment.
 *
 * THE IMPORTANT PROPERTY IS THAT AN ABSENT RELAY IS NOT AN ERROR. Until a host
 * is chosen and the secret is deployed, `TURN_STATIC_AUTH_SECRET` is unset on
 * every engine, and voice must keep working EXACTLY as it does today: public
 * STUN, direct peer paths, symmetric-NAT players still unable to connect. A 500
 * here would take working wifi voice away in exchange for nothing.
 *
 * A relay counts as configured only when BOTH the secret and at least one URL
 * are present. Half a configuration mints credentials nothing can use, which is
 * worse than no configuration because it looks like it worked.
 *
 * Recognised variables (all optional):
 *   TURN_STATIC_AUTH_SECRET       the coturn `static-auth-secret`. NEVER logged.
 *   TURN_URLS                     comma-separated, e.g.
 *                                 "turn:relay.example:3478?transport=udp,turn:relay.example:3478?transport=tcp"
 *   TURN_HOST / TURN_PORT         convenience: builds the udp+tcp pair above.
 *                                 Ignored when TURN_URLS is set.
 *   TURN_CREDENTIAL_TTL_SECONDS   credential lifetime, clamped 5m..12h.
 *   VOICE_STUN_URLS               comma-separated override for the STUN list.
 *   VOICE_ICE_TRANSPORT_POLICY    "relay" | "all". The operator escape hatch.
 */
export function readTurnEnv(env: NodeJS.ProcessEnv = process.env): TurnEnvConfig {
  const rawSecret = (env.TURN_STATIC_AUTH_SECRET || '').trim();

  const explicitUrls = splitList(env.TURN_URLS);
  const turnUrls = explicitUrls.length > 0 ? explicitUrls : turnUrlsFromHost(env);

  const stunOverride = splitList(env.VOICE_STUN_URLS);
  const stunUrls = stunOverride.length > 0 ? stunOverride : [...DEFAULT_STUN_URLS];

  const ttlRaw = Number(env.TURN_CREDENTIAL_TTL_SECONDS);
  const ttlSeconds = clampTtl(Number.isFinite(ttlRaw) ? ttlRaw : DEFAULT_TURN_TTL_SECONDS);

  const policyRaw = (env.VOICE_ICE_TRANSPORT_POLICY || '').trim().toLowerCase();
  const policyOverride: IceTransportPolicy | null =
    policyRaw === 'relay' || policyRaw === 'all' ? policyRaw : null;

  // Half a relay is not a relay.
  const configured = rawSecret.length > 0 && turnUrls.length > 0;

  return {
    secret: configured ? rawSecret : null,
    turnUrls: configured ? turnUrls : [],
    stunUrls,
    ttlSeconds,
    policyOverride,
  };
}

function turnUrlsFromHost(env: NodeJS.ProcessEnv): string[] {
  const host = (env.TURN_HOST || '').trim();
  if (!host) return [];
  const portRaw = Number(env.TURN_PORT);
  const port = Number.isInteger(portRaw) && portRaw > 0 ? portRaw : DEFAULT_TURN_PORT;
  // UDP first (lower latency, what almost every client will use), TCP second so
  // a network that blocks UDP outright still has a path.
  return [`turn:${host}:${port}?transport=udp`, `turn:${host}:${port}?transport=tcp`];
}

function splitList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════════
// THE ANSWER
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * THE TRANSPORT POLICY DECISION, WHICH IS A PRIVACY DECISION.
 *
 * `all` (the browser default) tries the direct path first. It is cheaper - no
 * relay bandwidth at all when both peers are reachable - and it degrades
 * gracefully, because a dead relay just means the direct path is the only one.
 * It also means every player at the table learns every other player's public IP
 * address, since that is literally what a host/srflx candidate contains.
 *
 * `relay` forces all media through the relay. Every candidate a peer sees
 * belongs to the RELAY, so nobody learns anybody's address. It costs relay
 * bandwidth for every stream, and if the relay is down there is no other path,
 * so voice fails rather than degrading.
 *
 * WE CHOOSE `relay` WHENEVER A RELAY EXISTS. These are strangers playing for
 * money. An IP address identifies a household, geolocates to a town, and is the
 * first step of both the collusion question ("are seats 3 and 7 in the same
 * flat?") and the harassment one. That is not a cost worth trading for
 * bandwidth, and it is not a cost the player can see, consent to, or undo once
 * it has happened. Voice is a convenience; the address leak is permanent.
 *
 * `all` remains the answer when there is NO relay - forcing `relay` with nothing
 * to relay through would mean voice for nobody, which is strictly worse than
 * today.
 *
 * AND THE DOWNGRADE IS DELIBERATELY NOT AUTOMATIC. It would be easy to have the
 * client retry with `all` after the relay-only mesh fails, and that is exactly
 * the wrong thing: it would silently trade away the privacy property at the
 * precise moment nobody is watching. If the relay dies, voice fails honestly
 * (the mesh already surfaces `connection-failed` rather than a dead microphone)
 * and an operator flips `VOICE_ICE_TRANSPORT_POLICY=all` - one env var, one
 * deploy, a decision a human made on purpose and can explain.
 */
export function resolveTransportPolicy(config: TurnEnvConfig): IceTransportPolicy {
  if (config.policyOverride) {
    // An operator asking for `relay` with no relay configured would silence
    // voice for everybody. Refuse that particular override; honour every other.
    if (config.policyOverride === 'relay' && !config.secret) return 'all';
    return config.policyOverride;
  }
  return config.secret ? 'relay' : 'all';
}

/**
 * Build the complete answer for one player.
 *
 * With no relay configured this is the STUN-only list the client already had
 * hardcoded, `turn: false`, and policy `all` - byte-for-byte today's behaviour,
 * arrived at through the new path.
 */
export function buildVoiceIceResponse(
  userId: string,
  config: TurnEnvConfig,
  nowMs: number = Date.now()
): VoiceIceResponse {
  const iceServers: IceServerEntry[] = config.stunUrls.map((urls) => ({ urls }));
  const policy = resolveTransportPolicy(config);

  if (!config.secret || config.turnUrls.length === 0) {
    return {
      iceServers,
      iceTransportPolicy: policy,
      turn: false,
      expiresAt: null,
      ttlSeconds: config.ttlSeconds,
    };
  }

  const cred = buildTurnCredential(userId, config.secret, config.ttlSeconds, nowMs);
  // One entry carrying every url: the browser gathers relay candidates from all
  // of them under the same credential, which is what the spec's `urls` array is
  // for and is fewer objects than one entry per transport.
  iceServers.push({
    urls: config.turnUrls,
    username: cred.username,
    credential: cred.credential,
  });

  return {
    iceServers,
    iceTransportPolicy: policy,
    turn: true,
    expiresAt: cred.expiresAt,
    ttlSeconds: config.ttlSeconds,
  };
}
