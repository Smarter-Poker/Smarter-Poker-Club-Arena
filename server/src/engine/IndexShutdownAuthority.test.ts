import { AsyncResource } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  bindTournamentDataAuthority,
  currentTournamentDataAuthority,
  runWithTournamentDataAuthority,
} from '../services/supabase/dataActorContext.js';

const a = {
  tournamentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  leaseGeneration: '11111111-1111-4111-8111-111111111111',
};
const b = {
  tournamentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  leaseGeneration: '22222222-2222-4222-8222-222222222222',
};

function actualShutdown(performShutdown: () => Promise<void>) {
  // Execute the production closure without starting listeners or money services.
  const source = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');
  const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((d) => d.name.getText(tree) === 'shutdown')
  );
  if (!declaration) throw new Error('Production shutdown declaration missing');
  const js = ts.transpileModule(declaration.getText(tree), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return runInNewContext(
    'let shutdownOperation = null; let shuttingDown = false; ' + js + '; shutdown',
    { AsyncResource, performShutdown }
  ) as () => Promise<void>;
}

describe('process shutdown restores bootstrap authority', () => {
  it('drains multiple bound managers when a fatal callback originates in manager A', async () => {
    const seen: string[] = [];
    const stops = [a, b].map((authority) =>
      bindTournamentDataAuthority(authority, async () => {
        expect(currentTournamentDataAuthority()).toEqual(authority);
        await Promise.resolve();
        expect(currentTournamentDataAuthority()).toEqual(authority);
        expect(() => runWithTournamentDataAuthority(authority === a ? b : a, () => {})).toThrow(
          'cannot be rebound'
        );
        seen.push(authority.tournamentId);
      })
    );
    const shutdown = actualShutdown(async () => {
      await Promise.all(stops.map((stop) => stop()));
      expect(currentTournamentDataAuthority()).toBeNull();
    });
    await runWithTournamentDataAuthority(a, async () => {
      await shutdown();
      expect(currentTournamentDataAuthority()).toEqual(a);
    });
    expect(seen.sort()).toEqual([a.tournamentId, b.tournamentId]);
  });

  it('joins the same pending shutdown across different manager callers', async () => {
    let release!: () => void;
    const work = vi.fn(
      () =>
        new Promise<void>((r) => {
          release = r;
        })
    );
    const shutdown = actualShutdown(work);
    let first!: Promise<void>, second!: Promise<void>;
    runWithTournamentDataAuthority(a, () => {
      first = shutdown();
    });
    runWithTournamentDataAuthority(b, () => {
      second = shutdown();
    });
    expect(first).toBe(second);
    expect(work).toHaveBeenCalledOnce();
    release();
    await first;
  });

  it('preserves a rejected ownership drain and never retries it as success', async () => {
    const failure = new Error('ownership barrier failed');
    const work = vi.fn(async () => {
      throw failure;
    });
    const shutdown = actualShutdown(work);
    await expect(runWithTournamentDataAuthority(a, () => shutdown())).rejects.toBe(failure);
    await expect(runWithTournamentDataAuthority(b, () => shutdown())).rejects.toBe(failure);
    expect(work).toHaveBeenCalledOnce();
  });
});
