import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  EngineSocketJournal,
  whileInitialTableConnects,
  whileConnectionBannerStaysHidden,
} from './support/liveTableRealtime';
import {
  installNaturalAuthAdmissionDiagnostic,
  readNaturalAuthAdmissionDiagnostic,
} from './support/naturalAuthAdmissionDiagnostic';
import { remainingInitialTableReadinessMs } from './support/initialTableReadiness';
import {
  installNaturalMultiRunWitness,
  completedNaturalRuns,
  naturalMultiRunEngineIdentity,
  readNaturalMultiRunHistory,
  initializeNaturalMultiRunObservers,
  naturalMultiRunCandidateQuery,
  eligibleNaturalMultiRunTable,
  naturalMultiRunTransportEvidence,
  type NaturalMultiRunCandidate,
  type NaturalRunPacket,
} from './support/naturalMultiRunMobile';
import {
  readServiceRows,
  requireCustomizationCertificationEnvironment,
} from './support/temporaryCustomizationAccount';

/** The same authoritative admission signals used by the baseline live proof. */
async function openNaturalMultiRunObserver(
  page: Page,
  journal: EngineSocketJournal,
  tableId: string,
  budgetMs: number,
  remainingSetup: () => number
): Promise<void> {
  const startedAt = Date.now();
  const remaining = () => remainingInitialTableReadinessMs(startedAt, budgetMs);
  const protocolReady = Promise.all([
    journal.waitForFrame(
      { direction: 'sent', tableId, type: 'SUBSCRIBE', since: startedAt },
      remaining(),
      `${tableId} natural observer did not subscribe`
    ),
    journal.waitForFrame(
      { direction: 'received', tableId, type: 'SUBSCRIBED', since: startedAt },
      remaining(),
      `${tableId} natural observer subscription was not acknowledged`
    ),
    journal.waitForFrame(
      { direction: 'received', tableId, type: 'SNAPSHOT', since: startedAt },
      remaining(),
      `${tableId} natural observer did not receive an authoritative snapshot`
    ),
  ]);
  await whileInitialTableConnects(
    page,
    (async () => {
      await Promise.all([
        page.goto(`table/${tableId}`, { waitUntil: 'domcontentloaded', timeout: remaining() }),
        protocolReady,
      ]);
      await expect(page.locator('.table-page')).toBeVisible({ timeout: remaining() });
      await expect(page.locator('.table-surface')).toBeVisible({ timeout: remaining() });
      await expect(page.getByTestId('table-connection-banner')).toBeHidden({
        timeout: remaining(),
      });
    })(),
    `${tableId} natural observer initial connection`
  );
  // Decoded media is additional setup, not part of baseline wire admission.
  // Every observer consumes the same original setup deadline; no new budget.
  await whileConnectionBannerStaysHidden(
    page,
    (async () => {
      await expect
        .poll(
          () =>
            page
              .locator('img.table-art')
              .evaluateAll(
                (images: HTMLImageElement[]) =>
                  images.length === 1 &&
                  images[0].complete &&
                  images[0].naturalWidth > 0 &&
                  images[0].naturalHeight > 0
              ),
          {
            timeout: remainingSetup(),
            message: 'The actual table felt must load before natural observation',
          }
        )
        .toBe(true);
      await expect(page.locator('.table-art-cover:visible')).toHaveCount(0, {
        timeout: remainingSetup(),
      });
    })(),
    `${tableId} natural observer media readiness`
  );
}

const enabled = process.env.LIVE_TABLE_MULTIRUN_CERTIFICATION === '1';
const union = 'fade0000-0000-0000-0000-000000000001';
// Recent production: both run counts occurred across the union's occupied
// tables within 30 minutes. Observe six independently progressing tables for
// twenty minutes once, without changing settings or producing a test hand.
const observationMs = 20 * 60_000;

test('natural two-run and three-run mobile rivers precede awards and winner chip landings', async ({
  context,
  request,
  baseURL,
  browserName,
}, testInfo) => {
  expect(
    enabled,
    'Selected multirun spec requires explicit production certificate configuration'
  ).toBe(true);
  testInfo.setTimeout(observationMs + 120_000);
  const setupStartedAt = Date.now();
  expect(browserName).toBe('webkit');
  expect(testInfo.project.name).toBe('webkit-live-table-realtime');
  expect(baseURL?.replace(/\/$/, '')).toBe('https://smarter.poker/hub/club-arena');
  expect(process.env.E2E_REQUIRE_AUTH).toBe('1');
  const expectedEngine = process.env.EXPECTED_ENGINE_SHA;
  expect(expectedEngine).toMatch(/^[0-9a-f]{40}$/);
  const readIdentity = async () => {
    const [client, origin, engine] = await Promise.all([
      request.get(`https://smarter.poker/hub/club-arena/build-info.json?cb=${Date.now()}`),
      request.get(`https://ca-static.smarter.poker/build-info.json?cb=${Date.now()}`),
      request.get(`https://engine.smarter.poker/health?cb=${Date.now()}`),
    ]);
    expect(client.ok()).toBe(true);
    expect(origin.ok()).toBe(true);
    expect(engine.ok()).toBe(true);
    const c = await client.json();
    expect((await origin.json()).ca_sha).toBe(c.ca_sha);
    const e = await engine.json();
    const engineSha = naturalMultiRunEngineIdentity(e, expectedEngine!);
    return { client: c.ca_sha as string, engine: engineSha };
  };
  const before = await readIdentity();
  const environment = requireCustomizationCertificationEnvironment();
  const candidateTables = await readServiceRows<NaturalMultiRunCandidate>(
    environment,
    'tables',
    naturalMultiRunCandidateQuery(union)
  );
  const tables = candidateTables.filter(eligibleNaturalMultiRunTable);
  expect(
    tables.length,
    'Natural multirun observation requires six occupied, run-enabled cash tables'
  ).toBeGreaterThanOrEqual(6);
  const recent = await readNaturalMultiRunHistory(
    tables.map((table) => table.id),
    (query) => readServiceRows(environment, 'hand_history', query)
  );
  const score = (id: string) =>
    recent.filter((row) => row.table_id === id && [1, 2].includes(row.rit_boards?.length)).length;
  const selected = [...tables]
    .sort((a, b) => score(b.id) - score(a.id) || b.current_players - a.current_players)
    .slice(0, 6);
  const pages: Array<{
    page: Page;
    tableId: string;
    journal: EngineSocketJournal;
    packets: NaturalRunPacket[];
  }> = [];
  const coverage = new Map<number, any>();
  const observations: any[] = [];
  try {
    await initializeNaturalMultiRunObservers(
      selected,
      async (table, navigationBudgetMs, remainingSetup) => {
        const page = await context.newPage();
        const journal = new EngineSocketJournal(page);
        await installNaturalAuthAdmissionDiagnostic(page);
        await installNaturalMultiRunWitness(page);
        pages.push({ page, tableId: table.id, journal, packets: [] });
        await openNaturalMultiRunObserver(
          page,
          journal,
          table.id,
          navigationBudgetMs,
          remainingSetup
        );
      },
      setupStartedAt
    );
    const deadline = Date.now() + observationMs;
    await expect
      .poll(
        async () => {
          for (const item of pages) {
            item.packets = item.journal
              .matchingFrames({ direction: 'received', tableId: item.tableId, type: 'EVENT' })
              .flatMap((frame) => {
                const p = frame.message.payload as any;
                if (
                  p?.type !== 'rit_result' ||
                  p.replayed === true ||
                  ![2, 3].includes(p.runs) ||
                  p.boards?.length !== p.runs
                )
                  return [];
                return [
                  {
                    hand: Number(p.hand_number),
                    runs: p.runs,
                    at: frame.at,
                    recipients: Object.entries(p.distribution ?? {})
                      .filter(([, amount]) => Number(amount) > 0)
                      .map(([recipient]) => recipient),
                  },
                ];
              });
            const witness = await item.page.evaluate(() =>
              (window as any).__naturalMultiRunWitness.read()
            );
            expect(witness.violations, `Natural multirun presentation at ${item.tableId}`).toEqual(
              []
            );
            for (const packet of completedNaturalRuns(item.packets, witness)) {
              if (coverage.has(packet.runs)) continue;
              const name = `mobile-live-table-natural-${packet.runs}-runs`;
              const imagePath = testInfo.outputPath(`${name}.png`);
              await mkdir(dirname(imagePath), { recursive: true });
              await item.page.screenshot({ path: imagePath });
              await testInfo.attach(name, { path: imagePath, contentType: 'image/png' });
              coverage.set(packet.runs, { tableId: item.tableId, packet, witness });
            }
          }
          return [...coverage.keys()].sort();
        },
        {
          timeout: Math.max(1, deadline - Date.now()),
          intervals: [250],
          message:
            'Natural mobile proof requires BOTH two-run and three-run hands; absent coverage is unverified',
        }
      )
      .toEqual([2, 3]);
    expect(await readIdentity(), 'The exact client and serving engine must stay unchanged').toEqual(
      before
    );
  } finally {
    const transport = pages.map(({ tableId, journal }) =>
      naturalMultiRunTransportEvidence(journal, tableId)
    );
    // Snapshot all surviving pages before closing any possible shared-lock owner.
    const authAdmission = await Promise.all(
      pages.map(async (item) => ({
        tableId: item.tableId,
        diagnostic: await readNaturalAuthAdmissionDiagnostic(item.page).catch(() => null),
      }))
    );
    for (const item of pages) {
      observations.push({
        tableId: item.tableId,
        packets: item.packets,
        witness: await item.page
          .evaluate(() => (window as any).__naturalMultiRunWitness?.read())
          .catch(() => null),
      });
      await item.page
        .evaluate(() => (window as any).__naturalMultiRunWitness?.stop())
        .catch(() => {});
      await item.page.close();
    }
    const path = testInfo.outputPath('mobile-live-table-natural-multirun-evidence.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify(
        {
          before,
          observedAt: new Date().toISOString(),
          authAdmission,
          transport,
          coverage: [...coverage.values()],
          observations,
        },
        null,
        2
      )
    );
    await testInfo.attach('mobile-live-table-natural-multirun-evidence', {
      path,
      contentType: 'application/json',
    });
    console.log(
      `NATURAL_MOBILE_MULTIRUN_COVERAGE ${JSON.stringify({ client: before.client, engine: before.engine, runs: [...coverage.keys()].sort() })}`
    );
  }
});
