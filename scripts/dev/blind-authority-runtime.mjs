#!/usr/bin/env node
// Capture the production manager's pure rule methods and approved board/receipt
// producers. This inventories disagreement; it is not a closure test.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = mkdtempSync(join(tmpdir(), 'ca-blind-matrix-runtime-'));
const sources = [
  'config/spinSpec',
  'config/headsUpSpec',
  'tournament/SpinDrawReceipt',
  'tournament/blindEscalation',
  'tournament/blindLadder',
  'tournament/acceleratedLevels',
  'testHelpers/sourceWindow',
];
const hashes = [];
try {
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  for (const source of sources) {
    const input = 'server/src/' + source + '.ts';
    const content = readFileSync(join(repo, input), 'utf8');
    const output = join(root, source + '.js');
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(
      output,
      ts.transpileModule(content, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ES2022,
        },
      }).outputText
    );
    hashes.push({ source: input, sha256: createHash('sha256').update(content).digest('hex') });
  }
  const modules = await Promise.all(
    sources.map((source) => import(pathToFileURL(join(root, source + '.js')).href))
  );
  const [spin, hu, receipt, escalation, ladder, accelerated, windows] = modules;
  const input = 'server/src/tournament/TournamentManagerBase.ts';
  const content = readFileSync(join(repo, input), 'utf8');
  hashes.push({ source: input, sha256: createHash('sha256').update(content).digest('hex') });
  const methods = [
    'resolveBlindLevel',
    'capLevelToTournamentChips',
    'chipsInPlayEstimate',
    'levelDurationMs',
  ]
    .map((name) =>
      windows.sliceMethod(
        content,
        'protected ' + name + (name === 'capLevelToTournamentChips' ? '<' : '(')
      )
    )
    .join('\n');
  const code = ts.transpileModule('class Probe { ' + methods + ' } return new Probe();', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const deps = {
    ...spin,
    ...hu,
    ...receipt,
    ...escalation,
    ...ladder,
    ...accelerated,
    reportError() {},
  };
  const manager = new Function(...Object.keys(deps), code)(...Object.values(deps));
  const rows = [];
  function capture(
    format,
    stack,
    multiplier,
    structure,
    level,
    expected,
    tag = 'approved-current'
  ) {
    manager.tournamentCache = {
      variant: format,
      tournament_type: format.toUpperCase(),
      starting_chips: stack,
    };
    manager.entrantCountForChipCap = format === 'spin' ? 3 : 2;
    manager.rebuysGrantedForChipCap = 0;
    manager.addonsGrantedForChipCap = 0;
    manager.blindCapReported = true;
    const actual = manager.resolveBlindLevel(structure, level - 1);
    rows.push({
      format,
      stack,
      multiplier,
      level,
      tag,
      structure,
      total_chips: stack * manager.entrantCountForChipCap,
      expected,
      manager: {
        small_blind: actual.smallBlind,
        big_blind: actual.bigBlind,
        ante: actual.ante || 0,
        duration_ms: manager.levelDurationMs(actual),
      },
    });
  }
  for (const stack of [300, 1000]) {
    for (const tier of receipt.spinRuleManifest(1, stack).tiers) {
      for (const level of [12, 13, 14, 20, 32]) {
        const value = spin.spinBlindsForLevel(level);
        capture('spin', stack, tier.multiplier, tier.blind_structure, level, {
          small_blind: value.small,
          big_blind: value.big,
          ante: 0,
          duration_ms: tier.levelMinutes * 60000,
        });
      }
    }
    for (const level of [12, 13, 14, 20, 32]) {
      const value = hu.headsUpBlindsForLevel(level);
      capture('sng', stack, null, hu.HEADS_UP_BLIND_STRUCTURE, level, {
        small_blind: value.small,
        big_blind: value.big,
        ante: 0,
        duration_ms: 180000,
      });
    }
  }
  // A frozen receipt deliberately survives future local rule changes. This
  // is a compatibility fault case, not a proposal to change product rules.
  const stored = receipt.spinRuleManifest(1, 300).tiers[0].blind_structure;
  stored[11].spinContinuation.growth = 1.3;
  const historical = receipt.continueBookedSpinBlinds(stored[11], 13);
  capture(
    'spin',
    300,
    2,
    stored,
    13,
    { small_blind: historical.small, big_blind: historical.big, ante: 0, duration_ms: 180000 },
    'versioned-receipt-fault-case'
  );
  process.stdout.write(JSON.stringify({ sources: hashes, rows }) + '\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
