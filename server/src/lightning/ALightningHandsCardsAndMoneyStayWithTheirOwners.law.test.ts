/**
 * LAW (Lightning Phase 6, 2026-09-27): A LIGHTNING HAND'S CARDS REACH ONLY
 * THEIR OWNERS, AND ITS MONEY MOVES ONLY THROUGH SETTLEMENT.
 *
 * A Lightning hand is dealt across players whose chips sit at different
 * anchor tables, by LightningHandHost rather than a table engine. Two things
 * must hold for every such hand, whatever path it takes:
 *
 *   1. CARDS. A player's hole cards travel only in the private `hole_cards`
 *      frame to that player's own room (their pool_session_id) - never in a
 *      room snapshot or a hub event - and another player's cards appear in a
 *      room only once they were tabled at showdown (not folded, not mucked).
 *
 *   2. MONEY. The only call that moves a chip is fn_lightning_settle_hand,
 *      made at most once per hand under one request id. A hand that fails
 *      before it (bad formation, lost lease, a refusal) is abandoned and
 *      settles nothing; no Lightning file writes a seat, a stack or a wallet.
 *      The one thing that follows a SUCCESSFUL settlement is the Bad Beat
 *      Jackpot (remediation 2026-10-01): the hand paid the fee, so it can win
 *      the jackpot, through the physical payout doors (processBBJPayout /
 *      processMiniBBJPayout, idempotent on pool, table and hand) and only
 *      ever after the hand settled.
 *
 * If this fails you are about to leak a card or move money outside the one
 * door that is audited for it. Fix the change, never this law.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning law fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning law fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn() }));
const { mulberry32 } = await import('../engine/HandFuzzer.js');
const kit = await import('../testing/lightningHostTestKit.js');

const code = (f: string) =>
  readFileSync(join(__dirname, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('LAW: a Lightning hand’s cards reach only their owners', () => {
  it('across seeded hands, every private frame is the owner’s and no room sees an untabled card', async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rnd = mulberry32(9000 + seed);
      const n = 2 + (seed % 5);
      const formed = kit.formedHand(n, 6000 + seed * 10);
      const t = kit.buildHost(
        formed,
        Array.from({ length: n }, () => 50 + Math.floor(rnd() * 150))
      );
      await t.host.start();
      // Somebody fast folds ahead of the turn whenever the rules allow it.
      const st = t.host.peekState()!;
      const waiting = st.players.find(
        (p) => p.seat !== st.currentPlayerSeat && st.currentBet - p.bet > 0
      );
      if (waiting && seed % 2 === 0) t.host.handlePlayerAction(waiting.user_id, 'fast_fold');
      await kit.playOut(t.host, rnd);
      await kit.flush();
      const ownerOf = new Map(t.participants.map((p) => [p.poolSessionId, p.playerId]));
      const hole = new Map<string, Array<{ rank: string; suit: string }>>();
      for (const f of t.hub.frames) {
        if (f.kind !== 'private') continue;
        expect(f.userId).toBe(ownerOf.get(f.room));
        expect(f.payload.row.user_id).toBe(ownerOf.get(f.room));
        hole.set(f.userId!, f.payload.row.cards);
      }
      const shown = new Set(
        ((t.host as any).showdown as Array<{ userId: string; mucked?: boolean }>)
          .filter((r) => !r.mucked)
          .map((r) => r.userId)
      );
      for (const f of t.hub.frames) {
        if (f.kind === 'private') continue;
        expect(f.payload.kind).not.toBe('hole_cards');
        const json = JSON.stringify(f.payload);
        for (const [pid, cards] of hole) {
          if (pid === ownerOf.get(f.room) || shown.has(pid)) continue;
          for (const c of cards)
            expect(json).not.toContain(`{"rank":"${c.rank}","suit":"${c.suit}"}`);
        }
      }
    }
  });

  it('the host sends hole cards only through sendToUser', () => {
    const src = code('LightningHandHost.ts');
    const at = [...src.matchAll(/'hole_cards'/g)].map((m) => m.index!);
    expect(at.length).toBe(1);
    expect(src.slice(at[0] - 80, at[0])).toContain('sendToUser(room, playerId');
    expect(src).not.toMatch(/emitEvent\([^)]*holeCards/);
    expect(src).not.toMatch(/publish\([^)]*holeCards/);
  });
});

describe('LAW: a Lightning hand’s money moves only through settlement', () => {
  it('a voided hand settles nothing, and a settled one settles exactly once', async () => {
    const lost = kit.buildHost(kit.formedHand(3, 7000), [100, 100, 100], { lease: () => null });
    await lost.host.start();
    expect(lost.host.lifecycle).toBe('abandoned');
    expect(lost.calls.settle).toEqual([]);

    const retried = kit.buildHost(kit.formedHand(2, 7100), [100, 100], {
      settleScript: ['transport', 'ok'],
    });
    await retried.host.start();
    await kit.playOut(retried.host, mulberry32(1));
    await kit.flush();
    expect(retried.calls.settle.length).toBe(2);
    expect(new Set(retried.calls.settle.map((s) => s.requestId)).size).toBe(1);
  });

  it('no Lightning source writes a seat, a stack, a wallet or a ledger', () => {
    const files = readdirSync(__dirname).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')
    );
    const money =
      /\.from\(['"][a-z_]+['"]\)[\s\S]{0,120}?\.(update|insert|upsert|delete)\(|fn_ca_commit_hand|fn_cash_|wallet|table_seats/;
    for (const f of files) expect(code(f), f).not.toMatch(money);
    // The one money door, and the only settlement call site.
    const backend = code('LightningHandBackend.ts');
    expect(backend.match(/'fn_lightning_settle_hand'/g)?.length).toBe(1);
    const host = code('LightningHandHost.ts');
    expect(host.match(/backend\.settle\(/g)?.length).toBe(1);
  });

  it('the jackpot is paid only through the physical doors, and only after a settled hand', () => {
    const host = code('LightningHandHost.ts');
    const calls = [...host.matchAll(/await settleLightningJackpot\(/g)].map((m) => m.index!);
    expect(calls).toHaveLength(1);
    // Inside the settled branch: after `if (out.ok) {` and after state = 'complete'.
    const settledBranch = host.lastIndexOf('if (out.ok) {', calls[0]);
    expect(settledBranch).toBeGreaterThan(host.indexOf('backend.settle('));
    expect(host.slice(settledBranch, calls[0])).toContain("this.state = 'complete';");
    const jackpot = code('LightningJackpot.ts');
    // The physical payout doors, and nothing that writes on its own.
    expect(jackpot).toMatch(/processBBJPayout/);
    expect(jackpot).toMatch(/processMiniBBJPayout/);
    expect(jackpot).not.toMatch(/\.rpc\(|\.from\(/);
    // Nobody is seated at the host table: every share is credited directly.
    expect(jackpot.match(/seatedUserIds: \[\]/g)?.length).toBe(2);
  });
});
