/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TURN CREDENTIALS — the derivation, the gate, and the fallback
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Table voice is a p2p WebRTC mesh on public STUN. That fails outright behind a
 * symmetric NAT (most mobile carriers) and it hands every player's public IP
 * address to every other player at the table. A TURN relay fixes both. This
 * suite covers the repo-side half of that relay: the credential the engine mints
 * for it, the gate in front of the mint, and what happens on every engine that
 * has no relay configured - which is all of them until one is deployed.
 *
 * WHAT IS ACTUALLY PINNED HERE
 * ────────────────────────────
 *  - the HMAC matches the published TURN REST vector, byte for byte, so a
 *    credential this engine mints is one coturn will accept;
 *  - the username carries a FUTURE expiry, and an expired one is refused;
 *  - the endpoint refuses an unauthenticated caller, because an open credential
 *    mint is an open relay billed to us;
 *  - with no secret set the endpoint answers 200 STUN-only, never a 500, so
 *    voice keeps working exactly as it does today;
 *  - the client falls back to STUN when the fetch fails;
 *  - no secret literal is reachable from client source.
 *
 * WHAT IT CANNOT PROVE. That a real coturn accepts a real allocation. That needs
 * a relay host, which has not been chosen yet; `scripts/install-turn-relay.sh`
 * ends with a `turnutils_uclient` allocation against live credentials, and that
 * is the check which closes this gap.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  buildTurnCredential,
  verifyTurnCredential,
  userIdFromTurnUsername,
  readTurnEnv,
  resolveTransportPolicy,
  buildVoiceIceResponse,
  DEFAULT_STUN_URLS,
  MIN_TURN_TTL_SECONDS,
  MAX_TURN_TTL_SECONDS,
} from '../../server/src/voice/turnCredentials';

// ═══════════════════════════════════════════════════════════════════════════════
// THE DERIVATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('the credential is the one coturn will recompute', () => {
  /**
   * The worked example from draft-uberti-behave-turn-rest-00, which is the
   * document coturn's `use-auth-secret` implements. A vector rather than a
   * round-trip on purpose: a test that hashes with the same helper it is testing
   * proves only that the helper is consistent with itself, and would happily
   * pass with SHA-256, with the wrong argument order, or with hex instead of
   * base64 - each of which produces a credential the relay silently refuses.
   */
  it('matches the published TURN REST vector', () => {
    const username = '12334939:mbzrxpgjys';
    const derived = createHmac('sha1', 'north').update(username).digest('base64');
    expect(derived).toBe('Iq7YXkRon8YXJfdN1Ke9EZOw1UE=');
  });

  it('builds username and password exactly that way', () => {
    const nowMs = 1_800_000_000_000;
    const secret = 'a-test-secret-not-a-real-one';
    const userId = '11111111-2222-3333-4444-555555555555';

    const cred = buildTurnCredential(userId, secret, 3600, nowMs);

    // username = <unix expiry>:<userId>
    expect(cred.username).toBe(`${1_800_000_000 + 3600}:${userId}`);
    expect(cred.expiresAt).toBe(1_800_000_000 + 3600);
    // password = base64(HMAC-SHA1(username, secret))
    expect(cred.credential).toBe(createHmac('sha1', secret).update(cred.username).digest('base64'));
    // base64 of a 20-byte SHA-1 digest is always 28 characters ending in '='.
    expect(cred.credential).toMatch(/^[A-Za-z0-9+/]{27}=$/);
  });

  it('carries an expiry in the FUTURE, and a short one', () => {
    const before = Math.floor(Date.now() / 1000);
    const cred = buildTurnCredential('user-a', 'secret-a');
    const after = Math.floor(Date.now() / 1000);

    expect(cred.expiresAt).toBeGreaterThan(after);
    // A few hours at most. A credential that outlives a session is a key.
    expect(cred.expiresAt - before).toBeLessThanOrEqual(MAX_TURN_TTL_SECONDS);
    expect(cred.expiresAt - before).toBeGreaterThanOrEqual(MIN_TURN_TTL_SECONDS);
    expect(userIdFromTurnUsername(cred.username)).toBe('user-a');
  });

  it('clamps a TTL an operator sets too long or too short', () => {
    const nowMs = 1_800_000_000_000;
    const forever = buildTurnCredential('u', 's', 60 * 60 * 24 * 30, nowMs);
    expect(forever.expiresAt - 1_800_000_000).toBe(MAX_TURN_TTL_SECONDS);

    const instant = buildTurnCredential('u', 's', 1, nowMs);
    expect(instant.expiresAt - 1_800_000_000).toBe(MIN_TURN_TTL_SECONDS);
  });
});

describe('an expired or forged credential is refused', () => {
  const secret = 'a-test-secret-not-a-real-one';
  const nowMs = 1_800_000_000_000;

  it('accepts one that is still inside its window', () => {
    const cred = buildTurnCredential('user-a', secret, 3600, nowMs);
    expect(verifyTurnCredential(cred.username, cred.credential, secret, nowMs)).toEqual({
      ok: true,
    });
  });

  it('refuses it once the clock passes the expiry', () => {
    const cred = buildTurnCredential('user-a', secret, 3600, nowMs);
    const oneSecondLate = (cred.expiresAt + 1) * 1000;
    expect(verifyTurnCredential(cred.username, cred.credential, secret, oneSecondLate)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('reports expiry BEFORE signature, the way coturn does', () => {
    // A stale credential whose HMAC is also wrong must read `expired`, not
    // `bad-signature` - otherwise every routine expiry looks like an attack.
    const cred = buildTurnCredential('user-a', secret, 3600, nowMs);
    const late = (cred.expiresAt + 1) * 1000;
    expect(verifyTurnCredential(cred.username, 'not-the-hmac', secret, late).reason).toBe(
      'expired'
    );
  });

  it('refuses a credential minted against a different secret', () => {
    const cred = buildTurnCredential('user-a', 'some-other-secret', 3600, nowMs);
    expect(verifyTurnCredential(cred.username, cred.credential, secret, nowMs)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a username that is not in REST form', () => {
    expect(verifyTurnCredential('no-colon-here', 'x', secret, nowMs).reason).toBe('malformed');
    expect(verifyTurnCredential(':user-a', 'x', secret, nowMs).reason).toBe('malformed');
    expect(verifyTurnCredential('not-a-number:user-a', 'x', secret, nowMs).reason).toBe(
      'malformed'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE ENVIRONMENT, AND WHAT AN ABSENT RELAY MEANS
// ═══════════════════════════════════════════════════════════════════════════════

describe('reading the relay configuration', () => {
  it('treats an absent secret as "no relay", not as an error', () => {
    const config = readTurnEnv({} as NodeJS.ProcessEnv);
    expect(config.secret).toBeNull();
    expect(config.turnUrls).toEqual([]);
    expect(config.stunUrls).toEqual([...DEFAULT_STUN_URLS]);
  });

  it('refuses HALF a configuration, in both directions', () => {
    // A secret with nowhere to point mints credentials nothing can use, and a
    // url with no secret mints nothing at all. Either is worse than none,
    // because either looks configured.
    expect(readTurnEnv({ TURN_STATIC_AUTH_SECRET: 'x' } as NodeJS.ProcessEnv).secret).toBeNull();
    expect(readTurnEnv({ TURN_HOST: 'relay.example' } as NodeJS.ProcessEnv).secret).toBeNull();
  });

  it('builds the udp and tcp pair from TURN_HOST', () => {
    const config = readTurnEnv({
      TURN_STATIC_AUTH_SECRET: 'x',
      TURN_HOST: 'relay.example',
    } as NodeJS.ProcessEnv);
    expect(config.turnUrls).toEqual([
      'turn:relay.example:3478?transport=udp',
      'turn:relay.example:3478?transport=tcp',
    ]);
  });

  it('lets TURN_URLS say it exactly', () => {
    const config = readTurnEnv({
      TURN_STATIC_AUTH_SECRET: 'x',
      TURN_HOST: 'ignored.example',
      TURN_URLS: 'turn:a.example:3478?transport=udp, turns:a.example:5349',
    } as NodeJS.ProcessEnv);
    expect(config.turnUrls).toEqual(['turn:a.example:3478?transport=udp', 'turns:a.example:5349']);
  });
});

describe('the transport policy is a privacy decision', () => {
  const withRelay = () =>
    readTurnEnv({
      TURN_STATIC_AUTH_SECRET: 'x',
      TURN_HOST: 'relay.example',
    } as NodeJS.ProcessEnv);

  it('forces relay whenever a relay exists, so no address leaks', () => {
    expect(resolveTransportPolicy(withRelay())).toBe('relay');
  });

  it('falls back to all when there is nothing to relay through', () => {
    // Forcing relay with no relay means voice for nobody, which is strictly
    // worse than the address exposure it would be trying to prevent.
    expect(resolveTransportPolicy(readTurnEnv({} as NodeJS.ProcessEnv))).toBe('all');
  });

  it('honours an operator override to all - the deliberate escape hatch', () => {
    const config = readTurnEnv({
      TURN_STATIC_AUTH_SECRET: 'x',
      TURN_HOST: 'relay.example',
      VOICE_ICE_TRANSPORT_POLICY: 'all',
    } as NodeJS.ProcessEnv);
    expect(resolveTransportPolicy(config)).toBe('all');
  });

  it('ignores an override to relay when no relay is configured', () => {
    const config = readTurnEnv({
      VOICE_ICE_TRANSPORT_POLICY: 'relay',
    } as NodeJS.ProcessEnv);
    expect(resolveTransportPolicy(config)).toBe('all');
  });
});

describe('the answer handed to one player', () => {
  it('is STUN-only, with no credential anywhere in it, when no relay exists', () => {
    const body = buildVoiceIceResponse('user-a', readTurnEnv({} as NodeJS.ProcessEnv));
    expect(body.turn).toBe(false);
    expect(body.expiresAt).toBeNull();
    expect(body.iceTransportPolicy).toBe('all');
    expect(body.iceServers).toEqual(DEFAULT_STUN_URLS.map((urls) => ({ urls })));
    expect(JSON.stringify(body)).not.toContain('username');
  });

  it('carries STUN, the relay, and a credential bound to THAT player', () => {
    const config = readTurnEnv({
      TURN_STATIC_AUTH_SECRET: 'a-test-secret-not-a-real-one',
      TURN_HOST: 'relay.example',
    } as NodeJS.ProcessEnv);
    const body = buildVoiceIceResponse('user-a', config, 1_800_000_000_000);

    expect(body.turn).toBe(true);
    expect(body.iceTransportPolicy).toBe('relay');

    const turnEntry = body.iceServers.find((s) => s.username);
    expect(turnEntry?.urls).toEqual(config.turnUrls);
    expect(userIdFromTurnUsername(turnEntry?.username ?? '')).toBe('user-a');
    // And it is a credential the relay would honour right now.
    expect(
      verifyTurnCredential(
        turnEntry?.username ?? '',
        turnEntry?.credential ?? '',
        'a-test-secret-not-a-real-one',
        1_800_000_000_000
      ).ok
    ).toBe(true);
  });

  it('never puts the static secret itself in the body', () => {
    const secret = 'a-test-secret-not-a-real-one';
    const config = readTurnEnv({
      TURN_STATIC_AUTH_SECRET: secret,
      TURN_HOST: 'relay.example',
    } as NodeJS.ProcessEnv);
    const body = buildVoiceIceResponse('user-a', config);
    // The whole point of the REST scheme: the client gets an HMAC, never the key.
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it('gives two different players two different credentials', () => {
    const config = readTurnEnv({
      TURN_STATIC_AUTH_SECRET: 'a-test-secret-not-a-real-one',
      TURN_HOST: 'relay.example',
    } as NodeJS.ProcessEnv);
    const a = buildVoiceIceResponse('user-a', config, 1_800_000_000_000);
    const b = buildVoiceIceResponse('user-b', config, 1_800_000_000_000);
    const credOf = (r: typeof a) => r.iceServers.find((s) => s.username)?.credential;
    // Attribution: an abusive allocation has to point at one account.
    expect(credOf(a)).not.toBe(credOf(b));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE HTTP GATE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * The handler's default authenticator is the real `authenticateRequest`, which
 * pulls in the engine's service-role Supabase client at import time and
 * complains about a missing key in a test process. Every case below injects its
 * own `authenticate`, so the real one is never called; stubbing the module keeps
 * the import graph (and the test output) clean.
 */
vi.mock('../../server/src/http/auth.js', () => ({
  authenticateRequest: async () => null,
}));

import { handleVoiceIce } from '../../server/src/handlers/voice';

/** Minimal ServerResponse capture — the shape sendJSON writes. */
function mockRes() {
  const captured: { status?: number; body?: unknown } = {};
  const res = {
    writeHead(status: number) {
      captured.status = status;
      return this;
    },
    end(body?: string) {
      captured.body = body ? JSON.parse(body) : undefined;
      return this;
    },
  };
  return { res: res as never, captured };
}

const anyReq = {} as never;

describe('GET /voice/ice is gated the way every player request is gated', () => {
  it('refuses an unauthenticated caller with 401 and mints nothing', async () => {
    const { res, captured } = mockRes();
    // An open credential mint is an open relay: anybody on the internet takes a
    // credential and proxies whatever they like at our bandwidth expense.
    await handleVoiceIce(anyReq, res, { authenticate: async () => null });

    expect(captured.status).toBe(401);
    expect(JSON.stringify(captured.body)).not.toContain('turn:');
    expect(JSON.stringify(captured.body)).not.toContain('username');
  });

  it('binds the credential to the AUTHENTICATED id, never to anything sent', async () => {
    const { res, captured } = mockRes();
    await handleVoiceIce(anyReq, res, {
      authenticate: async () => ({ userId: 'authenticated-user' }),
      env: {
        TURN_STATIC_AUTH_SECRET: 'a-test-secret-not-a-real-one',
        TURN_HOST: 'relay.example',
      } as NodeJS.ProcessEnv,
    });

    expect(captured.status).toBe(200);
    const body = captured.body as { turn: boolean; iceServers: Array<{ username?: string }> };
    expect(body.turn).toBe(true);
    const turnEntry = body.iceServers.find((s) => s.username);
    expect(userIdFromTurnUsername(turnEntry?.username ?? '')).toBe('authenticated-user');
  });

  it('answers 200 STUN-only when the secret is unset, rather than erroring', async () => {
    const { res, captured } = mockRes();
    // This is the state of EVERY engine until a relay host is chosen and
    // deployed. Voice on wifi must keep working through it untouched.
    await handleVoiceIce(anyReq, res, {
      authenticate: async () => ({ userId: 'authenticated-user' }),
      env: {} as NodeJS.ProcessEnv,
    });

    expect(captured.status).toBe(200);
    const body = captured.body as {
      turn: boolean;
      iceTransportPolicy: string;
      iceServers: Array<{ urls: string }>;
    };
    expect(body.turn).toBe(false);
    expect(body.iceTransportPolicy).toBe('all');
    expect(body.iceServers.map((s) => s.urls)).toEqual([...DEFAULT_STUN_URLS]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE CLIENT FALLBACK
// ═══════════════════════════════════════════════════════════════════════════════

const sessionToken = { value: null as string | null };

vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({
        data: { session: sessionToken.value ? { access_token: sessionToken.value } : null },
        error: null,
      }),
    },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }),
    rpc: async () => ({ data: null, error: null }),
    channel: () => ({}),
    removeChannel: () => Promise.resolve('ok'),
  },
}));

vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));

import {
  fetchVoiceIceConfig,
  __resetVoiceIceCache,
  VOICE_ICE_FALLBACK,
  VOICE_ICE_SERVERS,
  VOICE_ICE_ENDPOINT,
} from '../../src/services/VoiceSignalService';

const realFetch = globalThis.fetch;

beforeEach(() => {
  __resetVoiceIceCache();
  sessionToken.value = 'a-fake-jwt';
});

afterEach(() => {
  globalThis.fetch = realFetch;
  __resetVoiceIceCache();
});

describe('the client keeps working when the endpoint does not', () => {
  it('falls back to STUN when the fetch rejects', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const config = await fetchVoiceIceConfig();

    // Exactly what voice shipped with. A relay that cannot be reached must cost
    // voice nothing it already had.
    expect(config).toEqual(VOICE_ICE_FALLBACK);
    expect(config.iceServers).toEqual(VOICE_ICE_SERVERS);
    expect(config.iceTransportPolicy).toBe('all');
  });

  it('falls back to STUN on a non-ok response', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    expect(await fetchVoiceIceConfig()).toEqual(VOICE_ICE_FALLBACK);
  });

  it('falls back to STUN when the body carries no usable server', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ iceServers: [], turn: true, iceTransportPolicy: 'relay' }),
    })) as unknown as typeof fetch;
    // An empty list gathers no candidates at all, which is worse than STUN.
    expect(await fetchVoiceIceConfig()).toEqual(VOICE_ICE_FALLBACK);
  });

  it('does not even call the endpoint without a session', async () => {
    sessionToken.value = null;
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;

    expect(await fetchVoiceIceConfig()).toEqual(VOICE_ICE_FALLBACK);
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends the player JWT, because the mint is authenticated', async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        turn: false,
        iceTransportPolicy: 'all',
        expiresAt: null,
      }),
    }));
    globalThis.fetch = spy as unknown as typeof fetch;

    await fetchVoiceIceConfig();

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(VOICE_ICE_ENDPOINT);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer a-fake-jwt');
  });

  it('takes the relay list and the relay policy when the engine offers them', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          {
            urls: ['turn:relay.example:3478?transport=udp'],
            username: '1800003600:user-a',
            credential: 'Ca5HF4k55XSm+9I9Ckh2Hd30PhY=',
          },
        ],
        turn: true,
        iceTransportPolicy: 'relay',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    })) as unknown as typeof fetch;

    const config = await fetchVoiceIceConfig();
    expect(config.turn).toBe(true);
    // This is the setting that hides every player's address from every other.
    expect(config.iceTransportPolicy).toBe('relay');
    expect(config.iceServers).toHaveLength(2);
  });

  it('refuses to force relay when the engine says there is no relay', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        turn: false,
        // A confused or stale engine could say this. Honouring it would silence
        // voice for everyone with nothing gained.
        iceTransportPolicy: 'relay',
      }),
    })) as unknown as typeof fetch;

    expect((await fetchVoiceIceConfig()).iceTransportPolicy).toBe('all');
  });

  it('fetches ONCE per session, not once per peer', async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        turn: false,
        iceTransportPolicy: 'all',
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      }),
    }));
    globalThis.fetch = spy as unknown as typeof fetch;

    // A nine-handed table builds eight peers. Eight authenticated round-trips
    // while the player waits for the microphone is the thing being prevented.
    await Promise.all([fetchVoiceIceConfig(), fetchVoiceIceConfig(), fetchVoiceIceConfig()]);
    await fetchVoiceIceConfig();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a failure - the next join asks again', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await fetchVoiceIceConfig();

    const spy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        turn: false,
        iceTransportPolicy: 'all',
      }),
    }));
    globalThis.fetch = spy as unknown as typeof fetch;

    await fetchVoiceIceConfig();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// THE SECRET IS NOT IN THE BUNDLE
// ═══════════════════════════════════════════════════════════════════════════════

describe('the static secret never reaches the client', () => {
  const clientSources = [
    'src/services/VoiceSignalService.ts',
    'src/hooks/useTableVoice.ts',
    'src/components/table/VoiceControls.tsx',
  ];

  it('no client file names the secret env var, so Vite can never inline it', () => {
    // The REST scheme's whole value is that the browser holds an HMAC and never
    // the key. A `VITE_`-prefixed secret would be BAKED INTO THE BUNDLE and
    // served to everyone; CLAUDE.md section 1.3 forbids it for exactly this
    // reason. Reading the source is the only check that catches a future edit.
    for (const rel of clientSources) {
      const source = readFileSync(resolve(__dirname, '../..', rel), 'utf8');
      expect(source).not.toContain('TURN_STATIC_AUTH_SECRET');
      expect(source).not.toContain('static-auth-secret');
      expect(source).not.toMatch(/VITE_TURN[A-Z_]*SECRET/);
    }
  });

  it('the client never computes an HMAC of its own', () => {
    // If it did, it would need the key to do it with.
    const source = readFileSync(
      resolve(__dirname, '../..', 'src/services/VoiceSignalService.ts'),
      'utf8'
    );
    expect(source).not.toContain('createHmac');
    expect(source).not.toContain('hmac');
  });
});
