import { useEffect } from 'react';

/**
 * THE TAB NAMES THE PAGE THE PLAYER IS ON (2026-10-17). A routed page that set
 * no title kept the previous page's: the Midway Union lobby, Transactions,
 * VIP, Rakeback, Promotions, Bonuses, Players, Data, Stats and the 404 page
 * all read "Wallet | Smarter Poker" or "Daily Challenges | Smarter Poker".
 * Each routed page names itself; an empty name leaves the title alone until
 * the page knows it (a club page waiting on its club).
 */
export function usePageTitle(name: string | null | undefined): void {
  useEffect(() => {
    const clean = (name ?? '').trim();
    if (clean) document.title = `${clean} | Smarter Poker`;
  }, [name]);
}
