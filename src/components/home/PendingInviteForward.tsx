/**
 * A player invited to a club who has not joined it yet is taken to that club's
 * join page when they land on the arena home (Dan 2026-10-15: "AFTER THE
 * PERSON HAS CREATED THE ACCOUNT, VERIFIED THEIR NUMBER, IT SHOULD OPEN
 * DIRECTLY UP TO THAT CLUB TO JOIN").
 *
 * The signup flow already routes there on its own. This catches everyone the
 * flow could not carry: the player who skipped the phone step and came back
 * later, who confirmed their email on another device, or who closed the tab.
 * fn_club_invite_pending answers from the database, so it works on any device.
 *
 * Once per browser session: a player who backs out of the join page to look
 * around is not pushed into it again.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { getPendingClubInvite } from '../../services/ClubInviteService';
import { reportError } from '../../utils/errorReporter';

export const PENDING_INVITE_SHOWN_KEY = 'sp-pending-invite-forwarded';

export default function PendingInviteForward() {
  const navigate = useNavigate();

  useEffect(() => {
    // Claim the once-per-session slot BEFORE asking the database, so the RPC
    // runs at most once per browser session even when nothing is pending
    // (the arena home mounts this on every visit).
    try {
      if (window.sessionStorage.getItem(PENDING_INVITE_SHOWN_KEY)) return;
      window.sessionStorage.setItem(PENDING_INVITE_SHOWN_KEY, 'checked');
    } catch {
      /* storage unavailable: still forward once for this mount */
    }
    let alive = true;
    getPendingClubInvite()
      .then((pending) => {
        if (!alive || !pending) return;
        try {
          window.sessionStorage.setItem(PENDING_INVITE_SHOWN_KEY, pending.clubId);
        } catch {
          /* ignore */
        }
        navigate(pending.inAppPath);
      })
      .catch((err) => reportError(err, 'PendingInviteForward.read'));
    return () => {
      alive = false;
    };
  }, [navigate]);

  return null;
}
