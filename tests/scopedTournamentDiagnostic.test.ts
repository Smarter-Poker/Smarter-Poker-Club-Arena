import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  diagnosticSelection,
  readTournamentDiagnostics,
} from '../scripts/ci/read-scoped-tournament-diagnostic.mjs';

const tournamentId = '00000000-0000-4000-8000-000000000001';
const tableId = '00000000-0000-4000-8000-000000000002';
const secret = 'isolated-fixture-credential';
const event = () => ({
  action: 'audit-production-integrity',
  client_payload: { tournament_diagnostic: [{ tournamentId, tableIds: [tableId] }] },
});
const health = { version: 'abcdef012345', instanceId: '1-abcd1234' };
const diagnostic = {
  schema: 'tournament-lifecycle-diagnostic/v1',
  diagnosticOnly: true,
  tournamentId,
  owners: [],
  unavailableOwners: 1,
};
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
const fetcher = () =>
  vi
    .fn()
    .mockResolvedValueOnce(response(health))
    .mockResolvedValueOnce(response(diagnostic))
    .mockResolvedValueOnce(response(health));

describe('bounded original-owner tournament observation', () => {
  it('reads actual local HTTP framing and refuses an authenticated redirect without following it', async () => {
    const requests: { path: string; authorized: boolean }[] = [];
    let redirect = false;
    const server = createServer((req, res) => {
      requests.push({
        path: req.url ?? '',
        authorized: req.headers.authorization === `Bearer ${secret}`,
      });
      if (req.url?.startsWith('/health')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(health));
      } else if (redirect) {
        res.writeHead(302, { Location: '/credential-sink' });
        res.end();
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(diagnostic));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local fixture unavailable');
    // Execute the maintained reader in real Node, independent of happy-dom's
    // browser fetch/CORS implementation used by this repository's UI suite.
    const child = `
      import { readTournamentDiagnostics } from ${JSON.stringify(pathToFileURL(resolve('scripts/ci/read-scoped-tournament-diagnostic.mjs')).href)};
      const local = (url, options) => {
        const path = new URL(url);
        return fetch('http://127.0.0.1:${address.port}' + path.pathname + path.search, options);
      };
      const result = await readTournamentDiagnostics(${JSON.stringify(event())}, ${JSON.stringify(secret)}, local);
      console.log(JSON.stringify(result));
    `;
    const run = () =>
      promisify(execFile)(process.execPath, ['--input-type=module', '-e', child], {
        timeout: 15_000,
      });
    try {
      const result = JSON.parse((await run()).stdout);
      expect(result.snapshots).toHaveLength(1);
      expect(requests.map((r) => r.authorized)).toEqual([false, true, false]);
      redirect = true;
      await expect(run()).rejects.toThrow('transport unavailable');
      expect(requests.some((r) => r.path === '/credential-sink')).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('uses only fixed-origin GETs, contains authority only on the internal request, and retains unknown coverage', async () => {
    const read = fetcher();
    const result = await readTournamentDiagnostics(event(), secret, read);
    expect(read).toHaveBeenCalledTimes(3);
    for (const [url, options] of read.mock.calls) {
      expect(new URL(url).origin).toBe('https://engine.smarter.poker');
      expect(options).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store' });
    }
    expect(read.mock.calls[0][1].headers).toEqual({});
    expect(read.mock.calls[2][1].headers).toEqual({});
    expect(read.mock.calls[1][1].headers).toEqual({ Authorization: `Bearer ${secret}` });
    expect(new URL(read.mock.calls[1][0]).searchParams.get('table_ids')).toBe(tableId);
    expect(result.snapshots[0].snapshot.unavailableOwners).toBe(1);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it.each([
    { action: 'schedule' },
    { action: 'audit-production-integrity', client_payload: { tournament_diagnostic: [] } },
    {
      action: 'audit-production-integrity',
      client_payload: {
        tournament_diagnostic: Array(3).fill({ tournamentId, tableIds: [tableId] }),
      },
    },
    {
      action: 'audit-production-integrity',
      client_payload: {
        tournament_diagnostic: [
          { tournamentId, tableIds: [tableId], url: 'https://elsewhere.invalid' },
        ],
      },
    },
    {
      action: 'audit-production-integrity',
      client_payload: {
        tournament_diagnostic: [{ tournamentId: '../action', tableIds: [tableId] }],
      },
    },
    {
      action: 'audit-production-integrity',
      client_payload: {
        tournament_diagnostic: [{ tournamentId, tableIds: Array(9).fill(tableId) }],
      },
    },
    {
      action: 'audit-production-integrity',
      client_payload: {
        tournament_diagnostic: [{ tournamentId, tableIds: [tableId, tableId.toUpperCase()] }],
      },
    },
  ])('refuses invalid scope before any authenticated request %#', async (invalid) => {
    const read = vi.fn();
    await expect(readTournamentDiagnostics(invalid, secret, read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it('normalizes exact UUID scope and refuses duplicate tournaments', () => {
    expect(diagnosticSelection(event())).toEqual([{ tournamentId, tableIds: [tableId] }]);
    const request = event();
    request.client_payload.tournament_diagnostic.push({ tournamentId, tableIds: [tableId] });
    expect(() => diagnosticSelection(request)).toThrow('Duplicate');
  });

  it.each([401, 403, 503])('does not retry or echo a refused HTTP%s body', async (status) => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(response(health))
      .mockResolvedValueOnce(new Response(secret, { status }));
    await expect(readTournamentDiagnostics(event(), secret, read)).rejects.toThrow(
      'HTTP read unavailable'
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each([
    { ...diagnostic, tournamentId: tableId },
    { ...diagnostic, schema: 'other' },
    { ...diagnostic, diagnosticOnly: false },
    { ...diagnostic, error: secret },
  ])('refuses mismatched or credential-bearing diagnostic evidence %#', async (value) => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(response(health))
      .mockResolvedValueOnce(response(value));
    await expect(readTournamentDiagnostics(event(), secret, read)).rejects.toThrow();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('refuses a changed live engine instead of certifying mixed process evidence', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(response(health))
      .mockResolvedValueOnce(response(diagnostic))
      .mockResolvedValueOnce(response({ ...health, instanceId: '2-new' }));
    await expect(readTournamentDiagnostics(event(), secret, read)).rejects.toThrow(
      'Engine changed'
    );
  });

  it('enforces response bytes while streaming, even without content-length', async () => {
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(65537));
      },
      cancel() {
        cancelled = true;
      },
    });
    const read = vi
      .fn()
      .mockResolvedValueOnce(response(health))
      .mockResolvedValueOnce(new Response(body));
    await expect(readTournamentDiagnostics(event(), secret, read)).rejects.toThrow('byte limit');
    expect(cancelled).toBe(true);
  });

  it('does not expose request details from transport exceptions', async () => {
    const read = vi.fn().mockRejectedValue(new Error(secret));
    await expect(readTournamentDiagnostics(event(), secret, read)).rejects.toThrow(
      'Diagnostic transport unavailable'
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('requires explicit dispatch in the existing observer and has no host/SSH/release authority', () => {
    const workflow = readFileSync('.github/workflows/production-integrity-audit.yml', 'utf8');
    const job = workflow.slice(
      workflow.indexOf('  scoped_tournament_diagnostic:'),
      workflow.indexOf('  client_release:')
    );
    expect(job).toContain("github.event_name == 'repository_dispatch'");
    expect(job).toContain('github.event.client_payload.tournament_diagnostic != null');
    expect(job).toContain('node scripts/ci/read-scoped-tournament-diagnostic.mjs');
    expect(job).toContain('contents: read');
    expect(job).not.toMatch(/actions: write|HETZNER|ssh |docker |workflow_dispatch/);
  });
});
