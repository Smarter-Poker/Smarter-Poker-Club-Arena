import { useEffect, useRef, useState } from 'react';

/** How long the page waits before it replays a saved wager again. The first
 * try is immediate; each failure doubles the wait up to eight seconds, and
 * the page keeps trying for as long as the wager is unsettled. */
export const settleDelay = (attempt: number) =>
  attempt <= 0 ? 0 : Math.min(500 * 2 ** attempt, 8000);

/** A saved wager settles itself.
 *
 * Every Diamond Spins game saves a wager before it sends the money request, so
 * a dropped answer can be replayed against the same sealed ticket. Until
 * 2026-09-21 the replay was a button ("Check Round"), and a wager the server
 * had rejected outright left the player pressing it forever with the bonus
 * guard holding every exit. No game may require a player to check anything:
 * while `pending` is true this hook calls `settle` on the schedule above, and
 * the page decides the outcome (settled, refused, or try again).
 *
 * `settle` resolves true when it ran and false when the page was busy with
 * something else; a skipped turn is retried shortly rather than counted as a
 * failure. `attempts` is the page's own failure count, bumped by the page on
 * every replay that neither settled nor was refused.
 *
 * A background tab replays nothing (2026-09-22). While `document.hidden` the
 * wait is held; when the tab is visible again the same wait finishes (at once,
 * if it fell due meanwhile) rather than starting over, so switching tabs can
 * neither skip the backoff nor stretch it. Each wait fires at most once. */
export function useAutoSettle(pending: boolean, attempts: number, settle: () => Promise<boolean>) {
  const latest = useRef(settle);
  latest.current = settle;
  const [skipped, setSkipped] = useState(0);
  // A skipped turn is a short wait; a turn that ran and failed is on the
  // failure schedule, so the skip count starts over whenever the page reports
  // another attempt, and whenever the wager is settled.
  useEffect(() => {
    setSkipped(0);
  }, [pending, attempts]);
  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = skipped ? 400 : settleDelay(attempts);
    const due = performance.now() + wait;
    function run() {
      document.removeEventListener('visibilitychange', visibility);
      void latest.current().then((ran) => {
        if (!cancelled && !ran) setSkipped((count) => count + 1);
      });
    }
    function visibility() {
      clearTimeout(timer);
      timer = document.hidden ? undefined : setTimeout(run, Math.max(0, due - performance.now()));
    }
    document.addEventListener('visibilitychange', visibility);
    if (!document.hidden) timer = setTimeout(run, wait);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [pending, attempts, skipped]);
}

/** A paused game comes back by itself.
 *
 * While the platform has games paused (the hourly break, maintenance) a page
 * used to tell the player to refresh after the break. It reads its own state
 * again instead, quietly, for as long as `active` is true and the tab is in
 * the foreground. */
export function useStandingRefresh(active: boolean, refresh: () => void, everyMs = 15_000) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (!document.hidden) latest.current();
    }, everyMs);
    return () => clearInterval(timer);
  }, [active, everyMs]);
}
