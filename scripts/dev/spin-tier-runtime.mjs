#!/usr/bin/env node
// Execute the real engine rule producer/receipt consumer without installing
// dependencies or booting the server. Compiled files live in one temp directory.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const ts = require(process.env.POKER_AUDIT_TYPESCRIPT_MODULE || 'typescript');
const root = mkdtempSync(join(tmpdir(), 'ca-spin-tier-runtime-'));
const sources = [
  ['server/src/config/spinSpec.ts', 'config/spinSpec.js'],
  ['server/src/tournament/SpinDrawReceipt.ts', 'tournament/SpinDrawReceipt.js'],
];
try {
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  const hashes = sources.map(([source, output]) => {
    const text = readFileSync(join(repo, source), 'utf8');
    mkdirSync(dirname(join(root, output)), { recursive: true });
    writeFileSync(
      join(root, output),
      ts.transpileModule(text, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      }).outputText
    );
    return { source, sha256: createHash('sha256').update(text).digest('hex') };
  });
  const { spinRuleManifest, readFundedSpinDraw } = await import(
    pathToFileURL(join(root, 'tournament/SpinDrawReceipt.js')).href
  );
  if (process.argv[2] === 'capture') {
    process.stdout.write(
      JSON.stringify({
        sources: hashes,
        manifests: [300, 1000].map((stack) => spinRuleManifest(1, stack)),
      }) + '\n'
    );
  } else if (process.argv[2] === 'consume') {
    const cases = JSON.parse(readFileSync(0, 'utf8'));
    for (const item of cases) {
      const actual = readFundedSpinDraw(item.receipt, {
        tournamentId: item.receipt.tournament_id,
        launchId: item.receipt.launch_id,
        buyIn: 1,
      });
      assert.equal(actual.multiplier, item.multiplier);
      assert.equal(actual.startingChips, item.stack);
      assert.equal(actual.prizePool, item.multiplier);
      assert.deepEqual(actual.blinds, item.tier.blind_structure);
      assert.deepEqual(actual.payouts, item.tier.payout_structure);
    }
    process.stdout.write(JSON.stringify({ consumed: cases.length, sources: hashes }) + '\n');
  } else {
    throw new Error('Choose capture or consume');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
