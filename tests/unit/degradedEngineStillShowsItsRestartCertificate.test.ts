import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { sliceYamlEntry } from '../helpers/sourceWindow';

const workflow = readFileSync(
  resolve(process.cwd(), '.github/workflows/auto-deploy-hetzner.yml'),
  'utf8'
);
const certificate = {
  running: true,
  maintenance: {
    active: true,
    phase: 'counting_down',
    durableConfirmed: true,
    readyForRestart: true,
    unparkedTables: 0,
    remainingMs: 180000,
  },
};

// Execute the actual reader and certificate validator from each deployment
// step. No SSH, seal issuance, Docker command, or production endpoint runs.
function reader(step: string): string {
  const lines = sliceYamlEntry(workflow, step)
    .split('\n')
    .map((line) => line.trim());
  const decode = (line: string) =>
    step === 'id: cutover' ? line.replace(/\\([\\"$`])/g, '$1') : line;
  const fetch = lines.find((line) => line.startsWith('BODY='));
  const validate = lines.find(
    (line) =>
      line.includes('readyForRestart') &&
      (line.startsWith('STATE=') || line.startsWith("printf '%s'"))
  );
  if (!fetch || !validate) throw new Error(`Missing certificate reader in ${step}`);
  const command = decode(fetch).replace('http://127.0.0.1:8080/health', '"$ENGINE_URL/health"');
  const assertion = step === 'id: drain' ? '\ntest "$STATE" = READY' : '';
  return `set -euo pipefail\n${command}\n${decode(validate)}${assertion}`;
}

async function accepts(
  step: string,
  status: number,
  payload: unknown,
  truncated = false
): Promise<boolean> {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const server = createServer((_request, response) => {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body) + (truncated ? 10 : 0),
      Connection: 'close',
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing local HTTP address');
    return await new Promise<boolean>((resolve, reject) => {
      execFile(
        'bash',
        ['-c', reader(step)],
        {
          env: { ...process.env, ENGINE_URL: `http://127.0.0.1:${address.port}` },
          timeout: 5000,
        },
        (error) => {
          if (error?.killed) reject(error);
          else resolve(!error);
        }
      );
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

for (const step of ['id: drain', 'id: cutover']) {
  describe(`${step}: a complete certificate can be read from a degraded engine`, () => {
    it('accepts a complete certificate from HTTP 200', async () => {
      expect(await accepts(step, 200, certificate)).toBe(true);
    });
    it('accepts the same complete certificate from HTTP 503', async () => {
      expect(await accepts(step, 503, certificate)).toBe(true);
    });
    it.each([
      ['inactive', { active: false }],
      ['last hand', { phase: 'last_hand' }],
      ['not durable', { durableConfirmed: false }],
      ['not ready', { readyForRestart: false }],
      ['unparked table', { unparkedTables: 1 }],
      ['insufficient grace', { remainingMs: 179999 }],
    ] as const)('rejects HTTP 503 with %s', async (_name, change) => {
      expect(
        await accepts(step, 503, {
          ...certificate,
          maintenance: { ...certificate.maintenance, ...change },
        })
      ).toBe(false);
    });
    it('rejects HTTP 503 without a certificate', async () => {
      expect(await accepts(step, 503, { running: true })).toBe(false);
    });
    it('rejects a malformed HTTP 503 response', async () => {
      expect(await accepts(step, 503, '{broken')).toBe(false);
    });
    it('rejects other HTTP errors even if their body resembles a certificate', async () => {
      expect(await accepts(step, 500, certificate)).toBe(false);
    });
    it('rejects a failed transfer even if the bytes received form valid JSON', async () => {
      expect(await accepts(step, 503, certificate, true)).toBe(false);
    });
  });
}

it('the final host check still rejects an engine that is not running', async () => {
  expect(await accepts('id: cutover', 503, { ...certificate, running: false })).toBe(false);
});
