import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  boundedRepairRead,
  repairCases,
  openingCases,
  repairFinancialDiagnostics,
} from './leaderboard-repair-financial-diagnostics.mjs';

const fixture = repairCases.map((name) => `${name}|t||`).join('\n');
test('opening exact eight-case inventory and fixed stages, never partial or alternate modes', () => {
  const source = readFileSync(
    new URL('./leaderboard-isolated-opening-policy-draft.sql', import.meta.url),
    'utf8'
  );
  const names = [
    ...source.match(/FOREACH name IN ARRAY ARRAY\[([\s\S]*?)\] LOOP/)[1].matchAll(/'([^']+)'/g),
  ].map((m) => m[1]);
  assert.deepEqual(names, openingCases);
  const input = names.map((name) => `${name}|t||`).join('\n');
  for (const stage of [...source.matchAll(/stage:='([^']+)'/g)].map((m) => m[1])) {
    assert.match(
      repairFinancialDiagnostics('opening', input.replace('|t||', `|f|P0001|${stage}`)),
      /mode=opening/
    );
  }
  for (const bad of [
    input.split('\n').slice(0, 6).join('\n'),
    input.split('\n').slice(0, 6).join('\n').replace('|t||', '|f|P0001|prepare'),
    input.replace('|t||', '|f|P0001|SECRET'),
    fixture,
  ])
    assert.throws(() => repairFinancialDiagnostics('opening', bad));
  for (const mode of ['constructor', 'funding', 'worker', ''])
    assert.throws(() => repairFinancialDiagnostics(mode, input));
});
test('complete original failure reports safely without falsely passing unexecuted extended cases', () => {
  const original = repairCases
    .slice(0, 6)
    .map((name) => `${name}|t||`)
    .join('\n');
  assert.throws(() => repairFinancialDiagnostics('v2-payout', original));
  const output = repairFinancialDiagnostics(
    'v2-payout',
    original.replace('|t||', '|f|P0001|case_execution')
  );
  assert.equal(output.split('\n').length, 7);
  assert.match(output, /pass=f stage=case_execution SQLSTATE=P0001/);
  assert.match(output, /extended=not-executed result=not-qualified$/);
  assert.doesNotMatch(output, /case=affiliate_union/);
  assert.throws(() =>
    repairFinancialDiagnostics('v2-payout', original.split('\n').slice(1).join('\n'))
  );
});
test('exact twelve source cases and fixed stages agree with actual verdict producers', () => {
  const baseline = readFileSync(
    new URL('./leaderboard-isolated-payout-regression-draft.sql', import.meta.url),
    'utf8'
  );
  const adapter = readFileSync(
    new URL('./leaderboard-capture-payout-fixture-candidate.mjs', import.meta.url),
    'utf8'
  );
  const names = (source) =>
    [
      ...source
        .match(/FOREACH case_name IN ARRAY ARRAY\[([\s\S]*?)\] LOOP/)[1]
        .matchAll(/'([^']+)'/g),
    ].map((m) => m[1]);
  assert.deepEqual([...names(baseline), ...names(adapter)], repairCases);
  for (const stage of [...adapter.matchAll(/stage:='([^']+)'/g)].map((m) => m[1])) {
    const input = fixture.replace(`${repairCases[6]}|t||`, `${repairCases[6]}|f|ZLF01|${stage}`);
    assert.match(
      repairFinancialDiagnostics('v2-payout', input),
      new RegExp(`stage=${stage} SQLSTATE=ZLF01`)
    );
  }
  const output = repairFinancialDiagnostics(
    'v2-payout',
    `SECRET_PRIVATE_TOKEN\nERROR: arbitrary statement\n${fixture}`
  );
  assert.equal(output.split('\n').length, 12);
  assert.doesNotMatch(output, /SECRET|arbitrary|ERROR:/);
});
test('partial, duplicate, unknown, malformed or secret-bearing verdict fields fail closed', () => {
  for (const input of [
    '',
    fixture.split('\n').slice(1).join('\n'),
    `${fixture}\n${fixture.split('\n')[0]}`,
    fixture.replace(repairCases[0], 'SECRET_CASE'),
    `${fixture}|extra`,
    fixture.replace('|t||', '|f|SECRET|case_execution'),
    fixture.replace('|t||', '|f|00000|case_execution'),
    fixture.replace('|t||', '|f|P0001|SECRET_STAGE'),
    fixture.replace('|t||', '|f||case_execution'),
    fixture.replace('|t||', '|t|P0001|case_execution'),
    fixture.replace('|t||', '|true||'),
    'x'.repeat(65537),
  ])
    assert.throws(() => repairFinancialDiagnostics('v2-payout', input));
});
test('bounded regular nonsymlink read and CLI refusal never expose private errors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repair-diagnostic-'));
  try {
    const path = join(dir, 'private.log');
    writeFileSync(path, fixture, { mode: 0o600 });
    assert.equal(boundedRepairRead(path), fixture);
    symlinkSync(path, join(dir, 'link'));
    assert.throws(() => boundedRepairRead(join(dir, 'link')));
    assert.throws(() => boundedRepairRead(dir));
    writeFileSync(path, 'SECRET_PRIVATE_PASSWORD|malformed', { mode: 0o600 });
    const result = spawnSync(
      process.execPath,
      [
        new URL('./leaderboard-repair-financial-diagnostics.mjs', import.meta.url).pathname,
        'v2-payout',
        path,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Financial Repair Diagnostic: unknown/);
    assert.doesNotMatch(result.stderr, /SECRET|PASSWORD|malformed/);
    writeFileSync(path, 'x'.repeat(65537));
    assert.throws(() => boundedRepairRead(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
