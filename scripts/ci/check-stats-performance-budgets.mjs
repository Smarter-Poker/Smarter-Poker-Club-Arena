#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const root = process.cwd();
const dist = process.argv[2] || 'dist';
const assets = path.resolve(root, dist, 'assets');
const configPath = path.resolve(root, 'scripts/ci/stats-performance-budgets.json');
const config = JSON.parse(readFileSync(configPath, 'utf8'));

if (!existsSync(assets)) {
  console.error(`[stats-budget] ${assets} is missing; run the production build first.`);
  process.exit(1);
}

const files = readdirSync(assets);
const measured = new Map();
const failures = [];

for (const [name, budget] of Object.entries(config.chunks)) {
  const matches = files.filter((file) => new RegExp(`^${name}-.*\\.js$`).test(file));
  if (matches.length !== 1) {
    failures.push(`${name}: expected exactly one output chunk, found ${matches.length}`);
    continue;
  }
  const bytes = gzipSync(readFileSync(path.join(assets, matches[0])), { level: 9 }).length;
  const gzipKb = bytes / 1024;
  measured.set(name, gzipKb);
  console.log(`[stats-budget] ${name}: ${gzipKb.toFixed(2)} KB gzip / ${budget.maxGzipKb} KB`);
  if (gzipKb > budget.maxGzipKb) {
    failures.push(`${name}: ${gzipKb.toFixed(2)} KB exceeds ${budget.maxGzipKb} KB gzip`);
  }
}

const overviewMissing = config.overviewRoute.chunks.filter((name) => !measured.has(name));
if (overviewMissing.length === 0) {
  const overviewKb = config.overviewRoute.chunks.reduce((sum, name) => sum + measured.get(name), 0);
  console.log(`[stats-budget] overview route: ${overviewKb.toFixed(2)} KB gzip / ${config.overviewRoute.maxGzipKb} KB`);
  if (overviewKb > config.overviewRoute.maxGzipKb) {
    failures.push(`overview route: ${overviewKb.toFixed(2)} KB exceeds ${config.overviewRoute.maxGzipKb} KB gzip`);
  }
}

if (failures.length) {
  console.error(`[stats-budget] FAILED\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log(`[stats-budget] PASS (${config.measurement})`);
