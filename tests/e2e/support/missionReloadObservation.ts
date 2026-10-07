import type { Page, Request, Response } from '@playwright/test';

const OBSERVATION_TIMEOUT_MS = 1_000;
type AttachObservation = (observation: object) => Promise<void>;

/** Preserve the original reload failure, with no retry and no private document/input capture. */
export async function reloadMissionPageWithEvidence(page: Page, attach: AttachObservation) {
  const expected = new URL(page.url());
  const startedAt = Date.now();
  const navigation: object[] = [];
  const routeClass = (raw: string) => {
    const url = new URL(raw);
    if (url.origin === expected.origin && url.pathname === expected.pathname) return 'expected';
    if (/\/auth(?:\/|$)/.test(url.pathname)) return 'auth';
    return 'other';
  };
  const isDocument = (request: Request) =>
    request.isNavigationRequest() && request.frame() === page.mainFrame();
  const onResponse = (response: Response) => {
    if (isDocument(response.request()) && navigation.length < 8)
      navigation.push({
        event: 'response',
        route: routeClass(response.url()),
        status: response.status(),
        elapsedMs: Date.now() - startedAt,
      });
  };
  const onFailed = (request: Request) => {
    if (isDocument(request) && navigation.length < 8) {
      const code = request.failure()?.errorText || '';
      navigation.push({
        event: 'failed',
        route: routeClass(request.url()),
        failureClass: code.includes('ERR_ABORTED')
          ? 'aborted'
          : code.includes('TIMED_OUT')
            ? 'timeout'
            : 'other',
        elapsedMs: Date.now() - startedAt,
      });
    }
  };
  page.on('response', onResponse);
  page.on('requestfailed', onFailed);
  try {
    // Do not change this boundary without evidence: ERR_ABORTED is not proof
    // that a replacement document committed or that mission data rendered.
    await page.reload({ waitUntil: 'domcontentloaded' });
  } catch (error) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const document = await Promise.race([
      page
        .evaluate(
          ({ origin, pathname }) => {
            const root = window.document.querySelector('#daily-missions');
            return {
              route:
                location.origin === origin && location.pathname === pathname
                  ? 'expected'
                  : /\/auth(?:\/|$)/.test(location.pathname)
                    ? 'auth'
                    : 'other',
              readyState: window.document.readyState,
              missionRootPresent: !!root,
              missionBusy: root?.getAttribute('aria-busy') ?? null,
              currentMissionIds: Array.from(
                window.document.querySelectorAll('article[id^="mission-card-"]')
              )
                .map((element) => element.id.slice('mission-card-'.length))
                .filter((id) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
                .slice(0, 25),
            };
          },
          { origin: expected.origin, pathname: expected.pathname }
        )
        .catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), OBSERVATION_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    // The observer cannot replace the authoritative original failure, even
    // when the browser context or attachment transport is already unavailable.
    await attach({
      diagnosticOnly: true,
      observationTimeoutMs: OBSERVATION_TIMEOUT_MS,
      elapsedMs: Date.now() - startedAt,
      navigation,
      document,
    }).catch(() => undefined);
    throw error;
  } finally {
    page.off('response', onResponse);
    page.off('requestfailed', onFailed);
  }
}
