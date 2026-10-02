import { createServer, get } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cashierTotalsObservation } from './e2e/support/cashierTotalsObservation';

const valid = {
  authorized: true,
  scope: 'all',
  totals: { in: '12.00', out: '0.00', managed: '3.50', count: 2 },
};
const success = {
  httpStatus: 200,
  authorized: true,
  scope: 'all',
  scopeMatchesPage: true,
  validTotals: true,
};
const server = createServer((req, res) => {
  res.writeHead(req.url === '/timeout' ? 500 : 200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify(req.url === '/timeout' ? { code: '57014', message: 'statement timeout' } : valid)
  );
});
let origin: string;
const read = (path: string) =>
  new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    get(`${origin}${path}`, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (part) => {
        text += part;
      });
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) });
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    }).on('error', reject);
  });
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no local test listener');
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

describe('production totals proof reads the actual response', () => {
  it('accepts a real HTTP 200 authorized totals response', async () => {
    const response = await read('/healthy');
    expect(cashierTotalsObservation(response.status, response.body, 'all')).toEqual(success);
  });
  it('rejects the demonstrated HTTP 500 timeout even when the UI can render Unavailable', async () => {
    const response = await read('/timeout');
    const observed = cashierTotalsObservation(response.status, response.body, 'all');
    expect(observed).toMatchObject({ httpStatus: 500, authorized: null, validTotals: false });
    expect(observed).not.toEqual(success);
  });
  it.each([
    [500, valid],
    [null, null],
    [200, { ...valid, authorized: false }],
    [200, { ...valid, scope: 'self' }],
    [200, { ...valid, scope: 'none' }],
    [200, { ...valid, scope: ['all'] }],
    [200, { ...valid, totals: { ...valid.totals, count: -1 } }],
    [200, { ...valid, totals: { ...valid.totals, count: Number.MAX_SAFE_INTEGER + 1 } }],
    [200, { ...valid, totals: { ...valid.totals, in: '-1.00' } }],
    [200, { ...valid, totals: { ...valid.totals, managed: null } }],
    [200, { ...valid, totals: [] }],
  ])('refuses malformed, missing, denied or scope-changed evidence %j', (status, payload) => {
    expect(cashierTotalsObservation(status as number | null, payload, 'all')).not.toEqual(success);
  });
  it('retains only the verdict, never financial amounts or identities', () => {
    expect(
      cashierTotalsObservation(200, { ...valid, viewer: 'private', rows: ['private'] }, 'all')
    ).toEqual(success);
  });
  it('the existing production spec requires and attaches the verdict without another request', () => {
    const spec = readFileSync('tests/e2e/production-cashier-statements.spec.ts', 'utf8');
    expect(spec).toContain('cashier-statement-totals-verdict.json');
    expect(spec).toContain('const totalsResponse = await totalsRpc;');
    expect(spec).toMatch(/expect\(\s*totalsObservation,/);
    expect(spec).toContain(".toBe('figures')");
    expect(spec).not.toContain('.toMatch(/^(figures|unavailable)$/)');
    expect(spec).not.toMatch(/(?:fetch|\.rpc)\(/);
  });
});
