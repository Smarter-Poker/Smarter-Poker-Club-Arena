/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  NO ADDITIONAL ENGINE WORKER UNTIL THE SCALING GATE IS MET
 *  (Diamond Phase 11, line 6, 2026-09-30)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Phase 11 asked for the scaling integration to be verified before any
 * additional engine worker is enabled. The answer, with the evidence, is in
 * docs/evidence/diamond-phase-11/engine-ownership-and-scaling.md:
 *
 *   - the table and tournament leases DO keep one owner per table when two
 *     engine processes run at once (scripts/dev/probe-two-engine-ownership-pg17.py,
 *     scenario R4), so a second engine cannot double-deal;
 *   - but nothing routes a player to the engine that owns the table. Caddy
 *     sends every request to one upstream, and a non-owner answers
 *     404 "Table engine not found" or closes the socket with 4404 - the
 *     2026-08-23 state in which 14 of 44 tables could not be reached;
 *   - the /ws/channel hub (lobby, presence, tournaments) is in-process, and
 *     server/src/scale/ (shard manager, router, cross-node bus) is a
 *     unit-tested foundation that nothing in the live engine loads.
 *
 * So the estate serves from ONE engine. This law pins the three facts that
 * keep it there, so that enabling a second engine or a worker shard is a
 * visible edit to this file, made together with the gate items in the
 * evidence file - never a quiet import, a second upstream, or a stray
 * container.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const GATE = 'docs/evidence/diamond-phase-11/engine-ownership-and-scaling.md';
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function productionSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || full === join(ROOT, 'server/src/scale')) continue;
      out.push(...productionSources(full));
    } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('the estate serves from one engine until the scaling gate is met', () => {
  it('the gate this law enforces is written down', () => {
    const gate = read(GATE);
    expect(gate).toContain('## The gate before any additional engine worker');
  });

  it('nothing in the live engine loads the shard manager, router or cross-node bus', () => {
    const importsScale = /(?:from\s+|import\(\s*)['"](?:\.{1,2}\/)+(?:[\w.-]+\/)*scale\//;
    const offenders = productionSources(join(ROOT, 'server/src'))
      .filter((file) => importsScale.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file));
    expect(
      offenders,
      `server/src/scale/ is not integrated end to end (no owner-aware routing, no cross-instance ` +
        `channel fan-out, no TableHost). Meet the gate in ${GATE} before wiring it.`
    ).toEqual([]);
  });

  it('Caddy sends engine.smarter.poker to exactly one engine', () => {
    const caddy = read('server/Caddyfile').replace(/#.*$/gm, '');
    const site = caddy.slice(caddy.indexOf('engine.smarter.poker {'));
    const proxies = [...site.matchAll(/reverse_proxy\s+([^\n{]+)/g)].map((m) =>
      m[1].trim().split(/\s+/)
    );
    expect(
      proxies,
      `A second upstream needs owner-aware routing first: a non-owner answers 404 / close 4404. See ${GATE}.`
    ).toEqual([['localhost:8080']]);
  });

  it('the sealed release still refuses a second engine container on the host', () => {
    const release = read('server/scripts/engine-release-transaction.sh');
    expect(release).toContain('docker ps --filter label=sp.role=engine');
    expect(release).toContain("die 'an unmanaged engine container is running on this host'");
  });
});
