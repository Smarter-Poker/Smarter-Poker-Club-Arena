import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { reconcileHeroSeatFromEngine, type HeroSeatReconcileInput } from '../lib/heroSeatReconcile';
import { reportError } from '../utils/errorReporter';

type RenderedSeatState = HeroSeatReconcileInput & { tableId: string };
export interface AppliedSeatSnapshot {
  snapshot: unknown;
  tableId: string | undefined;
  userId: string | undefined;
}

/** The existing rendered-seat invariant, evaluated against a committed mapped roster. */
export function useEngineHeroSeatInvariant<T extends RenderedSeatState>({
  engineSnapshot,
  appliedSnapshot,
  tableId,
  userId,
  tableState,
  setTableState,
  lightningObserver,
  USE_ENGINE_WS,
  leftSeatPendingRef,
}: {
  engineSnapshot: unknown;
  appliedSnapshot: AppliedSeatSnapshot | null;
  tableId: string | undefined;
  userId: string | undefined;
  tableState: T;
  setTableState: Dispatch<SetStateAction<T>>;
  lightningObserver: boolean;
  USE_ENGINE_WS: boolean;
  leftSeatPendingRef: { current: boolean };
}) {
  const engineSeatMismatchReportedRef = useRef<string>('');
  useEffect(() => {
    if (lightningObserver || !USE_ENGINE_WS || !engineSnapshot || !userId || userId === 'guest')
      return;
    // The last snapshot can predate the confirmed exit. It cannot reclaim it.
    if (leftSeatPendingRef.current) return;
    // Compare the roster only after this exact snapshot's mapped state committed.
    if (
      appliedSnapshot?.snapshot !== engineSnapshot ||
      appliedSnapshot.tableId !== tableId ||
      appliedSnapshot.userId !== userId
    )
      return;
    const enginePlayers =
      (engineSnapshot as unknown as { players?: Array<{ seat?: number; user_id?: string }> })
        .players ?? [];
    const mine = enginePlayers.find((p) => p?.user_id === userId);
    if (!mine || !mine.seat || mine.seat < 1) return; // engine does not seat us — nothing to assert

    const renderedHero = tableState.players.findIndex((p) => p && p.id === userId) + 1;
    if (renderedHero === mine.seat) return; // the two agree; the common case

    const key = `${tableState.tableId}:${mine.seat}`;
    if (engineSeatMismatchReportedRef.current !== key) {
      engineSeatMismatchReportedRef.current = key;
      reportError(
        new Error(
          `engine seats hero at ${mine.seat} but client renders ` +
            `${renderedHero || 'no seat'} (maxPlayers=${tableState.maxPlayers}, ` +
            `rows=${tableState.players.length})`
        ),
        'TablePage.EngineHeroSeatNotRendered'
      );
    }

    /* Heal, on the server's word — through a PURE function that returns null
       when there is nothing to do (src/lib/heroSeatReconcile.ts).

       That indirection is not ceremony, it is the fix for this block's own
       first draft. The heal grows the array with NULL rows and cannot place
       the hero row, so an inline `if (players[seat-1]?.id === userId) return
       prev` guard NEVER became true: every pass produced a fresh array
       identity, this effect's dependencies changed, and it ran again — an
       infinite render loop, armed on precisely the path that fires when a
       player is stranded. Returning `prev` UNCHANGED is what stops the cycle,
       and `reconcileHeroSeatFromEngine` guarantees that by construction rather
       than by a guard somebody has to get right. It also bounds the growth, so
       a corrupt `seat: 1e9` cannot hang the tab. Pinned by
       tests/unit/heroSeatReconcile.test.ts. */
    setTableState((prev) => {
      const patch = reconcileHeroSeatFromEngine(
        { players: prev.players, maxPlayers: prev.maxPlayers, heroSeat: prev.heroSeat },
        mine.seat as number,
        userId
      );
      if (!patch) return prev; // already agrees — no new identity, no loop
      return {
        ...prev,
        ...(patch.players ? { players: patch.players as T['players'] } : {}),
        ...(patch.maxPlayers !== undefined ? { maxPlayers: patch.maxPlayers } : {}),
        ...(patch.heroSeat !== undefined ? { heroSeat: patch.heroSeat } : {}),
      };
    });
  }, [
    engineSnapshot,
    appliedSnapshot,
    tableId,
    lightningObserver,
    leftSeatPendingRef,
    setTableState,
    USE_ENGINE_WS,
    userId,
    tableState.players,
    tableState.tableId,
    tableState.maxPlayers,
  ]);
}
