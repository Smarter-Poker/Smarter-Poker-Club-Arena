/**
 * Dan 2026-10-12: "THE END OF SESSION RECAP WAS NOT ACCURATE, I 100% LOST, AND
 * ITS SAYING I WON. SMH BUY IN IS OFF, AMOUNT OF HANDS PLAYED, EVERYTHING IS
 * 100% WRONG." Bought in 4,000 Diamonds, left with 1,376 after 20 hands and
 * 33 minutes; the card said +400, buy-in 976, 5 hands, 3 minutes, because a
 * reload restarted every counter and the buy-in read could not see a Diamond
 * seat.
 */
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useTopUpAccounting } from '../../src/hooks/useTopUpAccounting';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { mergeSessionFacts, sessionBuyInTotal } from '../../src/utils/sessionBuyInTotal';

const ROOT = join(__dirname, '..', '..');
const MIGRATION = readFileSync(
  join(
    ROOT,
    'supabase/migrations/20261012062409_the_session_recap_reads_the_whole_session_from_the_server.sql'
  ),
  'utf8'
);

// Execute the owning React effect's actual callback. Only its remote reads
// are replaced; counter merging and writes to the summary refs stay real.
function restoreOccupiedSeat(stack: number, delayed = false, carriedHands = 0) {
  const src = readFileSync(join(ROOT, 'src/pages/TablePage.tsx'), 'utf8');
  const ast = ts.createSourceFile(
    'TablePage.tsx',
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let effect: ts.Expression | undefined;
  let fundingCallback: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast) === 'useEffect' &&
      node.arguments[0]?.getText(ast).includes("supabase.rpc('fn_my_table_session_facts'")
    ) {
      effect = node.arguments[0];
    }
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useTopUpAccounting') {
      const options = node.arguments[0];
      if (options && ts.isObjectLiteralExpression(options)) {
        const prop = options.properties.find(
          (p) => ts.isPropertyAssignment(p) && p.name.getText(ast) === 'onFunding'
        );
        if (prop && ts.isPropertyAssignment(prop)) fundingCallback = prop.initializer;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!effect) throw new Error('the table session restoration effect is missing');
  const ref = (current: number) => ({ current });
  const refs = {
    totalBuyInRef: ref(0),
    sessionStartRef: ref(Date.parse('2026-10-12T06:17:00Z')),
    handsPlayedRef: ref(0),
    handsWonRef: ref(0),
    peakStackRef: ref(stack),
    totalRebuysRef: ref(0),
  };
  let deliver!: () => void;
  const ready = delayed
    ? new Promise<void>((resolve) => {
        deliver = resolve;
      })
    : Promise.resolve();
  const currentKey = { current: 'table:player' as string | null };
  const context = {
    ...refs,
    sessionCarryRef: { current: { handsPlayed: carriedHands, handsWon: 0, fundingAdjustment: 0 } },
    tableId: 'table',
    userId: 'player',
    sessionStatsService: { getStats: () => ({}), restoreFunding: () => {}, updateStack: () => {} },
    tableStateRef: { current: { players: [], heroSeat: 1 } },
    readBalanceRevision: () => 0,
    readTableFundingBalance: async () => ({ balance: null }),
    setBalanceIfCurrent: () => {},
    reportError: () => {},
    sessionRestoreKey: 'table:player',
    tableState: { heroSeat: 1, players: [] },
    heroRowStack: stack,
    sessionBaselineTableRef: currentKey,
    mergeSessionFacts,
    sessionBuyInTotal,
    supabase: {
      rpc: async (name: string, args: { p_table_id: string }) => {
        await ready;
        if (args.p_table_id !== 'table') return { data: null, error: 'wrong table' };
        return {
          error: null,
          data:
            name === 'fn_my_cash_session_baseline'
              ? 4000
              : {
                  started_at: '2026-10-12T05:47:04.687Z',
                  hands_played: 20,
                  hands_won: 9,
                  peak_stack: 4099,
                },
        };
      },
    },
  };
  const cleanup = new Function(...Object.keys(context), `return (${effect.getText(ast)})();`)(
    ...Object.values(context)
  ) as () => void;
  if (!fundingCallback) throw new Error('the recorded funding callback is missing');
  const onFunding = new Function(
    ...Object.keys(context),
    ts.transpileModule(`const callback = ${fundingCallback.getText(ast)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText + '\nreturn callback;'
  )(...Object.values(context));
  let recordedTotal = 4000;
  const read = async () => {
    const totalBuyIn = recordedTotal;
    await ready;
    return { totalBuyIn };
  };
  const props = {
    tableId: 'table',
    userId: 'player',
    asset: 'chips' as const,
    seat: 1,
    enabled: true,
    connected: true,
    revision: 0,
    event: null,
    tableEvent: null,
    read,
    onFunding,
  };
  const funding = renderHook((p) => useTopUpAccounting(p), { initialProps: props });
  return {
    refs,
    cleanup: () => {
      cleanup();
      funding.unmount();
    },
    currentKey,
    deliver: () => deliver?.(),
    refreshFunding: (total: number) => {
      recordedTotal = total;
      funding.rerender({ ...props, revision: 1 });
    },
  };
}

describe('the Session Complete card reads the whole session', () => {
  it.each([1376, 0])(
    'restores the server recap for a seat outside the hand with stack %s',
    async (stack) => {
      const { refs } = restoreOccupiedSeat(stack);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(refs.totalBuyInRef.current).toBe(4000);
      expect(refs.handsPlayedRef.current).toBe(20);
      expect(refs.sessionStartRef.current).toBe(Date.parse('2026-10-12T05:47:04.687Z'));
      expect(refs.peakStackRef.current).toBe(4099);
      expect(1376 - refs.totalBuyInRef.current).toBe(-2624);
    }
  );

  it('adds carried hands to the destination table facts in the actual restoration callback', async () => {
    const { refs } = restoreOccupiedSeat(1376, false, 12);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refs.handsPlayedRef.current).toBe(32);
    expect(refs.totalBuyInRef.current).toBe(4000);
  });

  it('does not apply a pending answer after the seat is left', async () => {
    const { refs, cleanup, deliver } = restoreOccupiedSeat(1376, true);
    cleanup();
    deliver();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refs.totalBuyInRef.current).toBe(1376);
    expect(refs.handsPlayedRef.current).toBe(0);
  });

  it('does not count a late snapshot placeholder as another buy-in', async () => {
    const { refs, deliver, refreshFunding } = restoreOccupiedSeat(0, true);
    // The roster arrives after seat ownership. Its 976 is a placeholder;
    // only the real 100 top-up that follows belongs on top of the read.
    refs.totalBuyInRef.current = 1076;
    // The original stale read is superseded by the acknowledged purchase.
    refreshFunding(4100);
    deliver();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(refs.totalBuyInRef.current).toBe(4100);
  });
  it('restores an occupied seat even when the hero is absent from the hand or has zero stack', () => {
    const src = readFileSync(join(ROOT, 'src/pages/TablePage.tsx'), 'utf8');
    const ast = ts.createSourceFile(
      'TablePage.tsx',
      src,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    const gates: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === 'supabase.rpc' &&
        node.arguments[0]?.getText(ast) === "'fn_my_table_session_facts'"
      ) {
        for (let parent = node.parent; parent; parent = parent.parent) {
          if (ts.isIfStatement(parent)) gates.push(parent.expression.getText(ast));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(
      gates.some((gate) => /mappedHero|totalBuyInRef/.test(gate)),
      'a sitting-out or busted occupied seat must not wait for a funded hand participant'
    ).toBe(false);
  });
  it("Dan's session: the server's figures replace the counts that restarted at the reload", () => {
    const reloadAt = Date.parse('2026-10-12T06:17:00Z');
    const atAsk = { startMs: reloadAt, handsPlayed: 0, handsWon: 0, peakStack: 976 };
    const merged = mergeSessionFacts({
      serverFacts: {
        started_at: '2026-10-12T05:47:04.687Z',
        hands_played: 15,
        hands_won: 9,
        peak_stack: 4099,
      },
      atAsk,
      now: { startMs: reloadAt, handsPlayed: 2, handsWon: 1, peakStack: 1046 },
    });
    expect(merged.startMs).toBe(Date.parse('2026-10-12T05:47:04.687Z'));
    expect(merged.handsPlayed).toBe(17);
    expect(merged.handsWon).toBe(10);
    expect(merged.peakStack).toBe(4099);
    // And the buy-in: the server's 4,000, not the 976 on the felt at the reload.
    expect(sessionBuyInTotal({ serverBaseline: '4000', totalAtAsk: 976, totalNow: 976 })).toBe(
      4000
    );
  });

  it('an unreadable answer leaves the page figures alone', () => {
    const now = { startMs: 5, handsPlayed: 3, handsWon: 1, peakStack: 100 };
    for (const bad of [null, undefined, 'x', 7]) {
      expect(mergeSessionFacts({ serverFacts: bad, atAsk: now, now })).toEqual(now);
    }
    expect(
      mergeSessionFacts({
        serverFacts: { started_at: 'nope', hands_played: -1, hands_won: 'x', peak_stack: 0 },
        atAsk: now,
        now,
      })
    ).toEqual(now);
  });

  it('the table page asks for the facts on the same once-per-table ask', () => {
    const src = readFileSync(join(ROOT, 'src/pages/TablePage.tsx'), 'utf8');
    expect(src).toContain("supabase.rpc('fn_my_table_session_facts', { p_table_id: askedFor })");
    expect(src).toContain('handsPlayedRef.current = merged.handsPlayed;');
  });

  it('the buy-in read answers for a Diamond seat, and both reads are bound to the caller', () => {
    expect(MIGRATION).toContain(
      "JOIN public.poker_diamond_movements m ON m.custody_id = c.id AND m.action = 'reserve'"
    );
    expect(MIGRATION).toContain("AND c2.purpose = 'cash_seat'");
    expect(MIGRATION.match(/auth\.uid\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
    expect(MIGRATION).toContain(
      'REVOKE ALL ON FUNCTION public.fn_my_table_session_facts(uuid) FROM PUBLIC, anon;'
    );
    expect(MIGRATION).not.toMatch(/^GRANT[^;]*\banon\b/im);
  });
});
