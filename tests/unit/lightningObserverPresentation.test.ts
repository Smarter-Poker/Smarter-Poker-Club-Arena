import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { EngineStateClient, type EngineSnapshot } from '../../src/services/EngineStateClient';
import { isLightningObserverSnapshot, mapEngineSnapshot } from '../../src/utils/mapEngineSnapshot';

function snapshot(hand = 1): EngineSnapshot {
  return {
    lightning_observer: true,
    table_id: 'anchor',
    hand_number: hand,
    pot: 10,
    stage: 'preflop',
    current_player: 'viewer',
    dealer_seat: 1,
    max_seats: 6,
    players: [
      {
        seat: 1,
        user_id: 'viewer',
        username: 'Viewer',
        stack: 100,
        cards: [],
        leave_locked: true,
        stay_remaining_ms: 40000,
      },
    ],
    community_cards: [],
    action_history: [],
    side_pots: [],
    winners: [],
    disconnect_states: {},
  };
}

describe('public Lightning observer consumer', () => {
  it('never turns matching player identity into hero ownership or a personal stay clock', () => {
    const out = mapEngineSnapshot(snapshot(), 'viewer', 6);
    expect(out.players[0]?.id).toBe('viewer');
    expect(out.players[0]?.isHero).toBe(false);
    expect(out.players[0]?.holeCards).toBeUndefined();
    expect(out.heroLeave).toBeNull();
    const publicReveal = snapshot();
    (publicReveal.players as any[])[0].cards = [{ rank: 'A', suit: 's' }];
    const revealed = mapEngineSnapshot(publicReveal, 'viewer', 6);
    expect(revealed.players[0]?.showCards).toBe(true);
    expect(revealed.players[0]?.isHero).toBe(false);
    expect(
      mapEngineSnapshot({ ...snapshot(), lightning_observer: false }, 'viewer', 6).players[0]
        ?.isHero
    ).toBe(true);
  });

  it('keeps observer role across actual client delta processing and a reconnect snapshot', () => {
    const mapped: ReturnType<typeof mapEngineSnapshot>[] = [];
    const client = new EngineStateClient({
      baseUrl: 'https://engine.example',
      tableId: 'anchor',
      getToken: async () => null,
      onSnapshot: (s) => mapped.push(mapEngineSnapshot(s, 'viewer', 6)),
    });
    try {
      const receive = (message: unknown) => (client as any).handleMessage(message);
      receive({ type: 'SNAPSHOT', tableId: 'anchor', seq: 1, state: snapshot() });
      receive({
        type: 'DELTA',
        tableId: 'anchor',
        prev: 1,
        seq: 2,
        patch: [{ op: 'replace', path: '/pot', value: 20 }],
      });
      receive({ type: 'SNAPSHOT', tableId: 'anchor', seq: 9, state: snapshot(2) });
      expect(mapped).toHaveLength(3);
      expect(mapped.every((m) => m.players[0]?.isHero === false)).toBe(true);
      expect(isLightningObserverSnapshot(client.getSnapshot())).toBe(true);
      expect(mapped.at(-1)?.handNumber).toBe(2);
    } finally {
      client.disconnect();
    }
  });

  it('refuses ordinary actions through the actual page callback before transport submission', async () => {
    const text = readFileSync('src/pages/TablePage.tsx', 'utf8');
    const ast = ts.createSourceFile(
      'TablePage.tsx',
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    );
    let action: ts.Node | undefined;
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'submitActionWithToast') {
        action = (node.initializer as ts.CallExpression).arguments[0];
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    expect(action).toBeDefined();
    const script =
      ts.transpile('const run = ' + action!.getText(ast), { target: ts.ScriptTarget.ES2022 }) +
      '\nreturn run;';
    const submit = vi.fn();
    const run = new Function(
      'isLightningObserverSnapshot',
      'engineSnapshotRef',
      'submitAction',
      script
    )(isLightningObserverSnapshot, { current: snapshot() }, submit);
    expect(await run('anchor', 'viewer', 'fold')).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });

  it('gates physical hero healing, private recovery and action submission while retaining funded handoff', () => {
    const page = readFileSync('src/pages/TablePage.tsx', 'utf8');
    expect(page).toContain('if (lightningObserver)');
    expect(page).toContain('...(lightningObserver ? { heroSeat: 0 } : {})');
    expect(page).toContain('if (isLightningObserverSnapshot(engineSnapshotRef.current)) return;');
    expect(page).toContain(
      'if (isLightningObserverSnapshot(engineSnapshotRef.current)) return false;'
    );
    expect(page).toContain('if (lightningObserver || !USE_ENGINE_WS');
    expect(page).toContain('heroBoughtIn: lightningObserver');
    expect(page).toContain(': lightningAnchorFunded');
  });
});
