/**
 * LAW: one settle path for tournament money.
 * ═══════════════════════════════════════════════════════════════════════════
 * docs/CHIP-ACCOUNTING-STANDARD.md 3.2 step 5 and rule R3: the ONLY function
 * that credits a player from a tournament is `fn_settle_tournament_obligation`,
 * and the only engine module that calls it is `settleObligation.ts`.
 *
 * Why this is a law and not a preference (2.2, measured 2026-09-02): eleven
 * independent payers, each with its own idempotency key and its own idea of
 * what was owed, overpaid the four MTT variants by 5,330 chips in 36 hours -
 * 24% of everything they collected. Every one of those payers was correct on
 * its own terms. The defect was that there were eleven of them.
 *
 * Two pins:
 *
 *   (a) SOURCE SCAN. No file under server/src except settleObligation.ts may
 *       call `fn_credit_and_log`, `credit_player_wallet` or
 *       `fn_credit_player_wallet_once` through `.rpc(`. A new tournament
 *       payer written against the old primitives fails here, in the commit
 *       that writes it, with the file and line.
 *
 *   (b) A REFUSED SETTLE IS LOUD AND NEVER STRANDS A FINISH. When the database
 *       answers `ok: false, refused_reason: 'escrow_short'`, the helper raises
 *       a CRITICAL `Tournament.escrow_short` financial alert, does NOT retry
 *       (the answer will not change; asking again is how double payments were
 *       born), and does NOT throw (a finish loop with nine places to pay must
 *       reach the other eight).
 *
 * Negative controls are in the test bodies: each pin is also asserted to go
 * red on the mutation it exists to catch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const alerts = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('../services/financialAlerts.js', () => ({
  raiseFinancialAlert: vi.fn(async (...args: unknown[]) => {
    alerts.calls.push(args);
    return { persisted: true, alertId: 'alert-1' };
  }),
}));
vi.mock('../services/errorReporter.js', () => ({
  reportError: vi.fn(),
}));
vi.mock('../services/supabase.js', () => ({
  supabase: { rpc: vi.fn() },
}));

import {
  settleTournamentObligation,
  RPC_NAME,
  ESCROW_SHORT,
  TRANSPORT_REFUSAL,
  type SettleRpcClient,
} from './settleObligation.js';

const SERVER_SRC = join(__dirname, '..');
const ONLY_CALLER = 'tournament/settleObligation.ts';

/**
 * Non-tournament credit primitives that are allowed to keep their own RPC.
 * Each entry is an exact path relative to server/src with the reason it is
 * not a tournament payer. Adding a tournament path here is a law violation.
 */
const ALLOWED_NON_TOURNAMENT_CALLERS: Record<string, string> = {
  // (none today) - cash-table refunds go through atomic_credit_wallet_and_log,
  // rakeback and leaderboards through their own batch RPCs; neither of those
  // names is in the banned list. If a legitimate non-tournament caller of a
  // banned primitive appears, register it here with the reason, by exact path.
};

const BANNED = ['fn_credit_and_log', 'credit_player_wallet', 'fn_credit_player_wallet_once'];
const BANNED_CALL = new RegExp(`\\.rpc\\(\\s*['"\`](${BANNED.join('|')})['"\`]`);

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

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

function bannedCallSites(src: string): number[] {
  const lines = stripComments(src).split('\n');
  const hits: number[] = [];
  lines.forEach((line, i) => {
    if (BANNED_CALL.test(line)) hits.push(i + 1);
  });
  return hits;
}

describe('LAW (a): only settleObligation.ts may credit a player from a tournament', () => {
  const files = tsFiles(SERVER_SRC);

  it('scans a real tree (guards the walker against silently matching nothing)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => relative(SERVER_SRC, f) === ONLY_CALLER)).toBe(true);
  });

  it('no engine file calls fn_credit_and_log / credit_player_wallet / fn_credit_player_wallet_once', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(SERVER_SRC, file).replace(/\\/g, '/');
      if (rel === ONLY_CALLER) continue;
      if (rel in ALLOWED_NON_TOURNAMENT_CALLERS) continue;
      for (const line of bannedCallSites(readFileSync(file, 'utf8'))) {
        offenders.push(`server/src/${rel}:${line}`);
      }
    }
    expect(
      offenders,
      `These sites credit a player directly. A tournament payer must call ` +
        `settleTournamentObligation() (server/src/tournament/settleObligation.ts); ` +
        `a genuine non-tournament caller must be registered in ALLOWED_NON_TOURNAMENT_CALLERS ` +
        `by exact path with the reason.\n  ${offenders.join('\n  ')}`
    ).toEqual([]);
  });

  it('settleObligation.ts itself calls only the obligation RPC, never a banned primitive', () => {
    const src = stripComments(readFileSync(join(SERVER_SRC, ONLY_CALLER), 'utf8'));
    expect(bannedCallSites(src)).toEqual([]);
    expect(src).toContain(`'fn_settle_tournament_obligation'`);
    expect(RPC_NAME).toBe('fn_settle_tournament_obligation');
  });

  it('every allow-list entry is an exact existing path with a stated reason', () => {
    for (const [path, reason] of Object.entries(ALLOWED_NON_TOURNAMENT_CALLERS)) {
      expect(files.map((f) => relative(SERVER_SRC, f).replace(/\\/g, '/'))).toContain(path);
      expect(path.startsWith('tournament/')).toBe(false);
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it('NEGATIVE CONTROL: the scanner catches a direct credit written into a tournament file', () => {
    const mutated =
      readFileSync(join(SERVER_SRC, 'tournament/tournamentRecovery.ts'), 'utf8') +
      `\nasync function leak(s: any) { await s.rpc('fn_credit_and_log', { p_user_id: 'x' }); }\n`;
    expect(bannedCallSites(mutated).length).toBeGreaterThan(0);
    // ...and a comment mentioning the name is not a call.
    expect(bannedCallSites(`// supabase.rpc('fn_credit_and_log', {})\nconst x = 1;`)).toEqual([]);
  });
});

function client(answers: Array<{ data?: unknown; error?: { message: string } | null } | Error>) {
  const rpc = vi.fn(async () => {
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return { data: next?.data ?? null, error: next?.error ?? null };
  });
  return { rpc } as unknown as SettleRpcClient & { rpc: ReturnType<typeof vi.fn> };
}

const INPUT = {
  tournamentId: '11111111-2222-3333-4444-555555555555',
  kind: 'place' as const,
  place: 3,
  userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  amount: 120,
  source: 'law.test',
  memo: 'Tournament prize: position 3',
};

const NO_DELAY = { retryDelayMs: () => 0 };

describe('LAW (b): a refused settle raises the critical alert and does not throw', () => {
  beforeEach(() => {
    alerts.calls.length = 0;
  });

  it('escrow_short -> critical Tournament.escrow_short, one RPC call, ok:false returned', async () => {
    const c = client([
      { data: { ok: false, paid: 0, already_paid: 0, refused_reason: ESCROW_SHORT } },
      { data: { ok: true, paid: 120, already_paid: 0 } }, // must never be reached
    ]);
    const res = await settleTournamentObligation(c, INPUT, NO_DELAY);

    expect(res.ok).toBe(false);
    expect(res.refused_reason).toBe(ESCROW_SHORT);
    expect(res.paid).toBe(0);
    // Never retried: the database said no.
    expect(c.rpc).toHaveBeenCalledTimes(1);

    expect(alerts.calls).toHaveLength(1);
    const [severity, source, message, context] = alerts.calls[0] as [
      string,
      string,
      string,
      Record<string, unknown>,
    ];
    expect(severity).toBe('critical');
    expect(source).toBe('Tournament.escrow_short');
    expect(message).toMatch(/NOT paid/);
    expect(context.tournament_id).toBe(INPUT.tournamentId);
    expect(context.user_id).toBe(INPUT.userId);
    expect(context.kind).toBe('place');
    expect(context.place).toBe(3);
    expect(context.amount_owed).toBe(120);
    expect(context.dedupe_key).toBe(`${ESCROW_SHORT}:${INPUT.tournamentId}:place:place:3`);
  });

  it('the RPC is called with the documented signature', async () => {
    const c = client([{ data: { ok: true, paid: 120, already_paid: 0 } }]);
    await settleTournamentObligation(c, INPUT, NO_DELAY);
    expect(c.rpc).toHaveBeenCalledWith('fn_settle_tournament_obligation', {
      p_tournament_id: INPUT.tournamentId,
      p_kind: 'place',
      p_place: 3,
      p_user_id: INPUT.userId,
      p_amount: 120,
      p_source: 'law.test',
      p_description: 'Tournament prize: position 3',
      p_adjustment_id: null,
    });
  });

  it('a user-keyed kind sends p_place null and dedupes the alert on the user', async () => {
    const c = client([{ data: { ok: false, refused_reason: ESCROW_SHORT } }]);
    const res = await settleTournamentObligation(
      c,
      { ...INPUT, kind: 'refund', place: undefined },
      NO_DELAY
    );
    expect(res.ok).toBe(false);
    expect(c.rpc.mock.calls[0][1]).toMatchObject({ p_kind: 'refund', p_place: null });
    const context = alerts.calls[0][3] as Record<string, unknown>;
    expect(context.dedupe_key).toBe(
      `${ESCROW_SHORT}:${INPUT.tournamentId}:refund:user:${INPUT.userId}`
    );
  });

  it('a replay (ok:true, paid:0) is not a refusal and raises nothing', async () => {
    const c = client([{ data: { ok: true, paid: 0, already_paid: 120 } }]);
    const res = await settleTournamentObligation(c, INPUT, NO_DELAY);
    expect(res.ok).toBe(true);
    expect(res.paid).toBe(0);
    expect(res.already_paid).toBe(120);
    expect(alerts.calls).toHaveLength(0);
  });

  it('a jsonb answer that arrives as a string is parsed', async () => {
    const c = client([{ data: JSON.stringify({ ok: true, paid: 120, already_paid: 0, obligation_id: 'o-1' }) }]);
    const res = await settleTournamentObligation(c, INPUT, NO_DELAY);
    expect(res).toMatchObject({ ok: true, paid: 120, obligation_id: 'o-1' });
  });

  it('transport errors ARE retried (3 attempts) and then reported as transport, not thrown', async () => {
    const c = client([
      { error: { message: 'fetch failed' } },
      new Error('socket hang up'),
      { error: { message: 'timeout' } },
    ]);
    const res = await settleTournamentObligation(c, INPUT, NO_DELAY);
    expect(c.rpc).toHaveBeenCalledTimes(3);
    expect(res.ok).toBe(false);
    expect(res.refused_reason).toBe(TRANSPORT_REFUSAL);
    expect(res.transport_error).toBe('timeout');
    // Transport is not a refusal: no escrow alert, the caller raises its own.
    expect(alerts.calls).toHaveLength(0);
  });

  it('a transport error followed by success settles once', async () => {
    const c = client([{ error: { message: 'fetch failed' } }, { data: { ok: true, paid: 120 } }]);
    const res = await settleTournamentObligation(c, INPUT, NO_DELAY);
    expect(res.ok).toBe(true);
    expect(c.rpc).toHaveBeenCalledTimes(2);
  });

  it('an unknown refusal reason is still escalated, under its own name', async () => {
    const c = client([{ data: { ok: false, refused_reason: 'tournament_not_found' } }]);
    const res = await settleTournamentObligation(c, INPUT, NO_DELAY);
    expect(res.ok).toBe(false);
    expect(c.rpc).toHaveBeenCalledTimes(1);
    expect(alerts.calls[0][0]).toBe('critical');
    expect(alerts.calls[0][1]).toBe('Tournament.obligation_refused');
  });

  it('nothing owed is not a call', async () => {
    const c = client([]);
    const res = await settleTournamentObligation(c, { ...INPUT, amount: 0 }, NO_DELAY);
    expect(res.ok).toBe(true);
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it('NEGATIVE CONTROL: a helper that swallowed the refusal or threw would fail the pin', async () => {
    // Model the two regressions the pin exists to catch and run the pin's own
    // assertions against them, so the assertions are known to discriminate.
    const silent = async () => ({ ok: false, refused_reason: ESCROW_SHORT, paid: 0 });
    const throwing = async () => {
      throw new Error('escrow_short');
    };

    await silent();
    expect(alerts.calls).toHaveLength(0); // the pin demands 1 - this shape would fail it
    await expect(throwing()).rejects.toThrow(); // the pin awaits without try/catch - this shape would fail it

    // And the real helper passes both: it alerts, and it resolves.
    const res = await settleTournamentObligation(
      client([{ data: { ok: false, refused_reason: ESCROW_SHORT } }]),
      INPUT,
      NO_DELAY
    );
    expect(res.ok).toBe(false);
    expect(alerts.calls).toHaveLength(1);
  });
});
