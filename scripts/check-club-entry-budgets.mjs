import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const root = process.cwd();
const assetDir = path.join(root, 'dist/assets');
const failures = [];

if (!existsSync(assetDir)) {
  console.error('[club-entry-budget] dist/assets is missing; run the production build first.');
  process.exit(1);
}

const budgets = [
  [/^HomePage-.*\.js$/, 20],
  [/^HomePage-.*\.css$/, 12],
  [/^CreateClubModal-.*\.js$/, 8],
  [/^CreateClubModal-.*\.css$/, 6],
  [/^FindPlayerModal-.*\.js$/, 8],
  [/^FindPlayerModal-.*\.css$/, 6],
  [/^JoinClubModal-.*\.js$/, 8],
  [/^JoinClubModal-.*\.css$/, 6],
];

const files = readdirSync(assetDir);
for (const [pattern, maxGzipKb] of budgets) {
  const file = files.find((candidate) => pattern.test(candidate));
  if (!file) {
    failures.push(`missing output matching ${pattern}`);
    continue;
  }
  const gzipKb = gzipSync(readFileSync(path.join(assetDir, file))).length / 1024;
  console.log(`[club-entry-budget] ${file}: ${gzipKb.toFixed(1)} KB gzip / ${maxGzipKb} KB`);
  if (gzipKb > maxGzipKb) failures.push(`${file} is ${gzipKb.toFixed(1)} KB gzip`);
}

const media = [
  ['public/images/club-arena/vault-iris-emblem-v1-320.webp', 32],
  ['public/images/club-arena/vault-iris-emblem-v1-640.webp', 96],
  ['public/images/club-arena/approved-club-entry-action-pill-v1.webp', 768],
];
for (const [relative, maxKb] of media) {
  const file = path.join(root, relative);
  if (!existsSync(file)) {
    failures.push(`missing ${relative}`);
    continue;
  }
  const kb = statSync(file).size / 1024;
  console.log(`[club-entry-budget] ${relative}: ${kb.toFixed(1)} KB / ${maxKb} KB`);
  if (kb > maxKb) failures.push(`${relative} is ${kb.toFixed(1)} KB`);
}

if (failures.length) {
  console.error(`[club-entry-budget] FAILED\n- ${failures.join('\n- ')}`);
  process.exit(1);
}

console.log('[club-entry-budget] PASS');
