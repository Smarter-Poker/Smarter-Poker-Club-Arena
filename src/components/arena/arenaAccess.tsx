import { createContext, useContext, type ReactNode } from 'react';
import type { ArenaAccessContext } from '../../../server/src/domain/ArenaContext';

/**
 * The arena entitlement the SERVER returned, published to the subtree below
 * ArenaAccessBoundary.
 *
 * Diamond Arena membership is a platform entitlement, not a `club_members`
 * row, so the chip club's membership guards would evict every Diamond player
 * from their own arena. They need to know which arena they are inside, and the
 * one honest answer is the boundary's own verified read of
 * `fn_poker_arena_context`. A browser-supplied club id or asset must never
 * select a wallet or grant access (programme, "Server-derived context"), so
 * nothing here is derived from the route: this carries the server's answer and
 * nothing else, and every read underneath is still decided by RLS.
 *
 * Null outside the boundary, which keeps every existing chip surface on its
 * current path.
 */
const ArenaAccessValue = createContext<ArenaAccessContext | null>(null);

export function ArenaAccessProvider({
  value,
  children,
}: {
  value: ArenaAccessContext | null;
  children: ReactNode;
}) {
  return <ArenaAccessValue.Provider value={value}>{children}</ArenaAccessValue.Provider>;
}

export function useArenaAccess(): ArenaAccessContext | null {
  return useContext(ArenaAccessValue);
}

/** True only inside an arena whose membership the server grants automatically. */
export function useAutomaticArenaMembership(): boolean {
  return useContext(ArenaAccessValue)?.automaticMembership === true;
}

/** True only inside an arena the server says holds no chip wallet. */
export function useArenaHasChipWallet(): boolean {
  const context = useContext(ArenaAccessValue);
  if (!context) return true;
  return context.arena.asset === 'chips' && context.capabilities?.chipWallet !== false;
}
