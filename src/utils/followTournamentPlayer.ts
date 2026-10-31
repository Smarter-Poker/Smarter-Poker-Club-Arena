/** An explicit player-watch gesture, never a turn-clock or urgency switch. */
export interface FollowTournamentPlayer {
  tournamentId: string;
  userId: string;
  username: string;
}

export function writePlayerFollow(params: URLSearchParams, target?: FollowTournamentPlayer) {
  if (!target) return;
  params.set('followTournament', target.tournamentId);
  params.set('followPlayer', target.userId);
  params.set('followName', target.username);
}

export function readPlayerFollow(params: URLSearchParams): FollowTournamentPlayer | undefined {
  const tournamentId = params.get('followTournament');
  const userId = params.get('followPlayer');
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!tournamentId || !userId || !uuid.test(tournamentId) || !uuid.test(userId)) return;
  return { tournamentId, userId, username: params.get('followName') || 'Player' };
}

export function samePlayerFollow(a?: FollowTournamentPlayer, b?: FollowTournamentPlayer) {
  return !!a && !!b && a.tournamentId === b.tournamentId && a.userId === b.userId;
}

interface FollowTab {
  id: string;
  seated?: boolean;
  followPlayer?: FollowTournamentPlayer;
}

/** Preserve played seats, deduplicate destinations, and never focus a background follow. */
export function movePlayerFollow<T extends FollowTab>(
  tabs: T[],
  activeIndex: number,
  sourceId: string,
  target: FollowTournamentPlayer,
  destination: T,
  cap: number
) {
  const sourceIndex = tabs.findIndex(
    (t) => t.id === sourceId && samePlayerFollow(t.followPlayer, target)
  );
  if (sourceIndex < 0 || sourceId === destination.id) return null;
  const source = tabs[sourceIndex];
  const activeId = tabs[activeIndex]?.id;
  const existing = tabs.find((t) => t.id === destination.id);
  if (!existing && source.seated && tabs.length >= cap) {
    return {
      tabs: tabs.map((t) => (t === source ? { ...t, followPlayer: undefined } : t)),
      activeIndex,
      full: true,
    };
  }
  let next: T[];
  if (existing) {
    next = tabs.flatMap((t) =>
      t === source
        ? source.seated
          ? [{ ...t, followPlayer: undefined }]
          : []
        : [{ ...t, ...(t === existing ? { followPlayer: target } : {}) }]
    );
  } else if (source.seated) {
    next = [
      ...tabs.map((t) => (t === source ? { ...t, followPlayer: undefined } : t)),
      { ...destination, followPlayer: target },
    ];
  } else {
    next = tabs.map((t) => (t === source ? { ...destination, followPlayer: target } : t));
  }
  const focusId = activeId === sourceId ? destination.id : activeId;
  return {
    tabs: next,
    activeIndex: Math.max(
      0,
      next.findIndex((t) => t.id === focusId)
    ),
    full: false,
  };
}
