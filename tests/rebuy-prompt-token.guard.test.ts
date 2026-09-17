import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { tournamentService } from '../src/services/TournamentService';
import { supabase } from '../src/lib/supabase';
import { TournamentPurchaseNotSubmittedError } from '../src/services/TournamentPurchaseIntent';

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8');

const service = source('src/services/TournamentService.ts');
const tournamentPage = source('src/pages/TournamentPage.tsx');
const tablePage = source('src/pages/TablePage.tsx');

// Execute the actual mounted callbacks, rather than a second hand-written
// purchase handler. External effects are supplied explicitly by each case.
function tableFunction(
  select: (node: ts.Node, ast: ts.SourceFile) => ts.Expression | string | undefined,
  scope: Record<string, unknown>
) {
  const ast = ts.createSourceFile(
    'TablePage.tsx',
    tablePage,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  let callback: ts.Expression | string | undefined;
  const visit = (node: ts.Node) => {
    callback = select(node, ast) ?? callback;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!callback) throw new Error('Missing TablePage callback');
  const compiled = ts.transpileModule(
    `const callback = ${typeof callback === 'string' ? callback : callback.getText(ast)};`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }
  ).outputText;
  return new Function(...Object.keys(scope), `${compiled}\nreturn callback;`)(
    ...Object.values(scope)
  );
}
function tableCallback(name: string, scope: Record<string, unknown>) {
  return tableFunction((node, ast) => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(ast) === name &&
      node.initializer &&
      ts.isJsxExpression(node.initializer)
    )
      return node.initializer.expression;
  }, scope);
}

describe('the mounted tournament purchase callbacks preserve unknown outcomes', () => {
  function fixture() {
    const tournamentPurchaseContext = { active: true, bound: true };
    return {
      tableState: {
        tournamentId: 'tournament',
        isTournament: true,
        players: [{ stack: 0 }],
        heroSeat: 1,
      },
      userId: 'player',
      tableId: 'table',
      tournamentPurchaseContext,
      tournamentPurchaseContextRef: { current: tournamentPurchaseContext },
      previousTournamentPurchaseContextRef: {
        current: null as { active: boolean; bound: boolean } | null,
      },
      TournamentPurchaseNotSubmittedError,
      isCurrentPurchase: () => true,
      rebuyProcessing: false,
      rebuyProcessingRef: { current: false },
      addOnPurchasePendingRef: { current: false },
      rebuyPurchasePendingRef: { current: false },
      setRebuyProcessing: vi.fn(),
      setRebuyUnconfirmed: vi.fn(),
      tournamentService: { processAddOn: vi.fn(), processRebuy: vi.fn() },
      toast: { success: vi.fn(), error: vi.fn() },
      addOnPresentationEpochRef: { current: 0 },
      setAddOnPeriod: vi.fn(),
      setShowRebuyModal: vi.fn(),
      endRebuyPrompt: vi.fn(),
      releaseBustHold: vi.fn(),
      rebuyPromptTokenRef: { current: 'original-prompt' },
      beginRebuyPrompt: vi.fn(),
      rebuyJustSucceededRef: { current: false },
      bustPromptFiredRef: { current: false },
      bustHoldRef: { current: { pendingExit: vi.fn(), deadline: null } },
      releaseBustHoldRef: { current: vi.fn() },
      GameServerAPI: { notifyServerRejectRebuy: vi.fn().mockResolvedValue({ success: true }) },
      heroSeatRef: { current: 1 },
      setTableState: vi.fn(),
      goToLobbyWithResultRef: { current: vi.fn() },
    };
  }

  it.each([false, null, { success: false }])(
    'does not turn resolved service value %s into add-on success',
    async (receipt) => {
      const f = fixture();
      f.tournamentService.processAddOn.mockResolvedValue(receipt);
      expect(await tableCallback('onAddOnAccept', f)()).toBe(false);
      expect(f.toast.success).not.toHaveBeenCalled();
      expect(f.setAddOnPeriod).not.toHaveBeenCalled();
      expect(f.addOnPurchasePendingRef.current).toBe(true);
    }
  );

  it('keeps an unknown add-on visible until the same purchase confirms', async () => {
    const f = fixture();
    f.tournamentService.processAddOn
      .mockRejectedValueOnce(new Error('Lost reply'))
      .mockResolvedValueOnce({ success: true, newStack: 1000 });
    const accept = tableCallback('onAddOnAccept', f);
    expect(await accept()).toBe(false);
    expect(f.addOnPurchasePendingRef.current).toBe(true);
    expect(f.setAddOnPeriod).not.toHaveBeenCalled();
    expect(await accept()).toBe(true);
    expect(f.addOnPurchasePendingRef.current).toBe(false);
    expect(f.tournamentService.processAddOn.mock.calls).toEqual([
      ['tournament', 'player'],
      ['tournament', 'player'],
    ]);
  });

  it('cannot reach decline or navigation from an outstanding rebuy callback', async () => {
    const f = fixture();
    f.rebuyPurchasePendingRef.current = true;
    await tableCallback('onCloseRebuyModal', f)();
    expect(f.setShowRebuyModal).not.toHaveBeenCalled();
    expect(f.endRebuyPrompt).not.toHaveBeenCalled();
    expect(f.GameServerAPI.notifyServerRejectRebuy).not.toHaveBeenCalled();
    expect(f.goToLobbyWithResultRef.current).not.toHaveBeenCalled();
  });

  it.each([false, { success: false }, new Error('Lost reply')])(
    'retains the rebuy prompt when decline is not confirmed: %s',
    async (outcome) => {
      const f = fixture();
      if (outcome instanceof Error)
        f.GameServerAPI.notifyServerRejectRebuy.mockRejectedValue(outcome);
      else f.GameServerAPI.notifyServerRejectRebuy.mockResolvedValue(outcome as any);
      await tableCallback('onCloseRebuyModal', f)();
      expect(f.setShowRebuyModal).not.toHaveBeenCalled();
      expect(f.endRebuyPrompt).not.toHaveBeenCalled();
      expect(f.releaseBustHold).not.toHaveBeenCalled();
      expect(f.goToLobbyWithResultRef.current).not.toHaveBeenCalled();
      expect(f.rebuyProcessingRef.current).toBe(false);
    }
  );

  it('waits for a confirmed decline before closing and leaving', async () => {
    const f = fixture();
    let confirm!: (value: { success: boolean }) => void;
    f.GameServerAPI.notifyServerRejectRebuy.mockReturnValue(
      new Promise((resolve) => {
        confirm = resolve;
      })
    );
    const closing = tableCallback('onCloseRebuyModal', f)();
    expect(f.rebuyProcessingRef.current).toBe(true);
    expect(f.setShowRebuyModal).not.toHaveBeenCalled();
    confirm({ success: true });
    await closing;
    expect(f.setShowRebuyModal).toHaveBeenCalledWith(false);
    expect(f.endRebuyPrompt).toHaveBeenCalledOnce();
    expect(f.goToLobbyWithResultRef.current).toHaveBeenCalledOnce();
  });

  it('preserves the rebuy token and deferred exit through a lost reply and receipt retry', async () => {
    const f = fixture();
    f.tournamentService.processRebuy
      .mockRejectedValueOnce(new Error('Lost reply'))
      .mockResolvedValueOnce({ success: true, newStack: 1000 });
    const confirm = tableCallback('onConfirmRebuy', f);
    await confirm();
    expect(f.rebuyPurchasePendingRef.current).toBe(true);
    expect(f.setRebuyUnconfirmed).toHaveBeenLastCalledWith(true);
    expect(f.endRebuyPrompt).not.toHaveBeenCalled();
    expect(f.releaseBustHold).not.toHaveBeenCalled();
    await confirm();
    expect(f.tournamentService.processRebuy.mock.calls).toEqual([
      ['tournament', 'player', 'original-prompt'],
      ['tournament', 'player', 'original-prompt'],
    ]);
    expect(f.rebuyPurchasePendingRef.current).toBe(false);
    expect(f.bustHoldRef.current.pendingExit).toBeNull();
    expect(f.rebuyJustSucceededRef.current).toBe(true);
    expect(f.endRebuyPrompt).toHaveBeenCalledOnce();
  });

  it('allows decline after a proven fresh pre-submit failure, without retiring the retry token', async () => {
    const f = fixture();
    f.tournamentService.processRebuy.mockRejectedValue(
      new TournamentPurchaseNotSubmittedError(new Error('Quote unavailable'))
    );
    await tableCallback('onConfirmRebuy', f)();
    expect(f.rebuyPurchasePendingRef.current).toBe(false);
    expect(f.rebuyProcessingRef.current).toBe(false);
    expect(f.setRebuyUnconfirmed).toHaveBeenLastCalledWith(false);
    expect(f.endRebuyPrompt).not.toHaveBeenCalled();
    await tableCallback('onCloseRebuyModal', f)();
    expect(f.GameServerAPI.notifyServerRejectRebuy).toHaveBeenCalledOnce();
  });

  it.each(['rebuy', 'addon', 'decline'])(
    'ignores a late %s response after the table/session changes or unmounts',
    async (kind) => {
      for (const interruption of ['context', 'unmount', 'prompt']) {
        if (kind === 'addon' && interruption === 'prompt') continue;
        const f = fixture();
        let reply!: (value: { success: boolean }) => void;
        const deferred = new Promise<{ success: boolean }>((resolve) => {
          reply = resolve;
        });
        const name =
          kind === 'rebuy'
            ? 'onConfirmRebuy'
            : kind === 'addon'
              ? 'onAddOnAccept'
              : 'onCloseRebuyModal';
        if (kind === 'rebuy') f.tournamentService.processRebuy.mockReturnValue(deferred);
        else if (kind === 'addon') f.tournamentService.processAddOn.mockReturnValue(deferred);
        else f.GameServerAPI.notifyServerRejectRebuy.mockReturnValue(deferred);
        const pending = tableCallback(name, f)();
        if (interruption === 'context')
          f.tournamentPurchaseContextRef.current = { active: true, bound: true };
        if (interruption === 'unmount') f.tournamentPurchaseContextRef.current.active = false;
        if (interruption === 'prompt') f.rebuyPromptTokenRef.current = 'new-prompt';
        f.setRebuyProcessing.mockClear();
        reply({ success: true });
        await pending;
        expect(f.setAddOnPeriod, `${kind}/${interruption}`).not.toHaveBeenCalled();
        expect(f.setShowRebuyModal).not.toHaveBeenCalled();
        expect(f.endRebuyPrompt).not.toHaveBeenCalled();
        expect(f.releaseBustHold).not.toHaveBeenCalled();
        expect(f.setRebuyProcessing).not.toHaveBeenCalled();
        expect(f.toast.success).not.toHaveBeenCalled();
        expect(f.goToLobbyWithResultRef.current).not.toHaveBeenCalled();
      }
    }
  );

  it('retires the actual purchase context on unmount and resets only a prior bound table/session', () => {
    const f = fixture();
    const lifecycle = tableFunction((node, ast) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === 'useEffect' &&
        node.arguments[1]?.getText(ast) === '[tournamentPurchaseContext, endRebuyPrompt]'
      )
        return node.arguments[0];
    }, f);
    const cleanup = lifecycle();
    expect(f.setAddOnPeriod).not.toHaveBeenCalled(); // initial bootstrap offer survives
    cleanup();
    expect(f.tournamentPurchaseContext.active).toBe(false);
    const replayCleanup = lifecycle(); // StrictMode replays this same mounted context.
    expect(f.tournamentPurchaseContext.active).toBe(true);
    expect(f.setAddOnPeriod).not.toHaveBeenCalled();
    replayCleanup();
    const next = fixture();
    next.previousTournamentPurchaseContextRef.current = f.tournamentPurchaseContext;
    next.rebuyProcessingRef.current = true;
    next.rebuyPurchasePendingRef.current = true;
    next.addOnPurchasePendingRef.current = true;
    const nextLifecycle = tableFunction((node, ast) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === 'useEffect' &&
        node.arguments[1]?.getText(ast) === '[tournamentPurchaseContext, endRebuyPrompt]'
      )
        return node.arguments[0];
    }, next);
    nextLifecycle();
    expect(next.rebuyProcessingRef.current).toBe(false);
    expect(next.rebuyPurchasePendingRef.current).toBe(false);
    expect(next.addOnPurchasePendingRef.current).toBe(false);
    expect(next.endRebuyPrompt).toHaveBeenCalledOnce();
    expect(next.setShowRebuyModal).toHaveBeenCalledWith(false);
  });

  it.each(['processing', 'unknown'])(
    'the actual rebuy backstop cannot cancel a %s purchase',
    async (state) => {
      const f = fixture();
      f.rebuyProcessingRef.current = state === 'processing';
      f.rebuyPurchasePendingRef.current = state === 'unknown';
      const timeout = tableFunction((node, ast) => {
        if (
          ts.isBinaryExpression(node) &&
          node.left.getText(ast) === 'hold.deadline' &&
          ts.isCallExpression(node.right) &&
          node.right.expression.getText(ast) === 'setTimeout'
        )
          return node.right.arguments[0];
      }, f);
      await timeout();
      expect(f.GameServerAPI.notifyServerRejectRebuy).not.toHaveBeenCalled();
      expect(f.endRebuyPrompt).not.toHaveBeenCalled();
      expect(f.setShowRebuyModal).not.toHaveBeenCalled();
      expect(f.releaseBustHoldRef.current).not.toHaveBeenCalled();
    }
  );

  it('the actual five-second hold cannot replay an elimination during a submitted rebuy', () => {
    vi.useFakeTimers();
    try {
      const f = {
        ...fixture(),
        BUST_HOLD_MS: 5000,
        bustHoldRef: {
          current: {
            active: false,
            deadline: null,
            pendingExit: null as { position: number; prize: number; delayMs: number } | null,
          },
        },
        exitIfBustedRef: { current: vi.fn() },
      };
      const release = tableFunction((node) => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'releaseBustHold' &&
          node.initializer &&
          ts.isCallExpression(node.initializer)
        )
          return node.initializer.arguments[0];
      }, f);
      const begin = tableFunction(
        (node) => {
          if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === 'beginBustHold' &&
            node.initializer &&
            ts.isCallExpression(node.initializer)
          )
            return node.initializer.arguments[0];
        },
        { ...f, releaseBustHold: release }
      );
      f.rebuyPurchasePendingRef.current = true;
      expect(begin()).toBe(true);
      const elimination = { position: 12, prize: 0, delayMs: 0 };
      f.bustHoldRef.current.pendingExit = elimination;
      vi.advanceTimersByTime(5000);
      expect(f.goToLobbyWithResultRef.current).not.toHaveBeenCalled();
      expect(f.exitIfBustedRef.current).not.toHaveBeenCalled();
      expect(f.bustHoldRef.current.active).toBe(true);
      expect(f.bustHoldRef.current.pendingExit).toBe(elimination);
      // A later authoritative decision is still allowed to release the hold.
      f.rebuyPurchasePendingRef.current = false;
      release();
      expect(f.goToLobbyWithResultRef.current).toHaveBeenCalledWith(12, 0, 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('neither dismissal nor a closed persisted window hides an outstanding add-on', async () => {
    const f = fixture();
    f.rebuyProcessingRef.current = true;
    f.addOnPurchasePendingRef.current = true;
    tableCallback('onAddOnDecline', f)();
    const persistedOffer = tableFunction(
      (node) => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.name.text === 'presentPersistedAddOnOffer'
        )
          return node.initializer;
      },
      { ...f, isMounted: true, presentAddOnOffer: vi.fn() }
    );
    await persistedOffer({ addon_period_triggered: true, addon_period_ends_at: '2000-01-01' });
    expect(f.setAddOnPeriod).not.toHaveBeenCalled();
    expect(f.addOnPurchasePendingRef.current).toBe(true);
  });

  it.each([true, false])(
    'the actual add-on end event preserves an outstanding submission: %s',
    (pending) => {
      const f = fixture();
      f.addOnPurchasePendingRef.current = pending;
      const closeWindow = tableFunction((node, ast) => {
        if (
          ts.isIfStatement(node) &&
          node.expression.getText(ast) === "data?.type === 'ADDON_PERIOD_END'"
        )
          return `() => ${node.thenStatement.getText(ast)}`;
      }, f);
      closeWindow();
      expect(f.addOnPresentationEpochRef.current).toBe(1);
      expect(f.setAddOnPeriod).toHaveBeenCalledTimes(pending ? 0 : 1);
    }
  );

  it('connects a lost RPC reply through the real service and saved request to a confirmed add-on retry', async () => {
    const f = fixture();
    localStorage.clear();
    sessionStorage.clear();
    vi.stubGlobal('navigator', {
      locks: { request: (_key: string, work: () => Promise<unknown>) => work() },
    });
    const getTournament = vi
      .spyOn(tournamentService, 'getTournament')
      .mockRejectedValueOnce(new Error('Fresh quote unavailable'))
      .mockResolvedValue({ addon_cost: 20, addon_chips: 1000 } as any);
    const level = vi
      .spyOn(tournamentService, 'getCurrentLevelState')
      .mockReturnValue({ levelIndex: 3 } as any);
    const rpc = vi
      .mocked(supabase.rpc)
      .mockRejectedValueOnce(new Error('Lost response'))
      .mockResolvedValueOnce({
        data: { success: true, rebuy_type: 'addon', new_stack: 1500 },
        error: null,
      } as any);
    try {
      const accept = tableCallback('onAddOnAccept', { ...f, tournamentService });
      await expect(accept()).rejects.toBeInstanceOf(TournamentPurchaseNotSubmittedError);
      expect(f.addOnPurchasePendingRef.current).toBe(false);
      expect(rpc).not.toHaveBeenCalled();
      expect(await accept()).toBe(false);
      expect(rpc).toHaveBeenCalledTimes(1);
      const original = rpc.mock.calls[0];
      expect(original[0]).toBe('process_tournament_rebuy');
      expect(original[1]).toMatchObject({
        p_rebuy_type: 'addon',
        p_cost: 20,
        p_chips: 1000,
        p_current_level: 3,
        p_client_token: null,
      });
      // Mutable eligibility/price/level is now unavailable. The stored exact
      // request must still reach the receipt; no new quote or purchase is built.
      getTournament.mockRejectedValue(new Error('Offer expired'));
      expect(await accept()).toBe(true);
      expect(rpc.mock.calls[1]).toEqual(original);
      expect(getTournament).toHaveBeenCalledTimes(2);
      expect(f.setAddOnPeriod).toHaveBeenCalledOnce();
      expect(f.addOnPurchasePendingRef.current).toBe(false);
    } finally {
      getTournament.mockRestore();
      level.mockRestore();
      rpc.mockReset();
      vi.unstubAllGlobals();
      localStorage.clear();
      sessionStorage.clear();
    }
  });
});

describe('every player rebuy prompt owns one required idempotency token', () => {
  it('makes the service token mandatory and refuses an empty runtime value', () => {
    const start = service.indexOf('async processRebuy(');
    const end = service.indexOf('\n  /**', start + 1);
    const processRebuy = service.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(processRebuy).toMatch(/clientToken:\s*string/);
    expect(processRebuy).not.toMatch(/clientToken\?:\s*string/);
    expect(processRebuy).toContain("typeof clientToken !== 'string'");
    expect(processRebuy).toContain('clientToken.trim()');
    expect(processRebuy).toContain('normalizedClientToken.length > 128');
    expect(processRebuy).not.toContain('await this.canRebuy(');
    expect(processRebuy).toMatch(/p_client_token:\s*normalizedClientToken/);
    expect(processRebuy).not.toMatch(/p_client_token:\s*clientToken\s*\?\?/);
  });

  it('keeps one Tournament Page token through retries and retires it on success', () => {
    expect(tournamentPage).toContain('const rebuyPromptTokenRef = useRef<string | null>(null)');
    expect(tournamentPage).toMatch(
      /const beginRebuyPrompt = useCallback[\s\S]*?if \(rebuyPromptTokenRef\.current\)[\s\S]*?return rebuyPromptTokenRef\.current/
    );
    expect(tournamentPage).toMatch(
      /const clientToken = beginRebuyPrompt\(\);[\s\S]*?processRebuy\([\s\S]*?clientToken[\s\S]*?\)/
    );
    expect(tournamentPage).toMatch(
      /if \(result\.success\) \{[\s\S]*?endRebuyPrompt\(\);[\s\S]*?setCanRebuyNow\(false\)/
    );
    expect(tournamentPage).toMatch(
      /useEffect\(\(\) => \{\s*endRebuyPrompt\(\);\s*if \(canRebuyNow\) beginRebuyPrompt\(\);[\s\S]*?canRebuyNow,[\s\S]*?selectedTournament\?\.id,[\s\S]*?currentUser\.id/
    );
    expect(tournamentPage).toContain('const token = uuid()');
  });

  it('keeps one Table Page token from offer through every retry', () => {
    expect(tablePage).toContain('const rebuyPromptTokenRef = useRef<string | null>(null)');
    expect(tablePage).toMatch(
      /const beginRebuyPrompt = useCallback[\s\S]*?if \(rebuyPromptTokenRef\.current\)[\s\S]*?return rebuyPromptTokenRef\.current[\s\S]*?const token = uuid\(\)/
    );
    expect(tablePage).toMatch(
      /const token = rebuyPromptTokenRef\.current \?\? beginRebuyPrompt\(\);[\s\S]*?processRebuy\(\s*tableState\.tournamentId,\s*userId,\s*token\s*\)/
    );
    expect(tablePage).toMatch(
      /processRebuy\(\s*tableState\.tournamentId,\s*userId,\s*token\s*\);[\s\S]*?endRebuyPrompt\(\)/
    );
    expect(tablePage).toMatch(
      /Unanswered for two minutes is a decline[\s\S]*?setShowRebuyModal\(false\);[\s\S]*?endRebuyPrompt\(\)/
    );
  });

  it('does not retain the unreachable duplicate tournament purchase modals', () => {
    for (const path of [
      'src/components/tournament/RebuyModal.tsx',
      'src/components/tournament/AddOnModal.tsx',
      'src/components/tournament/RebuyModal.css',
    ]) {
      expect(existsSync(resolve(process.cwd(), path)), path).toBe(false);
    }
  });

  it('advertises only the zero-stack, unpaid, in-window entry the SQL authority accepts', () => {
    const start = service.indexOf('async canRebuy(');
    const end = service.indexOf('\n  /**', start + 1);
    const canRebuy = service.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(canRebuy).toContain('chips, status, prize, rebuys, rebuy_prompt_until');
    expect(canRebuy).toContain('Number(player.chips ?? 0) !== 0');
    expect(canRebuy).toContain('Number(player.prize ?? 0) > 0');
    expect(canRebuy).toContain("playerStatus !== 'playing'");
    expect(canRebuy).toContain('promptUntil <= Date.now()');
    expect(canRebuy).toContain('tournament.max_reentries');
    expect(canRebuy).toContain('tournament.max_rebuys');
    expect(canRebuy).not.toContain('player.chips > tournament.starting_chips');
  });
});

describe('an add-on retry reaches its immutable server receipt', () => {
  it('does not preflight mutable window or duplicate state before the money RPC', () => {
    const start = service.indexOf('async processAddOn(');
    const end = service.indexOf('\n  /*', start + 1);
    const processAddOn = service.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(processAddOn).not.toContain('await this.canAddOn(');
    expect(processAddOn).not.toContain(".from('wallet_transactions')");
    expect(processAddOn).toContain("supabase.rpc('process_tournament_rebuy'");
    expect(processAddOn).toContain("p_rebuy_type: 'addon'");
  });

  it('opens the confirmed persisted offer instead of buying from the table menu', () => {
    const start = tablePage.indexOf('const handleTournamentAddOn = async () =>');
    const end = tablePage.indexOf('\n  // Handle leave table', start);
    const menuAction = tablePage.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(menuAction).toContain('refreshPersistedAddOnOfferRef.current');
    expect(menuAction).toContain('await refreshOffer()');
    expect(menuAction).not.toContain('processAddOn(');
    expect(menuAction).not.toContain('setShowRebuyModal(false)');
  });
});
