/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  BAD BEAT JACKPOT — THE ONE PLACE THE CLUB-WIDE POP-UP IS DRAWN
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan: "everyone currently playing in the club or union get a pop up on
 * screen." This component is that pop-up's single owner.
 *
 * WHY IT IS NOT INSIDE TablePage (BBJ audit 2026-09-05). MultiTablePage keeps
 * up to four TablePages mounted and hides the inactive ones with
 * display:none. Every one of them subscribed to BBJ_HIT_GLOBAL, and the gate
 * (`shouldAnnounceBbjHit`) marks a hit as seen for the FIRST subscriber that
 * asks - so when the first to run happened to be a hidden slot, the card was
 * drawn into a display:none subtree and every visible table was told "already
 * announced". The player saw nothing, for the rarest event on the platform,
 * exactly when they had more than one table open. This is the same reasoning
 * that put PortraitLock in PersistentTableLayer: a thing that must appear
 * exactly once, on top of whatever is on screen, has to live in the one
 * component that is mounted exactly once.
 *
 * WHAT IT DOES NOT DECIDE. Whether a hit is announceable at all - fresh, and
 * not already shown this session - is still `shouldAnnounceBbjHit`
 * (lib/bbjHitOnce). Two producers feed it, and they are deliberately the same
 * event with the same identity so they de-duplicate against each other:
 *
 *   1. the engine's `bbj_hit_global` socket event, fanned out to every
 *      sibling cash table the instant the payout lands (TablePage forwards
 *      it to the bus);
 *   2. the Supabase Realtime subscription on the pool row (TablePage), the
 *      older path, kept as the fallback for a table this engine does not
 *      host - it rides a WAL stream that can run a minute behind.
 *
 * The hitting table itself gets the full ten-second BBJCelebration overlay
 * from `bbj_payout_complete`; if that table is the one on screen, the card
 * would be noise on top of it, so it is skipped when the hit's table is the
 * route's table.
 */

import { useCallback, useState } from 'react';
import { matchPath, useLocation } from 'react-router-dom';
import { masterBus } from '../../core/MasterBus';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { shouldAnnounceBbjHit } from '../../lib/bbjHitOnce';
import { soundService } from '../../services/SoundService';
import BBJHitNotification from './BBJHitNotification';

interface Notice {
  /** Remounts the card if a second jackpot lands while the first is still up. */
  key: string;
  winnerName: string;
  amount: number;
  tableName: string;
  tableId: string;
}

export function BBJHitAnnouncer() {
  const [notice, setNotice] = useState<Notice | null>(null);
  const location = useLocation();
  const onScreenTableId = matchPath('/table/:tableId', location.pathname)?.params.tableId ?? null;

  useMasterBusSubscription('BBJ_HIT_GLOBAL', (payload) => {
    if (!payload?.tableId) return;
    // The table on screen plays its own celebration; the card is for
    // everyone who is NOT looking at the hit.
    if (payload.tableId === onScreenTableId) return;

    /* Dan 2026-08-26: "it should only display once, and at the actual time
       it happens." Dan 2026-08-28: an unstamped event about a hit somewhere
       else cannot be proven live, so it is refused (`requireStamp`). Both
       producers stamp their events. */
    if (
      !shouldAnnounceBbjHit({
        tableId: payload.tableId,
        handNumber: payload.handNumber,
        emittedAt: payload.emittedAt,
        requireStamp: true,
      })
    ) {
      return;
    }

    if (soundService.isEnabled()) soundService.playBadBeatJackpot();

    setNotice({
      key: `${payload.tableId}:${payload.handNumber ?? 0}:${Date.now()}`,
      winnerName: payload.winnerName || 'A player',
      amount: Number(payload.amount) || 0,
      tableName: payload.tableName || 'a table',
      tableId: payload.tableId,
    });
  });

  const clear = useCallback(() => setNotice(null), []);

  if (!notice) return null;

  return (
    <BBJHitNotification
      key={notice.key}
      winnerName={notice.winnerName}
      amount={notice.amount}
      tableName={notice.tableName}
      onObserve={() => {
        masterBus.emit('OPEN_OBSERVE_TABLE', {
          tableId: notice.tableId,
          tableName: notice.tableName,
        });
        clear();
      }}
      onDone={clear}
    />
  );
}

export default BBJHitAnnouncer;
