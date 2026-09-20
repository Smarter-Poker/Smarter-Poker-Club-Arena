import type { ConsoleMessage, Frame, Page, Request, Response } from '@playwright/test';

type Stage = 'boot' | 'protected-navigation' | 'terms' | 'profile' | 'membership';
type Observation = {
  elapsedMs: number;
  stage: Stage;
  event: string;
  kind?: 'navigation' | 'script' | 'terms-query' | 'terms-status-chain';
  request?: number;
  host?: string;
  path?: string;
  status?: number;
  errorClass?: string;
};

// Classify rather than persist arbitrary error messages: they can contain
// account IDs, bearer tokens, signed URLs or response bodies.
function errorClass(message: string): string {
  const network = message.match(/\bnet::(ERR_[A-Z0-9_]+)\b/);
  if (network) {
    const known = new Set([
      'ERR_ABORTED',
      'ERR_FAILED',
      'ERR_CONNECTION_RESET',
      'ERR_CONNECTION_CLOSED',
      'ERR_CONNECTION_REFUSED',
      'ERR_HTTP2_PROTOCOL_ERROR',
      'ERR_NAME_NOT_RESOLVED',
      'ERR_TIMED_OUT',
      'ERR_EMPTY_RESPONSE',
      'ERR_BLOCKED_BY_CLIENT',
      'ERR_CERT_DATE_INVALID',
      'ERR_SSL_PROTOCOL_ERROR',
      'ERR_INTERNET_DISCONNECTED',
    ]);
    return known.has(network[1]) ? network[1] : 'NetworkError';
  }
  if (/dynamically imported module|importing a module script|module script failed/i.test(message))
    return 'ModuleImportError';
  if (/failed to fetch|networkerror|load failed/i.test(message)) return 'FetchError';
  if (/aborterror|aborted/i.test(message)) return 'AbortError';
  if (/timeout|timed out/i.test(message)) return 'TimeoutError';
  if (/syntaxerror/i.test(message)) return 'SyntaxError';
  if (/typeerror/i.test(message)) return 'TypeError';
  return 'UnclassifiedError';
}

/** Read-only, bounded evidence for the original setup attempt, never a retry. */
export function observeSetupFailure(page: Page, baseURL: string, supabaseURL?: string) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const origin = new URL(baseURL).origin;
  const basePath = new URL(baseURL).pathname.replace(/\/?$/, '/');
  const supabaseOrigin = supabaseURL ? new URL(supabaseURL).origin : undefined;
  const events: Observation[] = [];
  const requests = new WeakMap<Request, number>();
  let sequence = 0;
  let discarded = 0;
  let stage: Stage = 'boot';

  const record = (event: Omit<Observation, 'elapsedMs' | 'stage'>) => {
    if (events.length === 64) {
      events.shift();
      discarded += 1;
    }
    events.push({ elapsedMs: Date.now() - startedMs, stage, ...event });
  };
  const describe = (
    request: Request
  ): Omit<Observation, 'elapsedMs' | 'stage' | 'event'> | null => {
    const url = new URL(request.url());
    let kind: Observation['kind'];
    let path: string;
    if (
      url.origin === supabaseOrigin &&
      url.pathname === '/rest/v1/profiles' &&
      url.searchParams.get('select') === 'club_arena_tos_accepted_at'
    ) {
      kind = 'terms-query';
      path = '/rest/v1/profiles';
    } else if (request.resourceType() === 'script' && url.origin === origin) {
      kind = 'script';
      // Only a built module label is retained, never an arbitrary URL path.
      path = url.pathname.startsWith(`${basePath}assets/ProfileService-`)
        ? `${basePath}assets/ProfileService-[hash].js`
        : `${basePath}assets/[script]`;
    } else if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      kind = 'navigation';
      path =
        url.origin === origin && url.pathname === `${basePath}notifications`
          ? `${basePath}notifications`
          : '/[document]';
    } else return null;
    let id = requests.get(request);
    if (id === undefined) {
      id = ++sequence;
      requests.set(request, id);
    }
    // A navigation outside the configured app must not expose an account host.
    const host =
      url.origin === origin || url.origin === supabaseOrigin ? url.host : '[other-origin]';
    return { kind, request: id, host, path };
  };
  const onRequest = (request: Request) => {
    const detail = describe(request);
    // Successful script requests are numerous; only their failures matter.
    if (detail && detail.kind !== 'script') record({ event: 'request', ...detail });
  };
  const onResponse = (response: Response) => {
    const detail = describe(response.request());
    if (detail && (detail.kind !== 'script' || response.status() >= 400))
      record({ event: 'response', ...detail, status: response.status() });
  };
  const onRequestFailed = (request: Request) => {
    const detail = describe(request);
    if (detail)
      record({
        event: 'requestfailed',
        ...detail,
        errorClass: errorClass(request.failure()?.errorText || ''),
      });
  };
  const onConsole = (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    const kind = text.startsWith('[ProfileService.getTOSStatus]')
      ? 'terms-query'
      : text.startsWith('[TOSGuard.status_check_failed]')
        ? 'terms-status-chain'
        : null;
    if (kind) record({ event: 'reported-error', kind, errorClass: errorClass(text) });
  };
  const onPageError = (error: Error) => {
    if (errorClass(error.message) === 'ModuleImportError')
      record({ event: 'pageerror', kind: 'script', errorClass: 'ModuleImportError' });
  };
  const onFrame = (frame: Frame) => {
    if (frame === page.mainFrame()) record({ event: 'main-frame-navigated', kind: 'navigation' });
  };
  const onClose = () => record({ event: 'page-closed' });
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('framenavigated', onFrame);
  page.on('close', onClose);

  return {
    stage(next: Stage) {
      stage = next;
      record({ event: 'stage-started' });
    },
    snapshot() {
      return {
        schemaVersion: 1,
        startedAt,
        elapsedMs: Date.now() - startedMs,
        stage,
        discarded,
        events: [...events],
      };
    },
    dispose() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('framenavigated', onFrame);
      page.off('close', onClose);
    },
  };
}
