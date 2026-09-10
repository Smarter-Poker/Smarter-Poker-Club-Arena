/**
 * LAW: tournament lifecycle code cannot pay one fragment at a time.
 *
 * The generic obligation function remains private database plumbing beneath
 * the domain settlement transactions. Runtime TypeScript may call only a
 * complete domain authority and then validate its immutable receipt. This
 * prevents a timeout, crash, or recovery pass from paying cash while leaving
 * bounty, rake, escrow, or tournament status for a later reconciler.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const SERVER_SRC = join(__dirname, '..');
const BANNED_RPCS = [
  'fn_credit_and_log',
  'credit_player_wallet',
  'fn_credit_player_wallet_once',
  'fn_settle_tournament_obligation',
  // Stage 2 retires these database compatibility doors. Runtime already uses
  // the one DB-first terminal transaction, so keeping a TypeScript caller (or
  // transport helper) would preserve a second finish path after the cutover.
  'fn_claim_tournament_finish',
  'fn_certify_tournament_finish',
] as const;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) out.push(full);
  }
  return out;
}

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

function rpcCallSites(source: string, names: readonly string[]): number[] {
  const code = stripComments(source);
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const hits = new Set<number>();
  const literal = new RegExp(`\\.rpc\\s*\\(\\s*(['"\`])(${escaped})\\1`, 'g');
  for (const match of code.matchAll(literal)) {
    hits.add(code.slice(0, match.index ?? 0).split('\n').length);
  }
  const binding = new RegExp(
    `\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(['"\`])(${escaped})\\2`,
    'g'
  );
  for (const assignment of code.matchAll(binding)) {
    const identifier = assignment[1];
    const use = new RegExp(`\\.rpc\\s*\\(\\s*${identifier}\\b`, 'g');
    for (const match of code.matchAll(use)) {
      hits.add(code.slice(0, match.index ?? 0).split('\n').length);
    }
  }
  return [...hits].sort((a, b) => a - b);
}

describe('one terminal authority owns each tournament finish', () => {
  const files = tsFiles(SERVER_SRC);
  const terminalRpc = stripComments(
    readFileSync(join(__dirname, 'terminalSettlementRpc.ts'), 'utf8')
  );

  it('scans the real runtime tree', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(
      files.some((file) => file.endsWith('/tournament/TournamentManagerEliminations.ts'))
    ).toBe(true);
  });

  it('runtime TypeScript never calls a fragment payer or a retired finish door', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const line of rpcCallSites(readFileSync(file, 'utf8'), BANNED_RPCS)) {
        offenders.push(`server/src/${relative(SERVER_SRC, file).replace(/\\/g, '/')}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the live cash finish and recovery share the terminal transaction', () => {
    const live = stripComments(
      readFileSync(join(__dirname, 'TournamentManagerEliminations.ts'), 'utf8')
    );
    const recovery = stripComments(readFileSync(join(__dirname, 'tournamentRecovery.ts'), 'utf8'));
    const liveFinish = live.slice(live.indexOf('protected async finishTournament'));
    const recoveryFinish = recovery.slice(
      recovery.indexOf('export async function recoverStuckCompletingTournaments')
    );

    for (const source of [liveFinish, recoveryFinish]) {
      expect(source).toMatch(/requestTournamentTerminalReceipt\s*\(/);
      expect(source).not.toMatch(/rpc\(\s*'fn_settle_tournament_(?:places|final_table_deal|rake)'/);
      expect(source).not.toMatch(/rpc\(\s*'fn_(?:mystery_bounty_settle|finalize_bounty_pool)'/);
      expect(source).not.toMatch(
        /\.from\(\s*'tournaments'\s*\)[\s\S]*?\.update\(\s*\{[\s\S]*?status:\s*'COMPLETED'/
      );
    }
    expect(terminalRpc).toMatch(/rpc\(\s*'fn_complete_tournament_terminal'/);
    expect(terminalRpc).toMatch(/verifyTournamentCompletionReceipt\s*\(/);
  });

  it('the final-table deal carries exact consent through the terminal transaction and resolver', () => {
    const source = stripComments(
      readFileSync(join(__dirname, 'TournamentManagerEliminations.ts'), 'utf8')
    );
    const deal = sliceMethod(source, 'completeFinalTableDealAtBoundary(\n    tableId: string,');
    expect(deal.match(/requestTournamentTerminalReceipt\s*\(/g)).toHaveLength(1);
    expect(deal).toMatch(
      /requestTournamentTerminalReceipt\(\s*this\.tournamentId,\s*'final_table_deal',\s*null,\s*\{\s*dealProposal:\s*\{\s*proposalId:\s*consensus\.proposalId,\s*revision:\s*consensus\.revision\s*\}\s*\}\s*\)/
    );
    expect(terminalRpc).toMatch(
      /const proposalRequest = dealProposal\s*\?\s*\{\s*\.\.\.request,\s*p_proposal_id:\s*dealProposal\.proposalId,\s*p_revision:\s*dealProposal\.revision,?\s*\}\s*:\s*null/
    );
    expect(terminalRpc).toMatch(
      /proposalRequest\s*\?\s*await supabase\.rpc\('fn_complete_tournament_terminal_proposal',\s*proposalRequest\)/
    );
    expect(terminalRpc).toMatch(
      /proposalRequest\s*\?\s*await supabase\.rpc\('fn_resolve_tournament_terminal_proposal_outcome',\s*proposalRequest\)/
    );
    expect(terminalRpc).toContain('receipt && proposalIdentityIsExact(data)');
    expect(terminalRpc).toContain('proposalIdentityIsExact(outcome)');
    expect(terminalRpc).toContain('receipt && proposalIdentityIsExact(outcome.receipt)');
  });

  it('the scanner catches literal and indirect regressions', () => {
    for (const mutation of [
      `s.rpc('fn_credit_and_log', {})`,
      `s.rpc("fn_settle_tournament_obligation", {})`,
      'const PAY = `credit_player_wallet`; s.rpc(PAY, {})',
      `s.rpc('fn_claim_tournament_finish', {})`,
      'const FINISH = `fn_certify_tournament_finish`; s.rpc(FINISH, {})',
    ]) {
      expect(rpcCallSites(mutation, BANNED_RPCS).length, mutation).toBeGreaterThan(0);
    }
    expect(
      rpcCallSites(`// s.rpc('fn_credit_and_log', {})\nconst safe = true;`, BANNED_RPCS)
    ).toEqual([]);
  });
});
