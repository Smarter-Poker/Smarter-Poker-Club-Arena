/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT RANKING HOST — app-root owner of the bust card (2026-08-20)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Sits beside SessionSummaryHost outside <Routes> and splits the same feed:
 *
 *   payload.tournament present  ->  this host renders the RANKING card
 *   payload.tournament absent   ->  SessionSummaryHost renders Session Complete
 *
 * One publisher, two cards, and the split is on the DATA rather than a flag, so
 * a tournament can never fall through to the cash summary and report a chip
 * profit for a seat where chips have no cash value.
 *
 * It lives at the app root for the reason the whole pendingSessionSummary
 * module exists: the player is mid-navigation when the result arrives, and
 * "the lobby" they land on is HomePage, ClubHomePage or ClubLobby depending on
 * where they came from. A route-level mount is torn down under them; this is
 * not.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  clearSessionSummary,
  peekSessionSummary,
  subscribeSessionSummary,
  type SessionSummaryPayload,
} from '../../services/pendingSessionSummary';
import TournamentRankingCard from './TournamentRankingCard';

export function TournamentRankingHost() {
  const [payload, setPayload] = useState<SessionSummaryPayload | null>(() =>
    peekSessionSummary()
  );

  useEffect(() => subscribeSessionSummary(setPayload), []);

  const close = useCallback(() => clearSessionSummary(), []);

  if (!payload?.tournament) return null;

  return (
    <TournamentRankingCard
      result={payload.tournament}
      tableName={payload.tableName}
      onDismiss={close}
    />
  );
}

export default TournamentRankingHost;
