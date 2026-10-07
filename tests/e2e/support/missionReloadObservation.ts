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
  const isDocument = (request: Request) => {
    if (!request.isNavigationRequest()) return false;
    try {
      return request.frame() === page.mainFrame();
    } catch {
      // Playwright frame() throws for navigation issued before a frame exists.
      // Metadata unavailability must never replace the original reload error.
      if (navigation.length < 8) navigation.push({ event: 'frame_unavailable' });
      return false;
    }
  };
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
            const busy = root?.getAttribute('aria-busy');
            return {
              route:
                location.origin === origin && location.pathname === pathname
                  ? 'expected'
                  : /\/auth(?:\/|$)/.test(location.pathname)
                    ? 'auth'
                    : 'other',
              readyState: window.document.readyState,
              missionRootPresent: !!root,
              missionBusy: busy === 'true' || busy === 'false' ? busy : root ? 'unknown' : null,
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
    await attachWithinObservationBudget(attach, {
      diagnosticOnly: true,
      observationTimeoutMs: OBSERVATION_TIMEOUT_MS,
      elapsedMs: Date.now() - startedAt,
      navigation,
      document,
    });
    throw error;
  } finally {
    page.off('response', onResponse);
    page.off('requestfailed', onFailed);
  }
}

async function attachWithinObservationBudget(attach: AttachObservation, observation: object) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      attach(observation).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, OBSERVATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The cleanup owner already verifies every reserved row and Auth absence. */
export async function finalizeMissionCleanupWithEvidence(
  accountId: string | null,
  journeyError: unknown,
  cleanup: () => Promise<void>,
  attach: AttachObservation
) {
  let cleanupError: unknown;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = error;
  }
  await attachWithinObservationBudget(attach, {
    accountId,
    cleanupStatus:
      cleanupError === undefined
        ? accountId
          ? 'verified_absent'
          : 'no_account_returned'
        : 'refused',
    journeyFailed: journeyError !== undefined,
    observationTimeoutMs: OBSERVATION_TIMEOUT_MS,
  });
  if (cleanupError !== undefined) {
    throw new AggregateError(
      journeyError === undefined ? [cleanupError] : [journeyError, cleanupError],
      'Daily Missions cleanup failed; the original journey failure is retained.',
      { cause: journeyError }
    );
  }
}
