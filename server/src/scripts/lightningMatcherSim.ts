/**
 * THE LIGHTNING MATCHER SIMULATOR, FROM THE COMMAND LINE (Lightning Phase 11).
 *
 *   npm run lightning:matcher-sim -- --players 10,25,50,100,500 --hands 10000 \
 *     --versions m1,m2 --seed 1 [--json out.json]
 *
 * Every other LightningSimOptions key is a flag of the same name in
 * kebab-case (--fold-rate 0.7, --instance-max 6, --disconnects-per-hour 1,
 * --first-entry-rule big_blind, ...). Prints a readable table, and the full
 * results as JSON to --json (or stdout with --json -). Deterministic per
 * seed. Offline: it never touches a database. Not run in CI beyond the
 * smoke test (LightningMatcherSim.test.ts).
 */
import { writeFileSync } from 'node:fs';
import {
  formatLightningSimTable,
  LIGHTNING_SIM_DEFAULTS,
  runLightningMatcherSim,
  type LightningSimOptions,
  type LightningSimResult,
} from '../lightning/LightningMatcherSim.js';

function camel(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

export function parseSimArgs(argv: readonly string[]): {
  players: number[];
  versions: string[];
  json: string | null;
  options: Partial<LightningSimOptions>;
} {
  const out = { players: [50], versions: ['m1', 'm2'], json: null as string | null };
  const options: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const value = argv[i + 1] ?? '';
    i++;
    if (key === 'players')
      out.players = value
        .split(',')
        .map(Number)
        .filter((n) => n > 0);
    else if (key === 'versions' || key === 'version')
      out.versions = value.split(',').filter(Boolean);
    else if (key === 'json') out.json = value;
    else {
      const name = camel(key);
      if (!(name in LIGHTNING_SIM_DEFAULTS)) throw new Error(`unknown flag --${key}`);
      const def = (LIGHTNING_SIM_DEFAULTS as Record<string, unknown>)[name];
      options[name] =
        typeof def === 'boolean'
          ? value === 'true'
          : typeof def === 'string'
            ? value
            : Number(value);
    }
  }
  return { ...out, options: options as Partial<LightningSimOptions> };
}

function main(): void {
  const args = parseSimArgs(process.argv.slice(2));
  const results: LightningSimResult[] = [];
  for (const players of args.players) {
    for (const version of args.versions) {
      const started = Date.now();
      const r = runLightningMatcherSim({ ...args.options, players, version });
      results.push(r);
      process.stderr.write(
        `[sim] ${version} players=${players} hands=${r.hands} in ${Date.now() - started}ms\n`
      );
    }
  }
  process.stdout.write(formatLightningSimTable(results) + '\n');
  if (args.json === '-') process.stdout.write(JSON.stringify(results, null, 2) + '\n');
  else if (args.json) writeFileSync(args.json, JSON.stringify(results, null, 2));
}

if (process.argv[1] && /lightningMatcherSim\.(ts|js)$/.test(process.argv[1])) main();
