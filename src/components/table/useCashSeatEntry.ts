import { useEffect, useMemo } from 'react';
import { joinCashGame, joinGameRefusalText, waitlistedText } from '../../services/cashGameLobby';

/** A spectator's seat tap enters the game before opening its purchase door.
 * Admission only holds a chair or queue place; the buy-in still needs confirmation.
 */
export function useCashSeatEntry({
  tableId,
  userId,
  gameId,
  openBuyIn,
  goToTable,
  showWaitlist,
  notify,
}: {
  tableId: string | undefined;
  userId: string | null | undefined;
  gameId: string | null | undefined;
  openBuyIn: (seat: number) => void;
  goToTable: (tableId: string) => void;
  showWaitlist: () => void;
  notify: (message: string) => void;
}) {
  const scope = useMemo(() => ({ active: true, busy: false }), [tableId, userId, gameId]);
  useEffect(() => {
    scope.active = true;
    return () => {
      scope.active = false;
    };
  }, [scope]);

  return async (seat: number) => {
    if (!scope.active || scope.busy) return;
    if (!gameId) {
      openBuyIn(seat);
      return;
    }
    scope.busy = true;
    try {
      const result = await joinCashGame(gameId);
      if (!scope.active) return;
      if (result.action === 'waitlisted') {
        notify(waitlistedText(result));
        showWaitlist();
      } else if (result.table_id) {
        const destination = result.table_name || 'Your Assigned Table';
        if (result.action === 'seated') {
          notify(`You Are Already Seated At ${destination}. Opening Your Game.`);
          goToTable(result.table_id);
        } else {
          if (result.table_id === tableId) {
            const assigned = Number(result.seat_number);
            openBuyIn(Number.isSafeInteger(assigned) && assigned > 0 ? assigned : seat);
          } else {
            goToTable(result.table_id);
          }
        }
      }
    } catch (error) {
      if (scope.active) {
        notify(joinGameRefusalText(error));
        showWaitlist();
      }
    } finally {
      scope.busy = false;
    }
  };
}
