import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useClubWorkspace } from '../../contexts/ClubWorkspaceContext';
import { useAuthUser } from '../../hooks/useAuthUser';
import { useToast } from '../common/Toast';
import { supabase } from '../../lib/supabase';
import { masterBus } from '../../core/MasterBus';
import { reportError } from '../../utils/errorReporter';
import { safeErrorMessage } from '../../utils/safeErrorMessage';
import { CLUB_ENTRY_MESSAGE_MAX } from './ClubEntryMessage';
import './ClubControlActions.css';

/** The existing message transaction owns revision bumping and member delivery. */
export default function ClubControlActions() {
  const workspace = useClubWorkspace();
  const { user } = useAuthUser();
  const toast = useToast();
  const scope = `${workspace.clubUUID}:${user?.id}`;
  const active = useRef(scope);
  active.current = scope;
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{
    scope: string;
    message: string;
    public: boolean;
    approval: boolean;
    error: string | null;
  } | null>(null);
  const [draft, setDraft] = useState('');
  const load = useCallback(async () => {
    if (!workspace.clubUUID || !workspace.canControlClub) return;
    try {
      const { data, error } = await supabase
        .from('clubs')
        .select('lobby_message,is_public,requires_approval')
        .eq('id', workspace.clubUUID)
        .maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('Club Policy Could Not Be Loaded');
      if (active.current !== scope) return;
      const message = data.lobby_message || '';
      setState({
        scope,
        message,
        public: data.is_public,
        approval: data.requires_approval,
        error: null,
      });
      setDraft(message);
    } catch (error) {
      reportError(error, 'ClubControlActions.load');
      if (active.current === scope)
        setState({
          scope,
          message: '',
          public: false,
          approval: false,
          error: safeErrorMessage(error, 'Club Policy Could Not Be Loaded'),
        });
    }
  }, [scope, workspace.canControlClub, workspace.clubUUID]);
  useEffect(() => {
    void load();
    return () => {
      if (active.current === scope) active.current = '';
    };
  }, [load, scope]);
  useEffect(() => {
    setBusy(false);
  }, [scope]);
  const current = state?.scope === scope ? state : null;
  const save = async () => {
    if (
      busyRef.current ||
      !current ||
      current.error ||
      !workspace.clubUUID ||
      !workspace.canControlClub
    )
      return;
    const uuid = workspace.clubUUID;
    const ownerScope = scope;
    busyRef.current = true;
    setBusy(true);
    try {
      const next = draft.replace(/\s+/g, ' ').trim();
      const { data, error } = await supabase.rpc('fn_set_club_lobby_message', {
        p_club_id: uuid,
        p_message: next,
      });
      if (error) throw error;
      if (data?.ok !== true)
        throw new Error(data?.reason || 'The Club Did Not Confirm The Message');
      masterBus.emit('CLUB_SETTINGS_UPDATED', { clubId: uuid });
      masterBus.emit('CLUB_UPDATED', { clubId: uuid });
      if (active.current !== ownerScope) return;
      const saved = data.lobby_message || '';
      setDraft(saved);
      setState((previous) =>
        previous?.scope === ownerScope ? { ...previous, message: saved } : previous
      );
      toast.success('Club Message Saved');
    } catch (error) {
      reportError(error, 'ClubControlActions.save');
      if (active.current === ownerScope)
        toast.error(safeErrorMessage(error, 'Club Message Could Not Be Saved'));
    } finally {
      busyRef.current = false;
      if (active.current === ownerScope) setBusy(false);
    }
  };
  if (!workspace.canControlClub || workspace.loading || workspace.error) return null;
  return (
    <section className="club-control-actions" aria-label="Club Policy Controls">
      <div className="control-policy">
        <h2>Membership & Access</h2>
        {!current ? (
          <p role="status">Loading Club Policy...</p>
        ) : current.error ? (
          <div role="alert">
            <p>{current.error}</p>
            <button onClick={() => void load()}>Retry Policy</button>
          </div>
        ) : (
          <>
            <p>
              {current.public ? 'Public Club' : 'Private Club'} ·{' '}
              {current.approval
                ? 'New Members Require Approval'
                : 'New Members Join Without Review'}
            </p>
            <Link to={`/clubs/${workspace.routeClubId}/applicants`}>Review Applicants</Link>
            <Link to={`/clubs/${workspace.routeClubId}/settings#settings-privacy`}>
              Joining Policy
            </Link>
          </>
        )}
      </div>
      <div className="control-message">
        <h2>Club Entry Message</h2>
        <p>This Message Greets Members When They Enter The Club. Updates Show Again To Members.</p>
        <label htmlFor="control-club-message">Message</label>
        <textarea
          id="control-club-message"
          rows={3}
          maxLength={CLUB_ENTRY_MESSAGE_MAX}
          value={current ? draft : ''}
          disabled={!current || !!current.error || busy}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="control-message-actions">
          <span>
            {draft.length}/{CLUB_ENTRY_MESSAGE_MAX}
          </span>
          <button
            disabled={!current || !!current.error || busy || draft === current.message}
            onClick={() => void save()}
          >
            {busy ? 'Saving...' : 'Save Club Message'}
          </button>
        </div>
      </div>
    </section>
  );
}
