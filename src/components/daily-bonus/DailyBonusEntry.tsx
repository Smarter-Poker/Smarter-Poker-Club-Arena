/**
 * DailyBonusEntry - opens the Daily Club Arena Bonus sheet on entry.
 *
 * "Given to all players for entering the Club Arena every single day" (Dan,
 * 2026-09-07). Mounted by the two hosts a signed-in player can land on, the
 * hub home and the AppLayout shell. Once per Chicago day it asks the server
 * whether today still has an unclaimed tile that has not been shown yet and,
 * if so, raises the sheet.
 *
 * ONE POPUP PER DAY (Dan, 2026-09-09: "JUST ONE POP UP PER DAY, NOT EVERYTIME
 * YOU OPEN IT"). Showing it is what spends the day, not closing it: the day
 * is marked the moment the sheet is raised, on the server (`sheet_shown_at`,
 * so no other device raises it) and in localStorage (this device, while that
 * write is in flight). The wallet door, the nav and /bonuses stay open all
 * day for a player who swiped it away.
 *
 * It never opens on a table, never over the first-run welcome or the profile
 * gate (the host passes `suspended`), and never on /bonuses, which renders
 * the same sheet inline.
 *
 * REPEATED VISITS (2026-09-09 audit). The first cut asked exactly once per
 * mount, which is not once per day: a PWA or a tab left open overnight came
 * back the next morning to a component that had already asked yesterday and
 * would never ask again, a sign-out and sign-in as somebody else inherited
 * the first account's answer, and one dropped request on entry (the 503s of
 * the 2026-09-09 04:40Z incident) silenced the sheet for the whole visit.
 * The ask is now keyed to (account, day): it runs again when the page is
 * looked at after the Chicago midnight the server reported, when the account
 * changes, when the tab regains focus or the network after a failed read,
 * and on a short bounded retry after a failure. A "nothing to show" answer
 * is remembered per tab until that midnight, so the hub home and the shell
 * (which mount this component in turn) do not each re-ask on every
 * navigation between them.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuthUser } from '../../hooks/useAuthUser';
import { dailyBonusService } from '../../services/DailyBonusService';
import { reportError } from '../../utils/errorReporter';
import DailyBonusSheet from './DailyBonusSheet';
import {
  MAX_RETRIES,
  MAX_TIMER_MS,
  RETRY_DELAY_MS,
  chicagoToday,
  isQuietPath,
  markQuiet,
  markSeenToday,
  quietUntil,
  shouldOpenSheet,
  wasSeenToday,
} from './entryState';

interface Asked {
  userId: string;
  /** Instant the answer stops being today's; null while unanswered. */
  validUntil: number | null;
}

export default function DailyBonusEntry({ suspended = false }: { suspended?: boolean }) {
  const { user } = useAuthUser();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [today, setToday] = useState<string | null>(null);
  const asked = useRef<Asked | null>(null);
  const pending = useRef(false);
  const retries = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rolloverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userId = user?.id ?? null;
  const pathname = location.pathname;
  const suspendedRef = useRef(suspended);
  const pathRef = useRef(pathname);
  const openRef = useRef(open);
  const userRef = useRef(userId);
  suspendedRef.current = suspended;
  pathRef.current = pathname;
  openRef.current = open;
  userRef.current = userId;

  const clearTimers = () => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    if (rolloverTimer.current) clearTimeout(rolloverTimer.current);
    retryTimer.current = null;
    rolloverTimer.current = null;
  };

  const ask = useCallback(async () => {
    if (!userId || suspendedRef.current || openRef.current || pending.current) return;
    if (isQuietPath(pathRef.current)) return;
    const prior = asked.current;
    if (
      prior &&
      prior.userId === userId &&
      prior.validUntil != null &&
      Date.now() < prior.validUntil
    ) {
      return; // asked today, answered
    }
    if (quietUntil(userId) != null) return;
    const localToday = chicagoToday();
    if (localToday && wasSeenToday(userId, localToday)) return;

    pending.current = true;
    try {
      const status = await dailyBonusService.getStatus();
      // The account changed while the read was in flight: the answer is
      // somebody else's.
      if (userRef.current !== userId) return;
      retries.current = 0;
      const resetAt = Date.parse(status.reset_at);
      const validUntil = Number.isFinite(resetAt) ? resetAt : null;
      asked.current = { userId, validUntil };
      if (validUntil != null) {
        // Ask again the moment the day rolls over, if the page is still here.
        if (rolloverTimer.current) clearTimeout(rolloverTimer.current);
        rolloverTimer.current = setTimeout(
          () => void ask(),
          Math.min(MAX_TIMER_MS, Math.max(1000, validUntil - Date.now() + 1000))
        );
      }
      if (shouldOpenSheet(status, userId)) {
        // ONE POPUP PER DAY. The day is marked seen the moment the sheet is
        // shown, not when it is closed: a tab closed with the sheet still up
        // is not a reason to show it again. The sheet itself records the
        // same fact on the server for every other device.
        markSeenToday(userId, status.today);
        setToday(status.today);
        setOpen(true);
      } else if (status.eligible) {
        markQuiet(userId, status.reset_at);
      }
    } catch (err) {
      // The sheet is a courtesy on entry; a failed read is not a failed page.
      // It is also not the last word: retry a few times, then on any signal.
      reportError(err, 'DailyBonusEntry.getStatus');
      asked.current = null;
      if (retries.current < MAX_RETRIES) {
        retries.current += 1;
        if (retryTimer.current) clearTimeout(retryTimer.current);
        retryTimer.current = setTimeout(() => void ask(), RETRY_DELAY_MS * retries.current);
      }
    } finally {
      pending.current = false;
    }
  }, [userId]);

  // Account change: whatever was asked or shown belonged to the last account.
  useEffect(() => {
    asked.current = null;
    retries.current = 0;
    setOpen(false);
    setToday(null);
  }, [userId]);

  // Entry, un-suspension, navigation off a quiet path and the sheet closing
  // each ask; the guard inside makes the repeat free once today is answered.
  useEffect(() => {
    void ask();
  }, [ask, suspended, pathname, open]);

  // A tab looked at again, focused, or back online: the day may have rolled
  // over, or the failed read on entry can be retried now.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void ask();
    };
    const onSignal = () => void ask();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onSignal);
    window.addEventListener('online', onSignal);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onSignal);
      window.removeEventListener('online', onSignal);
    };
  }, [ask]);

  useEffect(() => () => clearTimers(), []);

  // The Promotions door and the nav lead to /bonuses, which renders this
  // same sheet inline; a modal copy left open above it would be two sheets.
  // Closing here does not mark the day seen: the page is the sheet.
  useEffect(() => {
    if (open && isQuietPath(pathname)) setOpen(false);
  }, [open, pathname]);

  if (!open || !userId) return null;

  return (
    <DailyBonusSheet
      mode="modal"
      open
      onClose={() => {
        if (today) markSeenToday(userId, today);
        setOpen(false);
      }}
    />
  );
}
