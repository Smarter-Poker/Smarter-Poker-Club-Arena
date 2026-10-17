import { useCallback, useEffect, useRef, useState } from 'react';
import PageBar from '../components/help/PageBar';
import { Link, useParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { useClubNavigationAccess } from '../hooks/useClubNavigationAccess';
import { useToast } from '../components/common/Toast';
import { confirmDialog } from '../components/common/confirmDialog';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { resolveClubUUIDStrict } from '../utils/clubIdResolver';
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import { titleCase } from '../utils/titleCase';
import './ClubApplicantsPage.css';

interface Applicant {
  user_id: string;
  display_name: string;
  created_at: string;
}
interface Queue {
  scope: string;
  rows: Applicant[];
  error: string | null;
  loading: boolean;
}

export default function ClubApplicantsPage() {
  const { clubId = '' } = useParams();
  const { user } = useAuthUser();
  const access = useClubNavigationAccess(clubId);
  const toast = useToast();
  const scope = `${clubId}:${user?.id || ''}`;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const request = useRef(0);
  const operation = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [queue, setQueue] = useState<Queue>({ scope: '', rows: [], error: null, loading: true });

  const load = useCallback(async () => {
    if (!user || !access.canControlClub || access.loading || access.error) return;
    const version = ++request.current;
    const current = () => activeScope.current === scope && request.current === version;
    setQueue((previous) => ({
      scope,
      rows: previous.scope === scope ? previous.rows : [],
      error: null,
      loading: true,
    }));
    try {
      const uuid = await resolveClubUUIDStrict(clubId);
      const { data, error } = await supabase.rpc('fn_list_pending_members', { p_club_id: uuid });
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('The Club Did Not Return An Applicant Queue');
      if (current()) setQueue({ scope, rows: data, error: null, loading: false });
    } catch (error) {
      reportError(error, 'ClubApplicantsPage.load');
      if (current())
        setQueue({
          scope,
          rows: [],
          error: safeErrorMessage(error, 'Applicants Could Not Be Loaded'),
          loading: false,
        });
    }
  }, [access.canControlClub, access.error, access.loading, clubId, scope, user]);

  useEffect(() => {
    void load();
    const unsubscribe = masterBus.subscribeDebounced('CLUB_UPDATED', () => void load(), 300);
    return () => {
      request.current += 1;
      unsubscribe();
    };
  }, [load]);
  useEffect(() => {
    setBusy(null);
    return () => {
      if (activeScope.current === scope) activeScope.current = '';
    };
  }, [scope]);

  const review = async (applicant: Applicant, approve: boolean) => {
    if (operation.current || !access.canControlClub || queue.scope !== scope) return;
    operation.current = true;
    const ownerScope = scope;
    const isCurrent = () => activeScope.current === ownerScope;
    try {
      const confirmed = await confirmDialog({
        title: approve ? 'Approve Applicant' : 'Decline Applicant',
        message: approve
          ? `Admit ${titleCase(applicant.display_name || 'This Player')} To This Club?`
          : `Decline ${titleCase(applicant.display_name || 'This Player')}'s Join Request?`,
        confirmText: approve ? 'Approve' : 'Decline',
      });
      if (!confirmed || !isCurrent()) return;
      setBusy(applicant.user_id);
      const uuid = await resolveClubUUIDStrict(clubId);
      if (!isCurrent()) return;
      const { data, error } = await supabase.rpc('fn_review_join_request', {
        p_club_id: uuid,
        p_user_id: applicant.user_id,
        p_approve: approve,
      });
      if (error) throw error;
      if (data?.success !== true)
        throw new Error(data?.error || 'The Club Did Not Confirm This Decision');
      masterBus.emit('CLUB_UPDATED', { clubId: uuid });
      if (!isCurrent()) return;
      toast.success(approve ? 'Applicant Approved' : 'Applicant Declined');
      await load();
    } catch (error) {
      reportError(error, 'ClubApplicantsPage.review');
      if (isCurrent()) {
        toast.error(
          safeErrorMessage(error, 'Decision Could Not Be Confirmed. Refresh Before Trying Again.')
        );
        await load();
      }
    } finally {
      operation.current = false;
      if (isCurrent()) setBusy(null);
    }
  };
  const current = queue.scope === scope;
  return (
    <section className="club-applicants-page">
      <PageBar title="Applicants" summary="Review Requests To Join This Club.">
        <Link to={`/clubs/${clubId}/members`}>Back To Players</Link>
      </PageBar>
      {access.loading ? (
        <p role="status">Confirming Club Access...</p>
      ) : access.error ? (
        <div role="alert">
          <p>{access.error}</p>
          <button onClick={access.reload}>Retry Access</button>
        </div>
      ) : !access.canControlClub ? (
        <p role="note">Club Owner, CO Owner Or Admin Access Is Required.</p>
      ) : (
        <>
          <div className="applicants-toolbar">
            <h2>
              Pending Requests
              {current && !queue.loading && !queue.error ? ` (${queue.rows.length})` : ''}
            </h2>
            <button disabled={queue.loading || !!busy} onClick={() => void load()}>
              Refresh Applicants
            </button>
          </div>
          {!current || queue.loading ? (
            <p role="status">Loading Applicants...</p>
          ) : queue.error ? (
            <div role="alert">
              <p>{queue.error}</p>
              <button onClick={() => void load()}>Retry Applicant Queue</button>
            </div>
          ) : queue.rows.length === 0 ? (
            <p>No Pending Applicants. New Join Requests Will Appear Here.</p>
          ) : (
            <ul className="applicants-list">
              {queue.rows.map((applicant) => (
                <li key={applicant.user_id}>
                  <div>
                    <h3>{titleCase(applicant.display_name || 'Player')}</h3>
                    <p>Requested {new Date(applicant.created_at).toLocaleDateString()}</p>
                  </div>
                  <div className="applicant-actions">
                    <button disabled={!!busy} onClick={() => void review(applicant, false)}>
                      Decline
                    </button>
                    <button disabled={!!busy} onClick={() => void review(applicant, true)}>
                      {busy === applicant.user_id ? 'Processing...' : 'Approve'}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
