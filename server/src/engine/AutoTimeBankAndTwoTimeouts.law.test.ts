import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { ServerTableEngine } from './ServerTableEngine.js';

const TABLE = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const engines: any[] = [];
afterEach(() => {
  engines.splice(0).forEach((e) => e.preciseTimer.dispose());
  vi.restoreAllMocks();
});

function harness() {
  const e = new ServerTableEngine(TABLE) as any;
  engines.push(e);
  e.running = true;
  e.isCurrentEngine = () => true;
  e.tableInfo = {};
  e.seatedPlayers = [{ user_id: 'u', seat_number: 1 }];
  e.handController = {
    getState: () => ({
      currentPlayerSeat: 1,
      currentBet: 10,
      players: [{ user_id: 'u', seat: 1, bet: 0, stack: 100 }],
    }),
    performAction: vi.fn(() => true),
  };
  e.disconnectEngine.registerPlayer(TABLE, 'u');
  e.timeBankEngine.initializePlayer(TABLE, 'u', { remainingSeconds: 120, usesRemaining: 6 });
  e.noteHorseTurnTimeout = vi.fn();
  e.notePlayerTurnTimeout = vi.fn();
  e.markProgress = vi.fn();
  const timers = vi.spyOn(e.preciseTimer, 'startTimer');
  const expire = (key: string) => {
    const call = [...timers.mock.calls].reverse().find((c) => c[1] === key);
    expect(call, `timer ${key} must be armed`).toBeDefined();
    (call![3] as () => void)();
  };
  return { e, expire };
}

describe('real bank expiry callbacks share the two-unanswered-turn ladder', () => {
  it.each(['automatic', 'manual'])(
    '%s bank preserves the seat after the first timeout',
    async (mode) => {
      const { e, expire } = harness();
      for (let strike = 1; strike <= 2; strike++) {
        e.timeBankActivatedThisTurn = false;
        e.startTurnTimer('u', 1, 15);
        if (mode === 'manual') {
          e.playerTurnStartTime = Date.now() - 16_000;
          expect((await e.activateTimeBank('u')).success).toBe(true);
        } else expire('u');
        expect(e.timeBankEngine.getPlayerBank(TABLE, 'u').isActive).toBe(true);
        expect(e.handController.performAction).toHaveBeenCalledTimes(strike - 1);
        expire('timebank:u');
        expect(e.handController.performAction).toHaveBeenLastCalledWith(
          1,
          'fold',
          undefined,
          'forced'
        );
        expect(e.disconnectEngine.getState(TABLE, 'u').consecutiveTimeouts).toBe(strike);
        expect(e.disconnectEngine.isSittingOut(TABLE, 'u')).toBe(strike === 2);
      }
    }
  );

  it('off prevents automatic spending but still allows a manually armed bank', () => {
    const { e, expire } = harness();
    e.heartbeat('u', { autoTimeBank: false });
    e.startTurnTimer('u', 1, 15);
    expire('u');
    expect(e.timeBankEngine.getUsesRemaining(TABLE, 'u')).toBe(6);
    expect(e.timeBankEngine.getPlayerBank(TABLE, 'u').isActive).toBe(false);
    e.timeBankActivatedThisTurn = false;
    e.startTurnTimer('u', 1, 15);
    expect(e.timeBankEngine.arm(TABLE, 'u')).toBe(true);
    expire('u');
    expect(e.timeBankEngine.getPlayerBank(TABLE, 'u').isActive).toBe(true);
    expect(e.timeBankEngine.getUsesRemaining(TABLE, 'u')).toBe(5);
  });

  it('socket pongs cannot cancel an explicit app suspension; a foreground heartbeat does', () => {
    const { e } = harness();
    e.notifyPageLeft('u');
    const deadline = e.disconnectEngine.getFsmState(TABLE, 'u').graceDeadlineMs;
    e.heartbeat('u', { transportOnly: true });
    expect(e.disconnectEngine.isConnected(TABLE, 'u')).toBe(false);
    expect(e.disconnectEngine.getFsmState(TABLE, 'u').graceDeadlineMs).toBe(deadline);
    e.heartbeat('u', { autoTimeBank: true });
    expect(e.disconnectEngine.isConnected(TABLE, 'u')).toBe(true);
    expect(e.timeBankEngine.isAutoActivateEnabled(TABLE, 'u')).toBe(true);
  });

  it('a socket admitted while the app is away cannot clear absence or renew protection', () => {
    const { e } = harness();
    e.notifyPageLeft('u');
    const deadline = e.disconnectEngine.getFsmState(TABLE, 'u').graceDeadlineMs;
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
    let admission: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'onConnect') {
        admission = node.initializer;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(admission).toBeDefined();
    const code = ts.transpileModule('(' + admission!.getText(ast) + ')', {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const connect = vm.runInNewContext(code, {
      gameServer: {
        getTableEngine: () => e,
        lightningRooms: { connect() {} },
      },
    });
    connect(TABLE, 'u', 'web');
    expect(e.disconnectEngine.isConnected(TABLE, 'u')).toBe(false);
    expect(e.disconnectEngine.getFsmState(TABLE, 'u').graceDeadlineMs).toBe(deadline);
    e.heartbeat('u', { autoTimeBank: true });
    expect(e.disconnectEngine.isConnected(TABLE, 'u')).toBe(true);
  });

  it('a blackholed socket receives reconnect protection before an expired turn spends a bank', () => {
    const { e, expire } = harness();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 17_000);
    e.startTurnTimer('u', 1, 15);
    expire('u');
    expect(e.disconnectEngine.isConnected(TABLE, 'u')).toBe(false);
    expect(e.disconnectEngine.getFsmState(TABLE, 'u').graceDeadlineMs).toBe(now + 47_000);
    expect(e.timeBankEngine.getUsesRemaining(TABLE, 'u')).toBe(6);
    expect(e.handController.performAction).not.toHaveBeenCalled();
    e.heartbeat('u', { autoTimeBank: true });
    expect(e.disconnectEngine.isConnected(TABLE, 'u')).toBe(true);
    expect(e.timeBankEngine.getUsesRemaining(TABLE, 'u')).toBe(6);
  });
});
