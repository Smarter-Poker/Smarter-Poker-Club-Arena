import type { Page, Request, Response } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  isLobbySelectionSave,
  isLobbySelectionRequest,
  observeLobbyPreferenceProof,
  restoreLobbyPreference,
  selectLobbyPreference,
} from '../e2e/support/lobbyPreferenceProof';

const club = 'certificate-club';
const owner = 'certificate-owner';
function exchange({
  method = 'POST',
  ownerId = owner,
  clubId = club,
  tab = 'OMAHA',
  projection = 'view_prefs',
  status = 200,
  body = { view_prefs: { tab } } as unknown,
  saveBody = undefined as unknown,
} = {}) {
  const request = {
    isNavigationRequest: () => false,
    method: () => method,
    url: () =>
      `https://example.test/rest/v1/user_lobby_filters?user_id=eq.${ownerId}&club_id=eq.${clubId}&select=${projection}`,
    postDataJSON: () =>
      saveBody === undefined
        ? { user_id: ownerId, club_id: clubId, view_prefs: { tab } }
        : saveBody,
    response: async () => response,
  } as unknown as Request;
  const response = {
    request: () => request,
    url: () => request.url(),
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => body,
  } as unknown as Response;
  return { request, response };
}

function fixture({
  status = 200,
  closeFailure = false,
  responseMode = 'normal',
  clickFailure = false,
  clickDelayMs = 0,
  requestDelayMs = 0,
} = {}) {
  const emitter = new EventEmitter();
  const frame = {};
  const events: string[] = [];
  let selected = 'PLO';
  let postOwner = owner;
  const page = {
    on: emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
    mainFrame: () => frame,
    waitForRequest: (predicate: (r: Request) => boolean, options: { timeout: number }) =>
      new Promise<Request>((resolve, reject) => {
        const timer = setTimeout(() => {
          emitter.off('request', handle);
          reject(new Error('Preference request timeout'));
        }, options.timeout);
        const handle = (r: Request) => {
          if (predicate(r)) {
            clearTimeout(timer);
            emitter.off('request', handle);
            resolve(r);
          }
        };
        emitter.on('request', handle);
      }),
    getByRole: () => ({
      waitFor: async () => {},
      getAttribute: async () => 'true',
      getByRole: (_role: string, options: { selected?: boolean; name?: string }) => ({
        textContent: async () => (options.selected ? selected : options.name),
        getAttribute: async () => (selected === options.name ? 'true' : 'false'),
        click: async () => {
          events.push('click');
          if (clickFailure) {
            await new Promise((resolve) => setTimeout(resolve, 30_000));
            throw new Error('Click timeout: header intercepts pointer events');
          }
          if (clickDelayMs) await new Promise((resolve) => setTimeout(resolve, clickDelayMs));
          selected = options.name!;
          const value = exchange({
            ownerId: postOwner,
            tab: selected === 'MTT' ? 'MTT' : 'OMAHA',
            status,
          });
          if (responseMode !== 'normal') {
            value.request.response = () =>
              responseMode === 'null' ? Promise.resolve(null) : new Promise(() => {});
          }
          const send = () => {
            emitter.emit('request', value.request);
            emitter.emit('response', value.response);
          };
          if (requestDelayMs) setTimeout(send, requestDelayMs);
          else send();
        },
      }),
    }),
    evaluate: async () => ({
      target: { x: 1, y: 2, width: 40, height: 20 },
      hit: { tag: 'HEADER', role: 'banner' },
    }),
    close: async () => {
      events.push('close');
      if (closeFailure) throw new Error('close failed');
    },
  } as unknown as Page;
  const proof = observeLobbyPreferenceProof(page, club);
  const read = (options: Parameters<typeof exchange>[0] = {}) => {
    const value = exchange({ method: 'GET', ...options });
    emitter.emit('request', value.request);
    emitter.emit('response', value.response);
    return value;
  };
  const navigate = () =>
    emitter.emit('request', {
      isNavigationRequest: () => true,
      frame: () => frame,
      url: () => 'https://example.test/lobby',
      method: () => 'GET',
    });
  return {
    page,
    proof,
    events,
    read,
    navigate,
    requestListeners: () => emitter.listenerCount('request'),
    setPostOwner: (value: string) => {
      postOwner = value;
    },
  };
}

describe('cold-return preference proof', () => {
  it('acknowledges only the exact owner, club and tab', () => {
    expect(isLobbySelectionSave(exchange().response, club, 'PLO', owner)).toBe(true);
    for (const options of [
      { ownerId: 'another-owner' },
      { clubId: 'another-club' },
      { tab: 'HOLDEM' },
      { method: 'GET' },
      { saveBody: null },
      { saveBody: [] },
      { saveBody: { filters: {} } },
    ])
      expect(isLobbySelectionRequest(exchange(options).request, club, 'PLO', owner)).toBe(false);
    expect(isLobbySelectionSave(exchange({ status: 500 }).response, club, 'PLO', owner)).toBe(
      false
    );
    expect(() => isLobbySelectionRequest(exchange().request, club, 'unknown', owner)).toThrow(
      'Unknown lobby tab'
    );
  });

  it('does not click from warm UI until the exact current-document owner read arrives', async () => {
    const f = fixture();
    const selecting = selectLobbyPreference(f.page, club, 'PLO', owner, f.proof);
    f.read({ projection: 'filters' });
    f.read({ ownerId: 'another-owner' });
    f.read({ clubId: 'another-club' });
    await Promise.resolve();
    expect(f.events).toEqual([]);
    f.read();
    await selecting;
    expect(f.events).toEqual(['click']);
    expect(
      f.proof
        .snapshot()
        .events.some((event) => event.kind === 'intended-response' && event.status === 200)
    ).toBe(true);
    f.proof.stop();
  });

  it('refuses a prior document read after a cold navigation', async () => {
    const f = fixture();
    f.read();
    f.navigate();
    const selecting = selectLobbyPreference(f.page, club, 'PLO', owner, f.proof);
    await Promise.resolve();
    expect(f.events).toEqual([]);
    f.read();
    await selecting;
    expect(f.events).toEqual(['click']);
    f.proof.stop();
  });

  it.each([
    { status: 500, message: 'read returned HTTP 500' },
    { body: { view_prefs: { tab: 'obsolete' } }, message: 'invalid tab' },
    { body: { view_prefs: 'invalid' }, message: 'invalid view preferences' },
    { body: 'invalid', message: 'invalid row' },
    { body: {}, message: 'omitted view preferences' },
  ])(
    'refuses an unsuccessful or invalid own readiness read: $message',
    async ({ message, ...options }) => {
      const f = fixture();
      f.read(options);
      await expect(selectLobbyPreference(f.page, club, 'PLO', owner, f.proof)).rejects.toThrow(
        message
      );
      expect(f.events).toEqual([]);
      f.proof.stop();
    }
  );

  it('reports the actual failed save response immediately instead of filtering it into a timeout', async () => {
    const f = fixture({ status: 503 });
    f.read();
    await expect(selectLobbyPreference(f.page, club, 'PLO', owner, f.proof)).rejects.toThrow(
      'save returned HTTP 503'
    );
    expect(f.events).toEqual(['click']);
    expect(f.proof.snapshot().events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'selection-clicked', ariaSelected: 'true' }),
        expect.objectContaining({ kind: 'intended-response', status: 503 }),
      ])
    );
    f.proof.stop();
  });

  it.each(['pending', 'wrong-owner'])('bounds a missing %s acknowledgement to30s', async (mode) => {
    vi.useFakeTimers();
    const f = fixture({ responseMode: mode === 'pending' ? 'pending' : 'normal' });
    if (mode === 'wrong-owner') f.setPostOwner('another-owner');
    f.read();
    try {
      const outcome = selectLobbyPreference(f.page, club, 'PLO', owner, f.proof).catch(
        (error) => error
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect((await outcome).message).toMatch(
        mode === 'pending' ? /save response.*30s/ : /save request.*30s/
      );
      expect(f.events).toEqual(['click']);
    } finally {
      f.proof.stop();
      vi.useRealTimers();
    }
  });

  it('retains the actual failed click and geometry before closing without waiting for an unissued save', async () => {
    vi.useFakeTimers();
    const f = fixture({ clickFailure: true });
    f.read();
    try {
      const outcome = restoreLobbyPreference({
        originalPage: f.page,
        returningPage: f.page,
        returningReady: true,
        clubId: club,
        original: 'MTT',
        ownerId: owner,
        proofFor: () => f.proof,
        verify: vi.fn(),
      }).catch((error) => error);
      await vi.advanceTimersByTimeAsync(30_000);
      const failure = await outcome;
      expect(failure.message).toBe('Click timeout: header intercepts pointer events');
      expect(f.requestListeners()).toBe(1);
      expect(f.proof.snapshot().events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'selection-click-failed',
            message: 'Click timeout: header intercepts pointer events',
          }),
          expect.objectContaining({
            kind: 'selection-failure-geometry',
            hit: { tag: 'HEADER', role: 'banner' },
          }),
        ])
      );
      expect(f.events.at(-1)).toBe('close');
    } finally {
      f.proof.stop();
      vi.useRealTimers();
    }
  });

  it('gives the save its existing network budget after a slow successful click', async () => {
    vi.useFakeTimers();
    const f = fixture({ clickDelayMs: 21_000, requestDelayMs: 12_000 });
    f.read();
    try {
      const outcome = selectLobbyPreference(f.page, club, 'PLO', owner, f.proof).then(
        () => 'passed',
        (error) => error.message
      );
      await vi.advanceTimersByTimeAsync(33_000);
      expect(await outcome).toBe('passed');
      expect(f.requestListeners()).toBe(1);
      expect(f.events).toEqual(['click']);
      expect(f.proof.snapshot().events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'intended-response', status: 200 }),
        ])
      );
    } finally {
      f.proof.stop();
      vi.useRealTimers();
    }
  });

  it('shares one 30-second network budget between a delayed request and its response', async () => {
    vi.useFakeTimers();
    const f = fixture({ clickDelayMs: 21_000, requestDelayMs: 20_000, responseMode: 'pending' });
    f.read();
    let failure: Error | undefined;
    try {
      const outcome = selectLobbyPreference(f.page, club, 'PLO', owner, f.proof).catch((error) => {
        failure = error;
      });
      await vi.advanceTimersByTimeAsync(50_999);
      expect(failure).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await outcome;
      expect(failure?.message).toMatch(/save response.*30s/);
      expect(f.requestListeners()).toBe(1);
    } finally {
      f.proof.stop();
      vi.useRealTimers();
    }
  });

  it('refuses a save with no response', async () => {
    const f = fixture({ responseMode: 'null' });
    f.read();
    await expect(selectLobbyPreference(f.page, club, 'PLO', owner, f.proof)).rejects.toThrow(
      'save ended without a response'
    );
    f.proof.stop();
  });

  it.each([null, [], { view_prefs: null }])(
    'accepts a confirmed missing saved preference without inventing a tab (%j)',
    async (body) => {
      const f = fixture();
      f.read({ body });
      await expect(f.proof.ready(owner)).resolves.toBeNull();
      f.proof.stop();
    }
  );

  it.each([true, false])(
    'restores through the ready document, verifies and closes (ready=%s)',
    async (ready) => {
      const old = fixture(),
        returned = fixture();
      old.read();
      returned.read();
      const verify = vi.fn(async () => {
        expect((ready ? returned : old).events).toEqual(['click']);
        expect(returned.events).not.toContain('close');
      });
      await restoreLobbyPreference({
        originalPage: old.page,
        returningPage: returned.page,
        returningReady: ready,
        clubId: club,
        original: 'MTT',
        ownerId: owner,
        proofFor: (page) => (page === old.page ? old.proof : returned.proof),
        verify,
      });
      expect(verify).toHaveBeenCalledOnce();
      expect(returned.events.at(-1)).toBe('close');
      old.proof.stop();
      returned.proof.stop();
    }
  );

  it('retains the failed restore and close errors and never reports verification', async () => {
    const f = fixture({ status: 403, closeFailure: true });
    f.read();
    const verify = vi.fn();
    const failure = await restoreLobbyPreference({
      originalPage: f.page,
      returningPage: f.page,
      returningReady: true,
      clubId: club,
      original: 'MTT',
      ownerId: owner,
      proofFor: () => f.proof,
      verify,
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.map((error: Error) => error.message)).toEqual([
      'Lobby preference save returned HTTP 403',
      'close failed',
    ]);
    expect(verify).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe('close');
    f.proof.stop();
  });

  it('keeps the journal bounded and detaches every observer', () => {
    const f = fixture();
    for (let i = 0; i < 80; i++) f.read();
    expect(f.proof.snapshot().events).toHaveLength(64);
    expect(f.proof.snapshot().dropped).toBeGreaterThan(0);
    f.proof.stop();
    const before = f.proof.snapshot();
    f.read();
    f.navigate();
    expect(f.proof.snapshot()).toEqual(before);
  });

  it('wires own-read readiness, exact save, independent readback and unconditional diagnostics without extending 120s', () => {
    const source = readFileSync(
      resolve(__dirname, '../e2e/production-mobile-lobby-chrome.spec.ts'),
      'utf8'
    );
    expect(source).toContain('observeLobbyPreferenceProof(document, CLUB_ID)');
    expect(source).toContain('await proof.ready(ownerId)');
    expect(source).toContain("await openPreferenceLobby(restoredPage, 'restored-readback')");
    expect(source).toContain(".getByRole('tab', { name: original, exact: true })");
    expect(source).toContain('failures.push(error)');
    expect(source).toContain('failures.push(cleanupError)');
    expect(source).toContain('new AggregateError(failures,');
    expect(source).toContain('if (failures.length === 1) throw failures[0]');
    expect(source).toContain('timeout: 120_000');
    expect(source.slice(0, source.indexOf('const preferenceLifecycleTest'))).not.toContain(
      'test.setTimeout'
    );
    expect(source).toContain('preferenceDiagnostics.delete(page)');
  });
});
