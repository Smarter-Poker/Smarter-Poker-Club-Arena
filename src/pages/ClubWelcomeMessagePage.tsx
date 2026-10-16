import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { SpadeConsole } from '../components/console/SpadeConsole';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import { resolveClubUUIDStrict } from '../utils/clubIdResolver';
import { titleCase } from '../utils/titleCase';
import { reportError } from '../utils/errorReporter';
import {
  readClubWelcomeSettings,
  saveClubWelcomeSettings,
  type ClubWelcomeSettings,
} from '../services/ClubWelcomeMessageService';
import './ClubWelcomeMessagePage.css';

export default function ClubWelcomeMessagePage() {
  const { user } = useAuthUser();
  const { clubId } = useParams<{ clubId: string }>();
  const toast = useToast();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const actor = useRef<string | null>(user?.id || null);
  actor.current = user?.id || null;
  const scope = `${user?.id || ''}:${clubId || ''}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [clubs, setClubs] = useState<ClubWelcomeSettings[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [content, setContent] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const pending = useRef<{ signature: string; requestId: string } | null>(null);
  const selected = clubs.find((club) => club.club_id === selectedId);
  useEffect(() => {
    let live = true;
    const accountId = user?.id;
    setClubs([]);
    setSelectedId('');
    setContent('');
    setEnabled(false);
    setLoading(true);
    setSaving(false);
    setError('');
    pending.current = null;
    if (!accountId) {
      setLoading(false);
      return;
    }
    const capturedScope = scope;
    void (async () => {
      try {
        const rows = await readClubWelcomeSettings(accountId, () => actor.current);
        const resolved = clubId ? await resolveClubUUIDStrict(clubId) : null;
        if (!live || currentScope.current !== capturedScope) return;
        if (clubId && (!resolved || !rows.some((row) => row.club_id === resolved)))
          throw new Error('An Active Club Staff Role Is Required');
        const available = resolved ? rows.filter((row) => row.club_id === resolved) : rows;
        setClubs(available);
        const choice = available.length === 1 ? available[0] : null;
        setSelectedId(choice?.club_id || '');
        setContent(choice?.content || '');
        setEnabled(choice?.enabled || false);
      } catch (failure) {
        if (!live || currentScope.current !== capturedScope) return;
        reportError(failure, 'ClubWelcomeMessagePage.load');
        setError(failure instanceof Error ? failure.message : 'Welcome Messages Are Unavailable');
      } finally {
        if (live && currentScope.current === capturedScope) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [scope, reload, user?.id, clubId]);
  const chooseClub = (id: string) => {
    if (saving) return;
    const choice = clubs.find((row) => row.club_id === id);
    setSelectedId(choice?.club_id || '');
    setContent(choice?.content || '');
    setEnabled(choice?.enabled || false);
    setError('');
    pending.current = null;
  };
  const save = async () => {
    const accountId = actor.current;
    if (!selected || !accountId || saving) return;
    const capturedScope = currentScope.current;
    const selectedClub = selected.club_id;
    const input = { clubId: selectedClub, content, enabled, revision: selected.revision };
    const signature = JSON.stringify(input);
    if (pending.current?.signature !== signature)
      pending.current = { signature, requestId: crypto.randomUUID() };
    setSaving(true);
    setError('');
    try {
      const receipt = await saveClubWelcomeSettings(accountId, () => actor.current, {
        ...input,
        requestId: pending.current.requestId,
      });
      if (!mounted.current || currentScope.current !== capturedScope || actor.current !== accountId)
        return;
      setClubs((previous) =>
        previous.map((row) => (row.club_id === selectedClub ? { ...row, ...receipt } : row))
      );
      setContent(receipt.content);
      setEnabled(receipt.enabled);
      pending.current = null;
      toast.success('Welcome Message Saved');
    } catch (failure) {
      if (!mounted.current || currentScope.current !== capturedScope || actor.current !== accountId)
        return;
      reportError(failure, 'ClubWelcomeMessagePage.save');
      setError(
        failure instanceof Error ? failure.message : 'Save Could Not Be Confirmed. Retry Or Reload.'
      );
    } finally {
      if (mounted.current && currentScope.current === capturedScope && actor.current === accountId)
        setSaving(false);
    }
  };
  return (
    <StandardContentLayout className="club-welcome-page">
      <SpadeConsole
        title="Custom Welcome Message"
        eyebrow={selected ? titleCase(selected.club_name) : 'Club Messenger'}
        subtitle="Your Message To New Downline Players"
        foot={selected && !loading ? 'plates' : 'foot'}
        plates={
          selected && !loading
            ? {
                secondary: {
                  label: 'Reload',
                  onClick: () => setReload((value) => value + 1),
                  disabled: saving,
                },
                primary: {
                  label: saving ? 'Saving' : 'Save Message',
                  onClick: () => void save(),
                  disabled: saving || (enabled && !content.trim()) || content.length > 2000,
                },
              }
            : undefined
        }
      >
        <div className="club-welcome-body" aria-busy={loading || saving}>
          {loading ? (
            <p role="status">Loading Welcome Message...</p>
          ) : (
            <>
              {error && <p role="alert">{titleCase(error)}</p>}
              {!clubs.length && !error && (
                <p>No Eligible Clubs. An Active Club Staff Role Is Required.</p>
              )}
              {!selected && (
                <>
                  {clubs.length > 0 && (
                    <label>
                      Choose Your Club
                      <select
                        aria-label="Choose Your Club"
                        value={selectedId}
                        onChange={(event) => chooseClub(event.target.value)}
                      >
                        <option value="">Choose A Club</option>
                        {clubs.map((club) => (
                          <option key={club.club_id} value={club.club_id}>
                            {titleCase(club.club_name)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button type="button" onClick={() => setReload((value) => value + 1)}>
                    Reload
                  </button>
                </>
              )}
              {selected && (
                <>
                  {clubs.length > 1 && (
                    <label>
                      Club
                      <select
                        aria-label="Club"
                        value={selectedId}
                        disabled={saving}
                        onChange={(event) => chooseClub(event.target.value)}
                      >
                        {clubs.map((club) => (
                          <option key={club.club_id} value={club.club_id}>
                            {titleCase(club.club_name)}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <p>
                    This Message Comes From Your Account After A Player Joins And Is Attached To
                    Your Downline. Players Without An Assigned Agent Receive An Enabled Welcome
                    Message From The Club Owner.
                  </p>
                  <label className="club-welcome-enabled">
                    <input
                      type="checkbox"
                      checked={enabled}
                      disabled={saving}
                      onChange={(event) => setEnabled(event.target.checked)}
                    />
                    Automatically Send My Welcome Message
                  </label>
                  <label>
                    Custom Message
                    <textarea
                      aria-label="Custom Message"
                      value={content}
                      maxLength={2000}
                      disabled={saving}
                      onChange={(event) => setContent(event.target.value)}
                      placeholder="Welcome To The Club! Message Me Here If You Need Help."
                    />
                  </label>
                  <p className="club-welcome-count">
                    {content.length.toLocaleString()} / 2,000 Characters
                  </p>
                  <p>
                    Saving Applies To Future Joins And New Downline Assignments. Existing Members
                    Are Not Sent A Bulk Message. Personal Blocks Are Respected.
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </SpadeConsole>
    </StandardContentLayout>
  );
}
