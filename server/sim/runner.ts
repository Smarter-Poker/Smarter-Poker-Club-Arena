/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * SIMULATOR RUNNER
 * ═══════════════════════════════════════════════════════════════════════════════
 * Loads scenario files, runs each against a fresh Sim, pipes every snapshot
 * through the CLIENT mapper, and prints PASS/FAIL.
 *
 *   npm run sim                        # run everything under scenarios/
 *   npm run sim -- scenarios/02-*.ts   # run one
 *   npm run sim -- --verbose           # dump every event + snapshot
 */

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { Sim, type Scenario } from './framework.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// The client mapper lives in the sibling repo. We resolve it relative to
// this file's location: club-arena/server/sim/runner.ts →
//                      club-arena/src/utils/mapEngineSnapshot.ts
// (imported dynamically so we don't bloat the server TS build).
async function loadClientMapper() {
  const relative = path.resolve(__dirname, '..', '..', 'src', 'utils', 'mapEngineSnapshot.ts');
  if (!fs.existsSync(relative)) {
    console.warn(`[sim] client mapper not found at ${relative} — mapped assertions disabled`);
    return null;
  }
  try {
    // tsx / ts-node will transpile on import.
    const mod: any = await import(pathToFileURL(relative).href);
    return mod.mapEngineSnapshot ?? null;
  } catch (err) {
    console.warn('[sim] failed to import client mapper:', (err as Error).message);
    return null;
  }
}

async function collectScenarios(args: string[]): Promise<Scenario[]> {
  const dir = path.join(__dirname, 'scenarios');
  const files = args.filter((a) => !a.startsWith('--'));
  const picked =
    files.length > 0
      ? files.map((f) => path.resolve(process.cwd(), f))
      : fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.ts'))
          .sort()
          .map((f) => path.join(dir, f));

  const scenarios: Scenario[] = [];
  for (const file of picked) {
    const mod: any = await import(pathToFileURL(file).href);
    if (mod.default?.name && typeof mod.default.run === 'function') {
      scenarios.push(mod.default);
    }
  }
  return scenarios;
}

async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');

  // Not used yet, but loaded so we fail loud if the client mapper is broken.
  await loadClientMapper();

  const scenarios = await collectScenarios(args);
  if (scenarios.length === 0) {
    console.log('[sim] no scenarios found');
    process.exit(1);
  }

  let passed = 0;
  let failed = 0;
  for (const sc of scenarios) {
    const sim = new Sim(sc.name, verbose);
    try {
      await sc.run(sim);
    } catch (err) {
      sim.failures.push({
        scenario: sc.name,
        message: `threw: ${(err as Error).message}`,
        expected: 'no throw',
        actual: (err as Error).stack ?? String(err),
      });
    }
    if (sim.failures.length === 0) {
      console.log(`  PASS  ${sc.name}`);
      passed += 1;
    } else {
      console.log(`  FAIL  ${sc.name}`);
      for (const f of sim.failures) {
        console.log(`        · ${f.message}`);
        console.log(`          expected: ${JSON.stringify(f.expected)}`);
        console.log(`          actual:   ${JSON.stringify(f.actual)}`);
      }
      failed += 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
