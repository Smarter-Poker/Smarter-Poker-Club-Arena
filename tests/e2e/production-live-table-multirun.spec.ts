import { expect, test, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EngineSocketJournal } from './support/liveTableRealtime';
import {
  installNaturalMultiRunWitness,
  completedNaturalRuns,
  naturalMultiRunEngineIdentity,
  type NaturalRunPacket,
} from './support/naturalMultiRunMobile';
import {
  readServiceRows,
  requireCustomizationCertificationEnvironment,
} from './support/temporaryCustomizationAccount';

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
  const tables = await readServiceRows<{ id: string; current_players: number }>(
    environment,
    'tables',
    new URLSearchParams({
      select: 'id,current_players',
      club_id: `eq.${union}`,
      current_players: 'gte.2',
      run_it_twice: 'eq.true',
      status: 'in.(playing,active,waiting)',
      order: 'current_players.desc',
      limit: '32',
    })
  );
  expect(
    tables.length,
    'No occupied union table available for natural multirun observation'
  ).toBeGreaterThan(0);
  const recent = await readServiceRows<{ table_id: string; rit_boards: unknown[] }>(
    environment,
    'hand_history',
    new URLSearchParams({
      select: 'table_id,rit_boards',
      created_at: `gte.${new Date(Date.now() - 30 * 60_000).toISOString()}`,
      rit_boards: 'not.is.null',
      order: 'created_at.desc',
      limit: '500',
    })
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
    const setup = await Promise.allSettled(
      selected.map(async (table) => {
        const page = await context.newPage();
        const journal = new EngineSocketJournal(page);
        await installNaturalMultiRunWitness(page);
        pages.push({ page, tableId: table.id, journal, packets: [] });
        await page.goto(`table/${table.id}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await expect(page.locator('.table-page')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('.table-art-cover:visible')).toHaveCount(0);
      })
    );
    for (const result of setup) if (result.status === 'rejected') throw result.reason;
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
