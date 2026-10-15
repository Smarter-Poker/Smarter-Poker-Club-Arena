/**
 * /i/:code inside Club Arena - a Share & Invite short link opened in the app.
 *
 * On the web, smarter.poker/i/<CODE> is the World Hub's landing page (link
 * preview, attribution cookie, Create Account first). Inside the native app a
 * universal link or clubarena://i/<CODE> lands here instead (deepLinks.ts maps
 * both), so this page does the same job in-app: remember the code, resolve it,
 * and go to the club's join page, which sends a signed-out player to create an
 * account and claims the invite for a signed-in one.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import PageSkeleton from '../components/common/PageSkeleton';
import {
  normalizeInviteCode,
  rememberInviteCode,
  resolveInviteCode,
} from '../services/ClubInviteService';
import { reportError } from '../utils/errorReporter';
import './InvitePage.css';

export default function InviteCodePage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const normalized = normalizeInviteCode(code);
    if (!normalized) {
      setFailed(true);
      return;
    }
    rememberInviteCode(normalized);
    let alive = true;
    resolveInviteCode(normalized)
      .then((r) => {
        if (!alive) return;
        if (r) navigate(r.inAppPath, { replace: true });
        else setFailed(true);
      })
      .catch((err) => {
        reportError(err, 'InviteCodePage.resolve');
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [code, navigate]);

  if (failed) {
    return (
      <div className="invite-page">
        <div className="invite-frame">
          <div className="invite-card error-state">
            <div className="invite-plaque">Club Invite</div>
            <h2>This Invite Did Not Work</h2>
            <p>The Link May Be Mistyped Or The Club Is No Longer Available.</p>
            <button
              className="invite-btn invite-btn--primary"
              onClick={() => navigate('/clubs-list', { replace: true })}
            >
              Browse Clubs
            </button>
          </div>
        </div>
      </div>
    );
  }
  return <PageSkeleton variant="default" />;
}
