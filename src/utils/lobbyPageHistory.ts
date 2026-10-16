import type { InTabTournamentTarget } from '../context/InTabLobbyContext';

export interface LobbyPageSnapshot {
  lobbyClubId: string | null;
  lobbyTournamentId?: string;
  lobbyTournamentStack?: InTabTournamentTarget[];
}

export interface LobbyPageState {
  lobbyClubId?: string | null;
  lobbyTournamentId?: string;
  lobbyTournamentStack?: InTabTournamentTarget[];
  lobbyPageHistory?: LobbyPageSnapshot[];
}

/** Capture the page on screen at the gesture, never a later club preference. */
export function rememberLobbyPage<T extends LobbyPageState>(page: T, homeClubId: string | null): T {
  return {
    ...page,
    lobbyPageHistory: [
      ...(page.lobbyPageHistory ?? []),
      {
        lobbyClubId: page.lobbyClubId === undefined ? homeClubId : page.lobbyClubId,
        lobbyTournamentId: page.lobbyTournamentId,
        lobbyTournamentStack: page.lobbyTournamentStack,
      },
    ],
  };
}

/** One chronological stack covers both arena switches and tournament drill-ins. */
export function restoreLobbyPage<T extends LobbyPageState>(page: T): T | null {
  const history = page.lobbyPageHistory ?? [];
  const previous = history[history.length - 1];
  if (!previous) return null;
  return { ...page, ...previous, lobbyPageHistory: history.slice(0, -1) };
}
