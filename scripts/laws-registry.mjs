#!/usr/bin/env node
/**
 * Print the law registry (docs/laws.d/, one file per law) as one table.
 * The table used to be committed in docs/LAWS.md and was the single biggest
 * source of merge conflicts between law-bearing pull requests (2026-09-04).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'laws.d');
const rows = readdirSync(DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => {
    const [head, ...rest] = readFileSync(join(DIR, f), 'utf8').split('\n');
    return [head.replace(/^#\s*/, '').trim(), rest.join(' ').trim()];
  })
  .sort((a, b) => a[0].localeCompare(b[0]));
const w = Math.max(...rows.map(([p]) => p.length));
console.log(`| ${'Law test file'.padEnd(w)} | Guards |`);
console.log(`| ${'-'.repeat(w)} | ------ |`);
for (const [p, g] of rows) console.log(`| ${p.padEnd(w)} | ${g} |`);
