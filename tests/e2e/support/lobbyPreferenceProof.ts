import { openLobbyGameSection } from './lobbyGameSections';
import type { Page, Request, Response } from '@playwright/test';

const TAB_KEYS: Record<string, string> = {
  ALL: 'ALL',
  "MTT'S": 'MTT',
  NLH: 'HOLDEM',
  PLO: 'OMAHA',
  LIMIT: 'LIMIT',
  SPINS: 'SPIN',
  'HEADS UP': 'SNG',
};
const SAVE_TIMEOUT_MS = 30_000;
const ENDPOINT = '/rest/v1/user_lobby_filters';

function preferenceUrl(request: Request): URL | null {
  const url = new URL(request.url());
  return url.pathname.endsWith(ENDPOINT) ? url : null;
}

export function isLobbySelectionRequest(
  request: Request,
  clubId: string,
  label: string,
  ownerId: string
): boolean {
  if (!TAB_KEYS[label]) throw new Error(`Unknown lobby tab: ${label}`);
  if (!ownerId || request.method() !== 'POST' || !preferenceUrl(request)) return false;
  try {
    const body: unknown = request.postDataJSON();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    const row = body as { user_id?: unknown; club_id?: unknown; view_prefs?: { tab?: unknown } };
    return (
      row.user_id === ownerId && row.club_id === clubId && row.view_prefs?.tab === TAB_KEYS[label]
    );
  } catch {
    return false;
  }
}

/** Advanced Filters and another owner's write are not this tab's acknowledgement. */
export function isLobbySelectionSave(
  response: Response,
  clubId: string,
  label: string,
  ownerId: string
): boolean {
  return response.ok() && isLobbySelectionRequest(response.request(), clubId, label, ownerId);
}

async function bounded<T>(promise: Promise<T>, ms: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Lobby preference ${phase} did not finish within 30s`)),
          Math.max(1, ms)
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type LobbyPreferenceProof = ReturnType<typeof observeLobbyPreferenceProof>;

/** Install before navigation. Observe only: never issues, routes or retries a request. */
export function observeLobbyPreferenceProof(page: Page, clubId: string) {
  const started = Date.now();
  let generation = 0;
  let owner: string | undefined;
  let phase = 'open';
  const events: Array<Record<string, unknown>> = [];
  let dropped = 0;
  const reads: Array<{ ownerId: string; generation: number; answer: Promise<string | null> }> = [];
  const requests = new WeakMap<Request, number>();
  let changed: (() => void) | undefined;
  const record = (kind: string, detail: Record<string, unknown> = {}) => {
    if (events.length === 64) {
      events.shift();
      dropped++;
    }
    events.push({ ms: Date.now() - started, phase, kind, ...detail });
  };
  const requested = (request: Request) => {
    // Same-document canonical URL replacement does not invalidate a read.
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      generation++;
      record('document', { generation });
      changed?.();
    }
    const url = preferenceUrl(request);
    if (!url) return;
    requests.set(request, generation);
    const detail: Record<string, unknown> = { method: request.method() };
    if (request.method() === 'GET') {
      detail.clubMatches = url.searchParams.get('club_id') === `eq.${clubId}`;
      detail.ownerMatches = owner ? url.searchParams.get('user_id') === `eq.${owner}` : null;
      detail.projection = ['view_prefs', 'filters'].includes(url.searchParams.get('select') ?? '')
        ? url.searchParams.get('select')
        : 'other';
    } else if (request.method() === 'POST') {
      try {
        const row = request.postDataJSON();
        detail.ownerMatches = owner ? row?.user_id === owner : null;
        detail.clubMatches = row?.club_id === clubId;
        detail.writer = row?.view_prefs ? 'view' : row?.filters ? 'filters' : 'other';
        detail.tab = Object.values(TAB_KEYS).includes(row?.view_prefs?.tab)
          ? row.view_prefs.tab
          : null;
      } catch {
        detail.writer = 'invalid';
      }
    }
    record('request', detail);
  };
  const responded = (response: Response) => {
    const request = response.request();
    const url = preferenceUrl(request);
    if (!url) return;
    record('response', { method: request.method(), status: response.status() });
    if (
      request.method() !== 'GET' ||
      url.searchParams.get('club_id') !== `eq.${clubId}` ||
      url.searchParams.get('select') !== 'view_prefs'
    )
      return;
    const ownerFilter = url.searchParams.get('user_id');
    if (!ownerFilter?.startsWith('eq.')) return;
    const answer = (async () => {
      if (!response.ok())
        throw new Error(`Lobby preference read returned HTTP ${response.status()}`);
      const raw: unknown = await response.json();
      const row = Array.isArray(raw) && raw.length <= 1 ? (raw[0] ?? null) : raw;
      if (row === null) return null;
      if (!row || typeof row !== 'object' || Array.isArray(row))
        throw new Error('Lobby preference read returned an invalid row');
      if (!Object.prototype.hasOwnProperty.call(row, 'view_prefs'))
        throw new Error('Lobby preference read omitted view preferences');
      const prefs = (row as { view_prefs?: unknown }).view_prefs;
      if (prefs == null) return null;
      if (typeof prefs !== 'object' || Array.isArray(prefs))
        throw new Error('Lobby preference read returned invalid view preferences');
      const tab = (prefs as { tab?: unknown }).tab;
      if (tab == null) return null;
      if (typeof tab !== 'string' || !Object.values(TAB_KEYS).includes(tab))
        throw new Error('Lobby preference read returned an invalid tab');
      return tab;
    })();
    // A wrong-owner read may fail without becoming the expected owner's readiness.
    void answer.catch(() => {});
    if (reads.length === 64) reads.shift();
    reads.push({ ownerId: ownerFilter.slice(3), generation: requests.get(request) ?? -1, answer });
    changed?.();
  };
  page.on('request', requested);
  page.on('response', responded);
  return {
    record,
    phase(value: string) {
      phase = value;
      record('begin');
    },
    async ready(ownerId: string) {
      if (!ownerId) throw new Error('Lobby preference owner is unavailable');
      owner = ownerId;
      const started = Date.now();
      const find = () =>
        [...reads].reverse().find((r) => r.ownerId === ownerId && r.generation === generation);
      const receipt = await bounded(
        new Promise<(typeof reads)[number]>((resolve) => {
          const check = () => {
            const read = find();
            if (read) resolve(read);
          };
          changed = check;
          check();
        }),
        SAVE_TIMEOUT_MS,
        'owner read readiness'
      ).finally(() => {
        changed = undefined;
      });
      const tab = await bounded(
        receipt.answer,
        SAVE_TIMEOUT_MS - (Date.now() - started),
        'owner read response'
      );
      if (receipt.generation !== generation)
        throw new Error('Lobby preference document changed during readiness');
      record('owner-read-ready', { tab, ownerMatches: receipt.ownerId === ownerId });
      return tab;
    },
    snapshot() {
      return { version: 1, ownerKnown: !!owner, limit: 64, dropped, events: [...events] };
    },
    stop() {
      page.off('request', requested);
      page.off('response', responded);
    },
  };
}

export function lobbyTabLabel(tab: string): string {
  const label = Object.entries(TAB_KEYS).find(([, key]) => key === tab)?.[0];
  if (!label) throw new Error('Lobby preference read returned an unsupported tab');
  return label;
}

/** Only the maintained canary's identity is returned; no token leaves the page. */
export async function readLobbyPreferenceOwner(page: Page): Promise<string> {
  const owner = await page.evaluate(() => {
    const session = JSON.parse(localStorage.getItem('smarter-poker-auth') || 'null');
    return session?.user?.id || session?.currentSession?.user?.id || null;
  });
  if (typeof owner !== 'string' || !/^[0-9a-f-]{36}$/i.test(owner))
    throw new Error('Lobby preference owner is unavailable');
  return owner;
}

export async function selectLobbyPreference(
  page: Page,
  clubId: string,
  label: string,
  ownerId: string,
  proof: LobbyPreferenceProof
) {
  await proof.ready(ownerId);
  await openLobbyGameSection(page, label);
  const tabs = page.getByRole('tablist', { name: 'Game Type', exact: true });
  const tab = tabs.getByRole('tab', { name: label, exact: true });
  const before = await tabs.getByRole('tab', { selected: true }).textContent();
  proof.record('selection-before', { selected: before?.trim(), intended: label });

  // Observe before the action, including a write that precedes click completion.
  // Start the existing network budget only after the action has succeeded.
  let receiveRequest!: (request: Request) => void;
  const requested = new Promise<Request>((resolve) => {
    receiveRequest = resolve;
  });
  const observeRequest = (request: Request) => {
    if (isLobbySelectionRequest(request, clubId, label, ownerId)) receiveRequest(request);
  };
  page.on('request', observeRequest);
  let phase = 'click';
  const actionStarted = Date.now();
  try {
    await tab.click({ timeout: SAVE_TIMEOUT_MS });
    proof.record('selection-action-complete', { durationMs: Date.now() - actionStarted });
    phase = 'attribute';
    const ariaSelected = await tab.getAttribute('aria-selected', {
      timeout: Math.max(1, SAVE_TIMEOUT_MS - (Date.now() - actionStarted)),
    });
    proof.record('selection-clicked', { intended: label, ariaSelected });
    const saveStarted = Date.now();
    phase = 'request';
    const request = await bounded(
      requested,
      SAVE_TIMEOUT_MS - (Date.now() - saveStarted),
      'save request'
    );
    proof.record('intended-request', {
      ownerMatches: true,
      clubMatches: true,
      tab: TAB_KEYS[label],
    });
    phase = 'response';
    const response = await bounded(
      request.response(),
      SAVE_TIMEOUT_MS - (Date.now() - saveStarted),
      'save response'
    );
    if (!response) throw new Error('Lobby preference save ended without a response');
    proof.record('intended-response', { status: response.status() });
    if (!response.ok()) throw new Error(`Lobby preference save returned HTTP ${response.status()}`);
    phase = 'state';
    const after = await tab.getAttribute('aria-selected');
    proof.record('selection-after', { selected: label, ariaSelected: after });
    if (after !== 'true')
      throw new Error(`Lobby preference ${label} was saved but is not selected`);
  } catch (error) {
    proof.record(`selection-${phase}-failed`, {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    });
    // Observe the isolated tab before restoration closes its document. Do not
    // trigger locator handlers, retry the action or read player/account text.
    try {
      const geometry = await page.evaluate((label) => {
        const target = [
          ...document.querySelectorAll<HTMLElement>(
            '[role="tablist"][aria-label="Game Type"] [role="tab"]'
          ),
        ].find((element) => element.textContent?.trim() === label);
        if (!target) return { target: null };
        const rect = target.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        const style = getComputedStyle(target);
        return {
          target: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          viewport: { width: innerWidth, height: innerHeight },
          connected: target.isConnected,
          disabled:
            target.hasAttribute('disabled') || target.getAttribute('aria-disabled') === 'true',
          selected: target.getAttribute('aria-selected'),
          visibility: style.visibility,
          pointerEvents: style.pointerEvents,
          hit: hit
            ? {
                tag: hit.tagName,
                role: hit.getAttribute('role'),
                targetOrChild: target.contains(hit),
              }
            : null,
        };
      }, label);
      proof.record('selection-failure-geometry', geometry);
    } catch (error) {
      proof.record('selection-failure-geometry-unavailable', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    page.off('request', observeRequest);
  }
}

/** Keep the ready cold-return document alive until restoration and independent readback finish. */
export async function restoreLobbyPreference({
  originalPage,
  returningPage,
  returningReady,
  clubId,
  original,
  ownerId,
  proofFor,
  verify,
}: {
  originalPage: Page;
  returningPage: Page | undefined;
  returningReady: boolean;
  clubId: string;
  original: string;
  ownerId: string;
  proofFor: (page: Page) => LobbyPreferenceProof;
  verify: () => Promise<void>;
}) {
  const failures: unknown[] = [];
  try {
    const restorePage = returningReady && returningPage ? returningPage : originalPage;
    const proof = proofFor(restorePage);
    proof.phase('restore');
    await selectLobbyPreference(restorePage, clubId, original, ownerId, proof);
    await verify();
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await returningPage?.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 1)
    throw new AggregateError(failures, 'Lobby preference restoration and document cleanup failed');
  if (failures.length === 1) throw failures[0];
}
