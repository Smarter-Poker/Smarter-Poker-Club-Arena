import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  v56PrivateRequestIsValid,
  v56PublicReplayIsSanitized,
  selectV56AcceptedCases,
  runV56PrivateReplay,
} from './v56PrivateReplay.js';
import { correctiveFixture, HAND_KEY } from './fixture.test-support.js';
import { bindHorseDecisionToCommittedHand } from '../../engine/HorseDecisionHandBinding.js';
const request = () => ({
  version: 1,
  sourceRelease: 'a'.repeat(40),
  providerRunId: '123',
  cases: [{ handKey: 'b'.repeat(64), actionOrdinal: 3, decisionSha256: 'c'.repeat(64) }],
});
describe('explicit bounded V56 private replay ingress', () => {
  it('accepts original full-list ordinal with an optional narrowing SHA', () => {
    expect(v56PrivateRequestIsValid(request())).toBe(true);
    const r = request();
    delete (r.cases[0] as { decisionSha256?: string }).decisionSha256;
    expect(v56PrivateRequestIsValid(r)).toBe(true);
  });
  it('refuses empty, oversized, duplicate or malformed selection', () => {
    for (const cases of [
      [],
      Array(7).fill(request().cases[0]),
      [request().cases[0], request().cases[0]],
      [{ handKey: 'raw-coordinate', actionOrdinal: 3 }],
      [{ handKey: 'b'.repeat(64), actionOrdinal: 4096 }],
    ])
      expect(v56PrivateRequestIsValid({ ...request(), cases })).toBe(false);
  });
  it('never accepts raw records or qualification flags as authority', () => {
    for (const extra of [
      { records: [] },
      { qualified: true },
      { sourceAuthenticated: true },
      { runtime: { arch: 'x64' } },
      { signingKey: 'forbidden' },
    ])
      expect(v56PrivateRequestIsValid({ ...request(), ...extra })).toBe(false);
  });
  it('derives the unique SHA from actual reconciled full-list binder ordinal', () => {
    const f = correctiveFixture();
    const bound = bindHorseDecisionToCommittedHand(f.witness, f.hand);
    expect(bound.status).toBe('bound');
    if (bound.status !== 'bound') throw Error();
    const chosen = selectV56AcceptedCases(
      [{ handKey: HAND_KEY, records: f.records }],
      [{ handKey: HAND_KEY, actionOrdinal: bound.actionOrdinal }]
    );
    expect(chosen[0]!.decisionSha256).toBe(f.records[0]!.sha256);
    expect(bound.actionOrdinal).toBe(f.hand.actions!.length - 1);
  });
  it('refuses filtered-list ordinals, wrong optional SHA and corrupt original custody', () => {
    const f = correctiveFixture(),
      batch = [{ handKey: HAND_KEY, records: f.records }];
    expect(() =>
      selectV56AcceptedCases(batch, [{ handKey: HAND_KEY, actionOrdinal: 0 }])
    ).toThrow();
    expect(() =>
      selectV56AcceptedCases(batch, [
        {
          handKey: HAND_KEY,
          actionOrdinal: f.hand.actions!.length - 1,
          decisionSha256: 'f'.repeat(64),
        },
      ])
    ).toThrow();
    const corrupt = structuredClone(f.records);
    corrupt[0]!.body = '{}';
    expect(() =>
      selectV56AcceptedCases(
        [{ handKey: HAND_KEY, records: corrupt }],
        [{ handKey: HAND_KEY, actionOrdinal: f.hand.actions!.length - 1 }]
      )
    ).toThrow();
  });
});
function publicResult() {
  return {
    version: 'horse-v56-private-process-batch-v1',
    sourceSha256: 'a'.repeat(64),
    results: [
      {
        version: 'horse-v56-private-process-v1',
        status: 'computed',
        isolation: { pid: 100, networkAttempts: { fetch: 0, socket: 0 } },
        result: {
          version: 'horse-v56-private-counterfactual-v1',
          decisionSha256: 'c'.repeat(64),
          readFrameSha256: null,
          onActionSha256: null,
          offActionSha256: null,
          originalExact: false,
          originalAccepted: false,
          v56Observed: false,
          offComputed: false,
          sameAdmissions: false,
          actionChanged: false,
          offAccepted: false,
          activationAllowed: false,
          reason: 'pins_missing',
        },
      },
    ],
  };
}
describe('closed public replay receipt boundary', () => {
  it('retains explicit unavailable proof without claiming qualification', () =>
    expect(v56PublicReplayIsSanitized(publicResult(), ['c'.repeat(64)])).toBe(true));
  it('rejects raw data, unknown reasons, activation claims and attempted networks', () => {
    for (const change of [
      (r: any) => (r.cards = ['As']),
      (r: any) => (r.results[0].result.actor = 'private'),
      (r: any) => (r.results[0].isolation.raw = 'private'),
      (r: any) => (r.results[0].result.reason = 'private_actor'),
      (r: any) => (r.results[0].result.activationAllowed = true),
      (r: any) => (r.results[0].isolation.networkAttempts.fetch = 1),
    ]) {
      const r = publicResult();
      change(r);
      expect(v56PublicReplayIsSanitized(r, ['c'.repeat(64)])).toBe(false);
    }
  });
  it('refuses reordered identities or omitted cases', () => {
    expect(v56PublicReplayIsSanitized(publicResult(), ['d'.repeat(64)])).toBe(false);
    expect(v56PublicReplayIsSanitized(publicResult(), [])).toBe(false);
  });
});

describe('private explicit refusal without provider work', () => {
  it('writes only bounded closed refusal and never raw input/error material', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v56-ingress-'));
    try {
      const input = join(dir, 'input.json'),
        output = join(dir, 'output.json');
      writeFileSync(
        input,
        JSON.stringify({ privateMarker: 'private-hole-card-marker', qualified: true }),
        { mode: 0o600 }
      );
      const r = await runV56PrivateReplay('replay', input, output, {});
      expect(r.code).toBe(2);
      const bytes = readFileSync(output, 'utf8');
      expect(bytes).not.toContain('private-hole-card-marker');
      expect(bytes).toContain('"qualified":false');
      expect(r.output).not.toContain('private-hole-card-marker');
      expect(statSync(output).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('never overwrites an existing private result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'v56-existing-'));
    try {
      const input = join(dir, 'input.json'),
        output = join(dir, 'output.json');
      writeFileSync(input, '{}', { mode: 0o600 });
      writeFileSync(output, 'retained', { mode: 0o600 });
      expect((await runV56PrivateReplay('replay', input, output, {})).code).toBe(3);
      expect(readFileSync(output, 'utf8')).toBe('retained');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
