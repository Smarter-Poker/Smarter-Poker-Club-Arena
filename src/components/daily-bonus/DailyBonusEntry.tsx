/**
 * DailyBonusEntry - opens the Daily Club Arena Bonus sheet on entry.
 *
 * "Given to all players for entering the Club Arena every single day" (Dan,
 * 2026-09-07). Mounted by the two hosts a signed-in player can land on, the
 * hub home and the AppLayout shell. Once per Chicago day per device it asks
 * the server whether today still has an unclaimed tile and, if so, raises the
 * sheet. Dismissing it is remembered for the day in localStorage (best
 * effort: a private window simply sees it again), and the wallet door, the
 * nav and /bonuses stay open all day for a player who swiped it away.
 *
 * It never opens on a table, never over the first-run welcome or the profile
 * gate (the host passes `suspended`), and never on /bonuses, which renders
 * the same sheet inline.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import { dailyBonusService } from '../../services/DailyBonusService';
import { reportError } from '../../utils/errorReporter';
import DailyBonusSheet from './DailyBonusSheet';

const SEEN_PREFIX = 'ca_daily_bonus_seen:';

function seenKey(userId: string, today: string): string {
  return `${SEEN_PREFIX}${userId}:${today}`;
}

export function wasSeenToday(userId: string, today: string): boolean {
  try {
    return localStorage.getItem(seenKey(userId, today)) === '1';
  } catch {
    return false;
  }
}

export function markSeenToday(userId: string, today: string): void {
  try {
    localStorage.setItem(seenKey(userId, today), '1');
    // Yesterday's marks are dead weight; one key per player per day never
    // accumulates past a handful.
    for (let i = localStorage.length - 1; i >= 0; i -= 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(`${SEEN_PREFIX}${userId}:`) && key !== seenKey(userId, today)) {
        localStorage.removeItem(key);
      }
    }
  } catch {
    /* storage unavailable */
  }
}

function isQuietPath(pathname: string): boolean {
  return (
    pathname.startsWith('/table') ||
    pathname.startsWith('/bonuses') ||
    pathname.startsWith('/multi-table') ||
    (pathname.startsWith('/tournaments/') && pathname.endsWith('/play'))
  );
}

export default function DailyBonusEntry({ suspended = false }: { suspended?: boolean }) {
  const { user } = useAuthUser();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [today, setToday] = useState<string | null>(null);
  const asked = useRef(false);

  useEffect(() => {
    if (!user?.id || suspended || asked.current || isQuietPath(location.pathname)) return;
    asked.current = true;
    const userId = user.id;
    let cancelled = false;
    (async () => {
      try {
        const status = await dailyBonusService.getStatus();
        if (cancelled) return;
        if (!status.eligible || status.unclaimed <= 0) return;
        if (wasSeenToday(userId, status.today)) return;
        setToday(status.today);
        setOpen(true);
      } catch (err) {
        // The sheet is a courtesy on entry; a failed read is not a failed page.
        reportError(err, 'DailyBonusEntry.getStatus');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, suspended, location.pathname]);

  // The Promotions door and the nav lead to /bonuses, which renders this
  // same sheet inline; a modal copy left open above it would be two sheets.
  // Closing here does not mark the day seen: the page is the sheet.
  useEffect(() => {
    if (open && isQuietPath(location.pathname)) setOpen(false);
  }, [open, location.pathname]);

  if (!open || !user?.id) return null;

  return (
    <DailyBonusSheet
      mode="modal"
      open
      onClose={() => {
        if (today) markSeenToday(user.id, today);
        setOpen(false);
      }}
    />
  );
}
