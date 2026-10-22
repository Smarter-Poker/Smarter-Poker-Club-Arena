import { useEffect, useState, type ReactNode } from 'react';
import { useFitText } from '../lobby/game-cards/useFitText';
import { lateRegEndMs } from '../lobby/lateRegWindow';
import type { LobbyTournamentRow } from '../lobby/lobbyEntries';
import { tournamentService } from '../../services/TournamentService';
import { tournamentEntryWindowOpen } from '../../utils/tournamentEntryWindow';
import { serverNow } from '../../utils/serverClock';
import './WaitlistCallToAction.css';

/**
 * THE TOURNAMENT SPECTATOR CALL TO ACTION (Dan 2026-10-21)
 *
 * Dan, with a screenshot of "Table Full · 0 Waiting / Join The Waiting List"
 * printed under a running MTT: "THIS 'TABLE FULL JOIN THE WAITING LIST' SHOULD
 * NEVER BE DISPLAYED WHEN WATCHING A TOURNAMENT OR ON A TOURNAMENT PAGE. THERE
 * SHOULD BE A MTT ONE THAT SAYS 'XYZ AMOUNT OF TIME LEFT BEFORE REGISTRATION
 * CLOSES' CLICK HERE TO REGISTER."
 *
 * A tournament has no waiting list. A spectator at a tournament table can do
 * exactly one thing: enter the event while late registration is open. So
 * this prints the time left in the entry window on the same painted action
 * shell the cash call to action uses (#ClubArenaConsole, nothing drawn here),
 * and the tap takes the player to the tournament's own page, which owns the
 * real registration flow (buy-in sheet, tickets, Diamonds, refusals).
 *
 * The deadline is `lateRegEndMs`, the same projection every lobby card uses:
 * the level window's end or the configured clock, whichever comes first. Once
 * the window is closed nothing is offered and the page prints "Spectating".
 */
export interface TournamentLateRegCallToActionProps {
  tournamentId: string;
  /** Changes at every hand boundary: the honest tick to re-read the row. */
  refreshKey?: number;
  /** A background slot stays mounted; it stops its clock while off screen. */
  hidden?: boolean;
  onRegister: () => void;
  /** Rendered when late registration is closed or unknown. */
  fallback: ReactNode;
}

type LateRegRow = LobbyTournamentRow & { status?: string | null };

export function fmtLateRegClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? m.toString().padStart(2, '0') : String(m);
  const tail = `${mm}:${sec.toString().padStart(2, '0')}`;
  return h > 0 ? `${h}:${tail}` : tail;
}

/** Copy for the shell, or null when nothing should be offered. Pure for tests. */
export function lateRegCallToActionCopy(
  row: LateRegRow | null,
  nowMs: number
): { eyebrow: string; title: string } | null {
  if (!row) return null;
  if (!tournamentEntryWindowOpen(row, nowMs)) return null;
  const endsAt = lateRegEndMs(row);
  const title = 'Tap Here To Register';
  if (endsAt === null) return { eyebrow: 'Late Registration Is Open', title };
  const left = (endsAt - nowMs) / 1000;
  if (left <= 0) return null;
  return { eyebrow: `${fmtLateRegClock(left)} Left Before Registration Closes`, title };
}

export function TournamentLateRegCallToAction({
  tournamentId,
  refreshKey,
  hidden,
  onRegister,
  fallback,
}: TournamentLateRegCallToActionProps) {
  const [row, setRow] = useState<LateRegRow | null>(null);
  const [nowMs, setNowMs] = useState(() => serverNow());

  useEffect(() => {
    if (hidden) return;
    let cancelled = false;
    void tournamentService.getTournament(tournamentId).then((t) => {
      if (!cancelled) setRow((t as unknown as LateRegRow | null) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [tournamentId, refreshKey, hidden]);

  const copy = lateRegCallToActionCopy(row, nowMs);
  const open = copy !== null;

  useEffect(() => {
    if (hidden || !open) return;
    const id = window.setInterval(() => setNowMs(serverNow()), 1000);
    return () => window.clearInterval(id);
  }, [hidden, open]);

  const eyebrow = copy?.eyebrow ?? '';
  const title = copy?.title ?? '';
  const socketRef = useFitText<HTMLSpanElement>('+', 1, 0.5);
  const eyebrowRef = useFitText<HTMLSpanElement>(eyebrow, 1, 0.5);
  const titleRef = useFitText<HTMLSpanElement>(title, 1, 0.5);

  if (!copy) return <>{fallback}</>;

  return (
    <button
      type="button"
      className="waitlist-cta"
      data-testid="tournament-late-reg-cta"
      onClick={onRegister}
      aria-label={`${eyebrow}. ${title}`}
    >
      <span className="waitlist-cta__socket" aria-hidden="true">
        <span ref={socketRef} className="waitlist-cta__socket-text">
          +
        </span>
      </span>
      <span className="waitlist-cta__face" aria-hidden="true">
        <span className="waitlist-cta__line">
          <span ref={eyebrowRef} className="waitlist-cta__eyebrow">
            {eyebrow}
          </span>
        </span>
        <span className="waitlist-cta__line">
          <span ref={titleRef} className="waitlist-cta__title">
            {title}
          </span>
        </span>
      </span>
    </button>
  );
}
