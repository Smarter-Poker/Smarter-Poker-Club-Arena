import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FROM_REFERENCE,
  RPC_REFERENCE,
  namesMissingFromLive,
  namesNeedingLiveProof,
} from '../../scripts/ci/phantom-live-proof-policy.mjs';

const root = resolve(__dirname, '..', '..');
const checker = readFileSync(resolve(root, 'scripts/ci/check-phantom-tables.mjs'), 'utf8');

describe('a branch cannot publish an RPC caller before its database authority', () => {
  it('requires live proof for a name introduced after the comparison tree', () => {
    expect(
      namesNeedingLiveProof({
        currentNames: ['fn_old', 'fn_new'],
        baseSourceNames: ['fn_old'],
        baseManifestNames: [],
        baseAllowNames: [],
      })
    ).toEqual(['fn_new']);
  });

  it('accepts an offline caller only when schema-first truth was already in the base', () => {
    expect(
      namesNeedingLiveProof({
        currentNames: ['fn_ready'],
        baseSourceNames: [],
        baseManifestNames: ['fn_ready'],
        baseAllowNames: [],
      })
    ).toEqual([]);
  });

  it('does not confuse reachable live schema with proof that the function exists', () => {
    expect(namesMissingFromLive(['fn_new'], [])).toEqual(['fn_new']);
    expect(namesMissingFromLive(['fn_new'], ['fn_new'])).toEqual([]);
  });

  it('detects static template-literal names on both table and RPC calls', () => {
    RPC_REFERENCE.lastIndex = 0;
    FROM_REFERENCE.lastIndex = 0;
    expect(RPC_REFERENCE.exec('client.rpc(`fn_new`) ')?.[1]).toBe('fn_new');
    expect(FROM_REFERENCE.exec('client.from(`new_table`) ')?.[1]).toBe('new_table');
  });

  it('uses only base-tree manifests and exemptions, never current-branch claims', () => {
    expect(checker).toContain("gitTreeFile(tree, 'scripts/ci/supabase-schema-manifest.json')");
    expect(checker).toContain("gitTreeFile(tree, 'scripts/ci/supabase-invariants.allowlist.json')");
    expect(checker).toContain('baseManifestNames: baseManifest.functions');
    expect(checker).toContain('baseAllowNames: []');
    expect(checker).not.toContain('baseManifestNames: realFns');
    expect(checker).not.toContain('baseAllowNames: allowRpcs');
    expect(checker).not.toContain("'HEAD~1^{commit}'");
    expect(checker).toContain('fetch the target branch or pass --base-ref=<target>');
    const loader = checker.slice(
      checker.indexOf('function loadBaseManifest'),
      checker.indexOf('const fromRefs')
    );
    expect(loader).not.toContain('schema-manifest.d');
  });

  it('fails pending branch-new names when live proof is unavailable', () => {
    const unavailable = checker.indexOf('if (live === UNAVAILABLE)');
    const inheritedPass = checker.indexOf('unresolved reference was already present', unavailable);
    const finalExit = checker.lastIndexOf('process.exit(1)');
    expect(unavailable).toBeGreaterThan(-1);
    expect(checker.slice(unavailable, inheritedPass)).toContain(
      'addMissingEntries(phantomRpcs, pendingRpcProof, rpcRefs)'
    );
    expect(finalExit).toBeGreaterThan(inheritedPass);
    expect(checker).toContain('if (WARN_ONLY)');
  });

  it('reads the comparison tree in one git batch instead of one process per source file', () => {
    expect(checker).toContain("execFileSync('git', ['cat-file', '--batch']");
    expect(checker).toContain('gitTreeSourceCache');
  });
});
