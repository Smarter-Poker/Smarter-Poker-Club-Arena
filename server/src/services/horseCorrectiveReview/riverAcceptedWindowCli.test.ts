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
import { runHorseAcceptedWindow } from '../../scripts/horseAcceptedWindow.js';
import type { AcceptedWindowRequest, AcceptedWindowResult } from './riverAcceptedWindow.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const setup = (version = 1) => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'accepted-window-cli-'));
  dirs.push(dir);
  const input = join(dir, 'input.json'),
    output = join(dir, 'output.json');
  const value = {
    version,
    request: {
      startsAt: '2026-10-25T18:00:00.000Z',
      endsAt: '2026-10-25T19:00:00.000Z',
      after: null,
    },
  };
  writeFileSync(input, JSON.stringify(value), { mode: 0o600 });
  return { dir, input, output, value };
};
const success: AcceptedWindowResult = {
  version: 1,
  status: 'accepted_window_page',
  startsAt: '2026-10-25T18:00:00.000Z',
  endsAt: '2026-10-25T19:00:00.000Z',
  after: null,
  readAt: '2026-10-25T20:00:00.000000Z',
  finalityFenceAt: '2026-10-25T20:00:00.000000Z',
  snapshotId: '20:30:',
  keys: [],
  hasMore: false,
  next: null,
  pageDigest: 'd'.repeat(64),
  qualified: false,
  completePopulation: false,
  activationAllowed: false,
};
const unavailable: AcceptedWindowResult = {
  version: 1,
  status: 'unavailable',
  reason: 'window_finality_unavailable',
  qualified: false,
  completePopulation: false,
  activationAllowed: false,
};
describe('explicit private accepted window page ingress', () => {
  it('awaits the single explicit reader and atomically writes a private bounded page', async () => {
    const s = setup();
    let finish!: (result: AcceptedWindowResult) => void;
    const reader = vi.fn(
      (_request: AcceptedWindowRequest) =>
        new Promise<AcceptedWindowResult>((resolve) => {
          finish = resolve;
        })
    );
    const pending = runHorseAcceptedWindow(
      [s.input, s.output],
      { DATABASE_URL: 'must-not-appear' },
      reader
    );
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader.mock.calls[0][0]).toEqual(s.value.request);
    expect(existsSync(s.output)).toBe(false);
    finish(success);
    const result = await pending;
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(s.output, 'utf8'))).toEqual(success);
    expect(statSync(s.output).mode & 0o777).toBe(0o600);
    expect(JSON.parse(result.output)).toEqual({
      status: 'accepted_window_page',
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
      'pageDigest',
      'snapshotId',
      'startsAt',
      'readFrame',
    ])
      expect(result.output).not.toContain(privateText);
  });
  it('retains an explicit finality refusal without promoting or hiding incompleteness', async () => {
    const s = setup(),
      reader = vi.fn(async () => unavailable);
    const result = await runHorseAcceptedWindow([s.input, s.output], {}, reader);
    expect(result.code).toBe(2);
    expect(JSON.parse(readFileSync(s.output, 'utf8'))).toEqual(unavailable);
    expect(reader).toHaveBeenCalledTimes(1);
  });
  it('retains overflow and source gaps without reporting census completion', async () => {
    const s = setup(),
      page: AcceptedWindowResult = {
        ...success,
        hasMore: true,
        keys: [
          {
            committedAt: '2026-10-25T18:30:00.000000Z',
            handId: '30000000-0000-4000-8000-000000000001',
            tableId: '10000000-0000-4000-8000-000000000001',
            handNumber: '12',
            coreDigest: 'a'.repeat(64),
            payloadDigest: null,
            rosterDigest: null,
            gaps: ['accepted_payload_missing', 'accepted_roster_missing'],
          },
        ],
        next: {
          committedAt: '2026-10-25T18:30:00.000000Z',
          handId: '30000000-0000-4000-8000-000000000001',
        },
      };
    const result = await runHorseAcceptedWindow([s.input, s.output], {}, async () => page);
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(s.output, 'utf8'))).toEqual(page);
    expect(JSON.parse(result.output)).toMatchObject({
      completePopulation: false,
      qualified: false,
      activationAllowed: false,
    });
    expect(result.output).not.toContain('hasMore');
  });
  it('refuses an existing output before querying and preserves its exact bytes', async () => {
    const s = setup();
    writeFileSync(s.output, 'retained prior output', { mode: 0o600 });
    const reader = vi.fn(async () => success),
      result = await runHorseAcceptedWindow([s.input, s.output], {}, reader);
    expect(result.code).toBe(3);
    expect(reader).not.toHaveBeenCalled();
    expect(readFileSync(s.output, 'utf8')).toBe('retained prior output');
  });
  it('refuses a shared input, unsupported input version and caller-supplied qualification flags before dispatch', async () => {
    const s = setup(),
      reader = vi.fn(async () => success);
    chmodSync(s.input, 0o644);
    expect((await runHorseAcceptedWindow([s.input, s.output], {}, reader)).code).toBe(3);
    chmodSync(s.input, 0o600);
    writeFileSync(s.input, JSON.stringify({ ...s.value, version: 2 }));
    expect((await runHorseAcceptedWindow([s.input, s.output], {}, reader)).code).toBe(3);
    writeFileSync(s.input, JSON.stringify({ ...s.value, qualified: true }));
    expect((await runHorseAcceptedWindow([s.input, s.output], {}, reader)).code).toBe(3);
    expect(reader).not.toHaveBeenCalled();
  });
  it('contains reader failures without exposing private query or configuration details', async () => {
    const s = setup(),
      reader = vi.fn(async () => {
        throw Error('private-card-query-password');
      });
    const result = await runHorseAcceptedWindow([s.input, s.output], {}, reader);
    expect(result.code).toBe(3);
    expect(result.output).not.toContain('private-card-query-password');
    expect(existsSync(s.output)).toBe(false);
  });
  it('requires exactly two explicit absolute paths and never interprets extra options as authority', async () => {
    const reader = vi.fn(async () => success),
      s = setup();
    for (const args of [[], ['relative', 'output'], [s.input, s.output, '--qualified']])
      expect((await runHorseAcceptedWindow(args, {}, reader)).code).toBe(64);
    expect(reader).not.toHaveBeenCalled();
  });
});
