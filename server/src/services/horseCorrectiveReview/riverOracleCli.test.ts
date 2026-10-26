import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
  chmodSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHorseRiverAcceptedOracle } from '../../scripts/horseRiverAcceptedOracle.js';
import { riverReferenceFixture } from './riverReference.test-support.js';
import type {
  RiverAcceptedOracleRequest,
  RiverAcceptedOracleResult,
} from './riverAcceptedOracle.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const setup = (version = 1) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'river-oracle-cli-'));
  dirs.push(dir);
  const input = join(dir, 'input.json'),
    output = join(dir, 'output.json');
  const value = { version, records: [], handKey: 'a'.repeat(64), input: riverReferenceFixture() };
  writeFileSync(input, JSON.stringify(value), { mode: 0o600 });
  return { dir, input, output, value };
};
const success: RiverAcceptedOracleResult = {
  version: 1,
  status: 'accepted_source_oracle',
  playedAt: '2026-09-14T14:00:00.000Z',
  committedAt: '2026-09-14T14:00:00.000Z',
  oracle: { foldBb: 0, callBb: 48 },
  custodyDigest: 'c'.repeat(64),
  oracleDigest: 'd'.repeat(64),
  qualified: false,
  completePopulation: false,
  activationAllowed: false,
};
const unavailable: RiverAcceptedOracleResult = {
  version: 1,
  status: 'unavailable',
  reason: 'oracle_holdings_unavailable',
  qualified: false,
  completePopulation: false,
  activationAllowed: false,
};
describe('explicit private accepted river oracle ingress', () => {
  it('awaits the single explicit reader and atomically writes a private scalar result', async () => {
    const s = setup();
    let finish!: (result: RiverAcceptedOracleResult) => void;
    const reader = vi.fn(
      (_request: RiverAcceptedOracleRequest) =>
        new Promise<RiverAcceptedOracleResult>((resolve) => {
          finish = resolve;
        })
    );
    const pending = runHorseRiverAcceptedOracle(
      [s.input, s.output],
      { DATABASE_URL: 'must-not-appear' },
      reader
    );
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0][0]).toEqual({
      records: s.value.records,
      handKey: s.value.handKey,
      input: s.value.input,
    });
    expect(existsSync(s.output)).toBe(false);
    finish(success);
    const result = await pending;
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(s.output, 'utf8'))).toEqual(success);
    expect(statSync(s.output).mode & 0o777).toBe(0o600);
    expect(JSON.parse(result.output)).toEqual({
      status: 'accepted_source_oracle',
      outputWritten: true,
      qualified: false,
      completePopulation: false,
      activationAllowed: false,
    });
    for (const privateText of [
      'must-not-appear',
      'spades',
      'hero',
      'callBb',
      'custodyDigest',
      'readFrame',
    ])
      expect(result.output).not.toContain(privateText);
  });
  it('retains an explicit missing-holdings result without promoting or hiding incompleteness', async () => {
    const s = setup(),
      reader = vi.fn(async () => unavailable);
    const result = await runHorseRiverAcceptedOracle([s.input, s.output], {}, reader);
    expect(result.code).toBe(2);
    expect(JSON.parse(readFileSync(s.output, 'utf8'))).toEqual(unavailable);
    expect(reader).toHaveBeenCalledTimes(1);
  });
  it('refuses an existing output before querying and preserves its exact bytes', async () => {
    const s = setup();
    writeFileSync(s.output, 'retained prior output', { mode: 0o600 });
    const reader = vi.fn(async () => success),
      result = await runHorseRiverAcceptedOracle([s.input, s.output], {}, reader);
    expect(result.code).toBe(3);
    expect(reader).not.toHaveBeenCalled();
    expect(readFileSync(s.output, 'utf8')).toBe('retained prior output');
  });
  it('refuses a shared input, unsupported input version and caller-supplied qualification flags before dispatch', async () => {
    const s = setup(),
      reader = vi.fn(async () => success);
    chmodSync(s.input, 0o644);
    expect((await runHorseRiverAcceptedOracle([s.input, s.output], {}, reader)).code).toBe(3);
    chmodSync(s.input, 0o600);
    writeFileSync(s.input, JSON.stringify({ ...s.value, version: 2 }));
    expect((await runHorseRiverAcceptedOracle([s.input, s.output], {}, reader)).code).toBe(3);
    writeFileSync(s.input, JSON.stringify({ ...s.value, qualified: true }));
    expect((await runHorseRiverAcceptedOracle([s.input, s.output], {}, reader)).code).toBe(3);
    expect(reader).not.toHaveBeenCalled();
  });
  it('contains reader failures without exposing private query or configuration details', async () => {
    const s = setup(),
      reader = vi.fn(async () => {
        throw Error('private-card-query-password');
      });
    const result = await runHorseRiverAcceptedOracle([s.input, s.output], {}, reader);
    expect(result.code).toBe(3);
    expect(result.output).not.toContain('private-card-query-password');
    expect(existsSync(s.output)).toBe(false);
  });
  it('requires exactly two explicit absolute paths and never interprets extra options as authority', async () => {
    const reader = vi.fn(async () => success),
      s = setup();
    for (const args of [[], ['relative', 'output'], [s.input, s.output, '--qualified']])
      expect((await runHorseRiverAcceptedOracle(args, {}, reader)).code).toBe(64);
    expect(reader).not.toHaveBeenCalled();
  });
});
