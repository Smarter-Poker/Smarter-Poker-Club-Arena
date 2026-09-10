#!/usr/bin/env node
// Capture the shipped manager's pure rule methods and approved receipt producers.
// The pinned source makes this SQL-only rolling-compatibility proof reproducible.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const managerRef =
  process.env.POKER_AUDIT_MANAGER_REF || 'd9dbf1388617ebfad71b00040aac22819c4103af';
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
    const content = execFileSync('git', ['-C', repo, 'show', managerRef + ':' + input], {
      encoding: 'utf8',
    });
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
  const content = execFileSync('git', ['-C', repo, 'show', managerRef + ':' + input], {
    encoding: 'utf8',
  });
  hashes.push({ source: input, sha256: createHash('sha256').update(content).digest('hex') });
  const methods = [
    'resolveBlindLevel',
    'capLevelToTournamentChips',
    'chipsInPlayEstimate',
    'levelDurationMs',
    'isLateRegClosed',
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

  const inputDuration = 'server/src/tournament/clockDuration.ts';
  const durationSource = readFileSync(join(repo, inputDuration), 'utf8');
  const durationOutput = join(root, 'clockDuration.js');
  writeFileSync(
    durationOutput,
    ts.transpileModule(durationSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText
  );
  const candidate = await import(pathToFileURL(durationOutput).href);
  hashes.push({
    source: inputDuration,
    sha256: createHash('sha256').update(durationSource).digest('hex'),
  });
  const clientPath = 'src/services/TournamentService.ts';
  const clientSource = execFileSync('git', ['-C', repo, 'show', managerRef + ':' + clientPath], {
    encoding: 'utf8',
  });
  hashes.push({
    source: clientPath,
    sha256: createHash('sha256').update(clientSource).digest('hex'),
  });
  function classMethod(source, name) {
    const parsed = ts.createSourceFile(
      'source.ts',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    let method;
    function walk(node) {
      if (ts.isMethodDeclaration(node) && node.name.getText(parsed) === name)
        method = node.getText(parsed);
      ts.forEachChild(node, walk);
    }
    walk(parsed);
    if (!method) throw new Error('Missing actual method ' + name);
    return method;
  }
  const figuresPath = 'src/components/lobby/tournamentFigures.ts';
  const figures = execFileSync('git', ['-C', repo, 'show', managerRef + ':' + figuresPath], {
    encoding: 'utf8',
  });
  hashes.push({ source: figuresPath, sha256: createHash('sha256').update(figures).digest('hex') });
  const parsedFigures = ts.createSourceFile(
    'figures.ts',
    figures,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );
  const figureMethods = parsedFigures.statements
    .filter(
      (node) =>
        ts.isFunctionDeclaration(node) &&
        ['blindLevelAt', 'blindLevelMinutes'].includes(node.name?.text)
    )
    .map((node) => node.getText(parsedFigures).replace(/^export /, ''))
    .join('\n');
  const clientCode = ts.transpileModule(
    figureMethods +
      '\nclass Client {' +
      classMethod(clientSource, 'getCurrentLevelState') +
      '}\nreturn new Client();',
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
  ).outputText;
  const client = new Function(clientCode)();
  const rows = [];
  const refusedRows = [];
  function capture(format, tag, structure, index, entryClosed, producer) {
    manager.tournamentCache = {
      variant: format,
      tournament_type: format.toUpperCase(),
      starting_chips: 1000,
      accelerated_mtt: true,
    };
    manager.tournamentEntryWindowClosed = entryClosed;
    manager.prizePoolFinalized = false;
    manager.entrantCountForChipCap = 50;
    manager.rebuysGrantedForChipCap = 0;
    manager.addonsGrantedForChipCap = 0;
    manager.blindCapReported = true;
    const actual = manager.resolveBlindLevel(structure, index);
    const oldManagerMs = manager.levelDurationMs(actual);
    const oldClientMs =
      client.getCurrentLevelState({
        ...manager.tournamentCache,
        blind_structure: structure,
        status: 'RUNNING',
        started_at: new Date().toISOString(),
        current_level: index,
        level_started_at: null,
      }).timeRemainingSeconds * 1000;
    const item = {
      format,
      tag,
      index,
      entryClosed,
      structure,
      oldManagerMs,
      oldClientMs,
      producer,
    };
    try {
      item.proposed = candidate.clockDurationForLevel(
        structure,
        index,
        format !== 'mtt',
        true,
        entryClosed
      );
      rows.push(item);
    } catch (error) {
      item.expectedError = error.message;
      refusedRows.push(item);
    }
  }
  for (const format of ['mtt', 'spin', 'sng']) {
    for (const [tag, length] of [
      ['one-minute', { durationMinutes: 1 }],
      ['five-minutes', { durationMinutes: 5 }],
      ['ten-minutes', { durationMinutes: 10 }],
      ['snake-five', { duration_minutes: 5 }],
      ['seconds-three', { duration: 180 }],
      ['fractional-six', { durationMinutes: 6.1 }],
      ['fractional-seventeen', { durationMinutes: 17.9 }],
      ['agreeing-fractional-terms', { durationMinutes: 17.9, duration: 1074 }],
      ['agreeing-aliases', { durationMinutes: 5, duration_minutes: 5, duration: 300 }],
    ]) {
      const structure = [
        { level: 1, smallBlind: 10, bigBlind: 20, ...length },
        { level: 2, smallBlind: 15, bigBlind: 30, ...length },
      ];
      for (const index of [0, 1, 2, 10])
        for (const closed of [false, true]) capture(format, tag, structure, index, closed);
    }
  }
  for (const [tag, length] of [
    ['missing', {}],
    ['contradictory-units', { durationMinutes: 2, duration: 180 }],
    ['null-minute', { durationMinutes: null, duration_minutes: 5 }],
    ['string-minute', { durationMinutes: '5' }],
    ['boolean-minute', { durationMinutes: true }],
    ['negative-camel-positive-snake', { durationMinutes: -1, duration_minutes: 5 }],
    ['zero-camel-positive-snake', { durationMinutes: 0, duration_minutes: 5 }],
    ['object-term', { durationMinutes: {}, duration: 180 }],
    ['array-term', { durationMinutes: [5] }],
    ['contradictory-aliases', { durationMinutes: 5, duration_minutes: 6 }],
    ['overflow-term', { durationMinutes: 1e308 }],
    ['below-half-microsecond', { duration: 0.0000004999999999999999 }],
  ])
    capture('mtt', tag, [{ level: 1, smallBlind: 10, bigBlind: 20, ...length }], 0, false);
  for (const [tag, seconds] of [
    ['half-microsecond', 0.0000005],
    ['above-half-microsecond', 0.0000005000000000000001],
    ['one-second-half-microsecond', 1.0000005],
    ['one-second-below-half-microsecond', 1.0000004999999998],
  ])
    capture('mtt', tag, [{ level: 1, smallBlind: 10, bigBlind: 20, duration: seconds }], 0, false);
  const presetPath = 'src/config/blindStructures.ts';
  const presetSource = execFileSync('git', ['-C', repo, 'show', managerRef + ':' + presetPath], {
    encoding: 'utf8',
  });
  hashes.push({
    source: presetPath,
    sha256: createHash('sha256').update(presetSource).digest('hex'),
  });
  const presetCode = ts.transpileModule(presetSource.replace(/^import .*SPIN_BLINDS.*\n/m, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const presets = {};
  new Function('exports', 'SPIN_BLINDS', presetCode)(presets, spin.SPIN_BLINDS);
  const producers = [];
  function booked(format, label, structure, source) {
    producers.push({ format, label, source, levels: structure.length });
    let last = structure.length - 1;
    while (last > 0 && structure[last].isBreak === true) last--;
    for (const index of [...new Set([0, last, structure.length, structure.length + 8])])
      for (const closed of [false, true])
        capture(format, 'actual-producer:' + label, structure, index, closed, source);
  }
  for (const [name, structure] of Object.entries(presets.BLIND_STRUCTURES))
    booked(name === 'sng' ? 'sng' : 'mtt', name, structure, presetPath);
  for (const [name, structure] of Object.entries(hu))
    if (Array.isArray(structure) && structure.some((x) => x && Object.hasOwn(x, 'durationMinutes')))
      booked('sng', name, structure, 'server/src/config/headsUpSpec.ts');
  for (const stack of [300, 1000])
    for (const tier of receipt.spinRuleManifest(1, stack).tiers)
      booked(
        'spin',
        'stack' + stack + 'x' + tier.multiplier,
        tier.blind_structure,
        'server/src/tournament/SpinDrawReceipt.ts'
      );
  const breakStructure = [
    { level: 1, smallBlind: 10, bigBlind: 20, durationMinutes: 10 },
    { isBreak: true, durationMinutes: 5 },
    { isBreak: true, durationMinutes: 5 },
  ];
  capture('mtt', 'trailing-breaks', breakStructure, 3, true);
  if (refusedRows.length !== 12)
    throw new Error('Unexpected duration admission: ' + JSON.stringify(refusedRows));
  const floorWitness = rows.find(
    (x) => x.format === 'mtt' && x.tag === 'one-minute' && x.index === 2 && !x.entryClosed
  );
  if (floorWitness.oldManagerMs !== 120000 || floorWitness.proposed.durationMs !== 60000)
    throw new Error('Unbooked overflow floor witness changed');
  const now = Date.now();
  const overdue = new Date(now - 50 * 60000).toISOString();
  const overdueClient = client.getCurrentLevelState({
    status: 'RUNNING',
    started_at: overdue,
    current_level: 0,
    level_started_at: overdue,
    blind_structure: [{ level: 1, smallBlind: 10, bigBlind: 20, durationMinutes: 10 }],
  }).timeRemainingSeconds;
  if (overdueClient !== 600) throw new Error('Old client overdue reset witness changed');
  process.stdout.write(
    JSON.stringify(
      {
        manager_source_ref: managerRef,
        sources: hashes,
        producers,
        rows,
        refused_rows: refusedRows,
        old_client_overdue_reset_seconds: overdueClient,
      },
      null,
      2
    ) + '\n'
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
