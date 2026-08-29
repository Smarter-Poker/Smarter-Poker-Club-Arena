/** Club access exclusion controls. Route: /clubs/:clubId/blacklist */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import ClubIntegrityHeader from '../components/club/ClubIntegrityHeader';
import { useAuthUser } from '../hooks/useAuthUser';
import { supabase } from '../lib/supabase';
import type { BlacklistEntry } from '../types/club.types';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import styles from './BlacklistManagerPage.module.css';

export default function BlacklistManagerPage() {
  const { clubId } = useParams<{ clubId: string }>();
  const { user } = useAuthUser();
  const [entries, setEntries] = useState<BlacklistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newUserId, setNewUserId] = useState('');
  const [newReason, setNewReason] = useState('');
  const [newExpiry, setNewExpiry] = useState('');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState<string | null>(null);

  const loadEntries = useCallback(async () => {
    if (!clubId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setLoadFailed(false);
    try {
      // Public club routes use slugs, while blacklists.club_id is a UUID.
      const resolvedClubId = await resolveClubUUID(clubId);
      const { data, error: fetchError } = await supabase
        .from('blacklists')
        .select('*')
        .eq('club_id', resolvedClubId)
        .order('banned_at', { ascending: false });
      if (fetchError) throw fetchError;
      setEntries(data || []);
    } catch (loadError) {
      setEntries([]);
      setLoadFailed(true);
      setError(safeErrorMessage(loadError, 'The exclusion list could not be loaded.'));
    } finally {
      setLoading(false);
    }
  }, [clubId]);

  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  const resetForm = () => {
    setShowAddForm(false);
    setNewUserId('');
    setNewReason('');
    setNewExpiry('');
  };

  const handleAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!clubId || !user || !newUserId.trim() || !newReason.trim()) return;
    setAdding(true);
    setError(null);
    setLoadFailed(false);
    try {
      const resolvedClubId = await resolveClubUUID(clubId);
      const entry: Partial<BlacklistEntry> = {
        club_id: resolvedClubId,
        user_id: newUserId.trim(),
        reason: newReason.trim(),
        banned_by: user.id,
        banned_at: new Date().toISOString(),
      };
      if (newExpiry) entry.expires_at = new Date(newExpiry).toISOString();
      const { error: insertError } = await supabase.from('blacklists').insert(entry);
      if (insertError) throw insertError;
      resetForm();
      await loadEntries();
    } catch (addError) {
      setError(safeErrorMessage(addError, 'The player could not be excluded.'));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (entryId: string) => {
    setRemoving(entryId);
    setError(null);
    setLoadFailed(false);
    try {
      const { error: deleteError } = await supabase.from('blacklists').delete().eq('id', entryId);
      if (deleteError) throw deleteError;
      setEntries((current) => current.filter((entry) => entry.id !== entryId));
      setConfirmingRemoval(null);
    } catch (removeError) {
      setError(safeErrorMessage(removeError, 'The exclusion could not be removed.'));
    } finally {
      setRemoving(null);
    }
  };

  const isExpired = (entry: BlacklistEntry) =>
    Boolean(entry.expires_at && new Date(entry.expires_at) < new Date());
  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const activeCount = entries.filter((entry) => !isExpired(entry)).length;
  const permanentCount = entries.filter((entry) => !entry.expires_at).length;

  return (
    <div className={styles.page}>
      <ClubIntegrityHeader
        clubId={clubId}
        active="blacklist"
        eyebrow="Access control / final case state"
        title="Club Exclusion Control"
        description="Apply deliberate, auditable club-access exclusions with a stated reason and an optional expiry."
        metrics={[
          { label: 'Active', value: activeCount, tone: activeCount ? 'risk' : 'neutral' },
          { label: 'Permanent', value: permanentCount },
          { label: 'Total Records', value: entries.length },
        ]}
        action={
          <button className={styles.addButton} type="button" onClick={() => setShowAddForm(true)}>
            Add exclusion
          </button>
        }
      />

      <main className={styles.workspace}>
        <div className={styles.workspaceHeading}>
          <div>
            <p className={styles.kicker}>Controlled access ledger</p>
            <h2>Excluded players</h2>
          </div>
          {clubId && <Link to={`/clubs/${clubId}/operations`}>Return to operations</Link>}
        </div>

        {error && (
          <div className={styles.errorPanel} role="alert">
            <div>
              <strong>
                {loadFailed ? 'Exclusion ledger unavailable' : 'Control action incomplete'}
              </strong>
              <p>{error}</p>
            </div>
            {loadFailed ? (
              <button type="button" onClick={() => void loadEntries()}>
                Retry
              </button>
            ) : (
              <button type="button" onClick={() => setError(null)}>
                Dismiss
              </button>
            )}
          </div>
        )}

        {showAddForm && (
          <form className={styles.formPanel} onSubmit={handleAdd}>
            <div className={styles.panelHeader}>
              <div>
                <p className={styles.kicker}>New control record</p>
                <h2>Exclude a player</h2>
              </div>
              <span>Reason required</span>
            </div>
            <div className={styles.formGrid}>
              <div className={styles.field}>
                <label htmlFor="blacklist-user-id">Player user ID</label>
                <input
                  id="blacklist-user-id"
                  autoComplete="off"
                  placeholder="Player UUID"
                  value={newUserId}
                  onChange={(event) => setNewUserId(event.target.value)}
                  required
                />
              </div>
              <div className={styles.field}>
                <label htmlFor="blacklist-reason">Reason</label>
                <input
                  id="blacklist-reason"
                  placeholder="Document the control decision"
                  value={newReason}
                  onChange={(event) => setNewReason(event.target.value)}
                  required
                />
              </div>
              <div className={styles.field}>
                <label htmlFor="blacklist-expiry">Expiry date (optional)</label>
                <input
                  id="blacklist-expiry"
                  type="date"
                  value={newExpiry}
                  onChange={(event) => setNewExpiry(event.target.value)}
                />
              </div>
            </div>
            <div className={styles.formActions}>
              <button
                className={styles.dangerButton}
                type="submit"
                disabled={adding || !newUserId.trim() || !newReason.trim()}
              >
                {adding ? 'Applying exclusion…' : 'Apply exclusion'}
              </button>
              <button className={styles.secondaryButton} type="button" onClick={resetForm}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {!loadFailed && (
          <section className={styles.ledger} aria-labelledby="blacklist-ledger-title">
            <div className={styles.panelHeader}>
              <div>
                <p className={styles.kicker}>Live club control</p>
                <h2 id="blacklist-ledger-title">Exclusion ledger</h2>
              </div>
              <span>{entries.length} total</span>
            </div>

            {loading ? (
              <div className={styles.state} aria-live="polite">
                Loading exclusion records…
              </div>
            ) : entries.length === 0 ? (
              <div className={styles.state}>
                <strong>No club exclusions</strong>
                <p>Players with an active or historical exclusion will appear in this ledger.</p>
              </div>
            ) : (
              <div
                className={styles.tableScroll}
                tabIndex={0}
                aria-label="Scrollable exclusion ledger"
              >
                <table>
                  <caption className={styles.srOnly}>Club player exclusion records</caption>
                  <thead>
                    <tr>
                      <th scope="col">Player ID</th>
                      <th scope="col">Reason</th>
                      <th scope="col">Applied</th>
                      <th scope="col">Expires</th>
                      <th scope="col">Status</th>
                      <th scope="col">Control</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((entry) => {
                      const expired = isExpired(entry);
                      const confirming = confirmingRemoval === entry.id;
                      return (
                        <tr key={entry.id}>
                          <td data-label="Player ID">
                            <code>{entry.user_id}</code>
                          </td>
                          <td data-label="Reason">{entry.reason}</td>
                          <td data-label="Applied">{formatDate(entry.banned_at)}</td>
                          <td data-label="Expires">
                            {entry.expires_at ? formatDate(entry.expires_at) : 'Permanent'}
                          </td>
                          <td data-label="Status">
                            <span className={expired ? styles.expiredBadge : styles.activeBadge}>
                              {expired ? 'Expired' : 'Active'}
                            </span>
                          </td>
                          <td data-label="Control">
                            {confirming ? (
                              <div className={styles.confirmActions}>
                                <button
                                  className={styles.dangerButton}
                                  type="button"
                                  onClick={() => void handleRemove(entry.id)}
                                  disabled={removing === entry.id}
                                >
                                  {removing === entry.id ? 'Removing…' : 'Confirm'}
                                </button>
                                <button
                                  className={styles.secondaryButton}
                                  type="button"
                                  onClick={() => setConfirmingRemoval(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                className={styles.removeButton}
                                type="button"
                                onClick={() => setConfirmingRemoval(entry.id)}
                              >
                                Remove access control
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
