/** Club access exclusion controls. Route: /clubs/:clubId/blacklist */

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import ClubIntegrityHeader from '../components/club/ClubIntegrityHeader';
import { useAuthUser } from '../hooks/useAuthUser';
import { supabase } from '../lib/supabase';
import type { BlacklistEntry } from '../types/club.types';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import { adminRemovePlayerFromClubTables } from '../services/IntegrityActionService';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import styles from './BlacklistManagerPage.module.css';

interface MemberOption {
  user_id: string;
  display_name: string;
  is_horse: boolean;
  status: string | null;
}

/** A seat this player still occupies in this club after being excluded. */
interface SeatedTable {
  table_id: string;
}

export default function BlacklistManagerPage() {
  const { clubId } = useParams<{ clubId: string }>();
  const { user } = useAuthUser();
  const [entries, setEntries] = useState<BlacklistEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  /* THE FORM USED TO TAKE A RAW UUID, TYPED BY HAND, WITH NO VALIDATION AND NO
     WAY TO SEE WHO IT BELONGED TO. An exclusion is a decision about a person;
     it is now made by picking that person out of this club's own roster. */
  const [memberSearch, setMemberSearch] = useState('');
  const [memberOptions, setMemberOptions] = useState<MemberOption[]>([]);
  const [searchingMembers, setSearchingMembers] = useState(false);
  const [selectedMember, setSelectedMember] = useState<MemberOption | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [seatedAfterExclusion, setSeatedAfterExclusion] = useState<{
    member: MemberOption;
    tables: SeatedTable[];
  } | null>(null);
  const [removingFromPlay, setRemovingFromPlay] = useState(false);
  const [clearingExpired, setClearingExpired] = useState(false);
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

  /* The ledger printed a bare uuid in its first column, which is not a person.
     One batched read gives every excluded player their name. */
  useEffect(() => {
    const ids = [...new Set(entries.map((entry) => entry.user_id).filter(Boolean))];
    const missing = ids.filter((id) => !(id in names));
    if (missing.length === 0) return;
    let cancelled = false;
    void (async () => {
      const { data, error: nameError } = await supabase
        .from('profiles')
        .select(`id, ${PLAYER_NAME_COLUMNS}`)
        .in('id', missing);
      if (cancelled || nameError || !data) return;
      setNames((current) => {
        const next = { ...current };
        for (const row of data) next[row.id] = playerDisplayName(row);
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [entries, names]);

  /* Search this club's own roster. 300ms of quiet before asking, and the last
     answer wins, so a fast typist does not paint a stale list. */
  const searchSeq = useRef(0);
  useEffect(() => {
    if (!showAddForm || !clubId) return;
    const term = memberSearch.trim();
    if (term.length < 2) {
      setMemberOptions([]);
      return;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      void (async () => {
        setSearchingMembers(true);
        try {
          const resolvedClubId = await resolveClubUUID(clubId);
          const { data, error: searchError } = await supabase.rpc('ca_club_members', {
            p_club_id: resolvedClubId,
            p_search: term,
            p_since: null,
            p_limit: 8,
            p_offset: 0,
            p_sort: 'name',
            p_role: null,
          });
          if (seq !== searchSeq.current) return;
          if (searchError) throw searchError;
          setMemberOptions((data || []) as MemberOption[]);
        } catch (searchFailure) {
          if (seq !== searchSeq.current) return;
          setMemberOptions([]);
          setError(safeErrorMessage(searchFailure, 'The member search could not be completed.'));
        } finally {
          if (seq === searchSeq.current) setSearchingMembers(false);
        }
      })();
    }, 300);
    return () => clearTimeout(timer);
  }, [clubId, memberSearch, showAddForm]);

  const expiredEntries = useMemo(
    () =>
      entries.filter(
        (entry) => Boolean(entry.expires_at) && new Date(entry.expires_at!) < new Date()
      ),
    [entries]
  );

  const resetForm = () => {
    setShowAddForm(false);
    setNewUserId('');
    setNewReason('');
    setNewExpiry('');
    setMemberSearch('');
    setMemberOptions([]);
    setSelectedMember(null);
  };

  /**
   * AN EXCLUSION DOES NOT EMPTY A SEAT. Every buy-in path checks the ledger, so
   * an excluded player cannot re-enter - but the one they are already sitting
   * in is untouched until they stand up. The operator was never told that.
   */
  const checkSeated = useCallback(async (member: MemberOption, resolvedClubId: string) => {
    const { data, error: seatError } = await supabase
      .from('table_seats')
      .select('table_id, tables!inner(club_id, status)')
      .eq('user_id', member.user_id)
      .is('left_at', null)
      .eq('tables.club_id', resolvedClubId);
    if (seatError || !data || data.length === 0) return;
    const tables = [
      ...new Map(
        (data as SeatedTable[]).map((row) => [row.table_id, { table_id: row.table_id }])
      ).values(),
    ];
    setSeatedAfterExclusion({ member, tables });
  }, []);

  const removeFromPlay = async () => {
    if (!seatedAfterExclusion) return;
    setRemovingFromPlay(true);
    setError(null);
    try {
      const outcome = await adminRemovePlayerFromClubTables(
        seatedAfterExclusion.tables.map((table) => table.table_id),
        seatedAfterExclusion.member.user_id,
        'Excluded from the club by an operator'
      );
      if (outcome.removed === 0) {
        throw new Error(outcome.firstError || 'The engine did not remove this player.');
      }
      setSeatedAfterExclusion(null);
    } catch (removeError) {
      setError(safeErrorMessage(removeError, 'The player could not be removed from play.'));
    } finally {
      setRemovingFromPlay(false);
    }
  };

  /**
   * Expired rows are honoured at the gate - every buy-in path checks
   * `expires_at` - but nothing has ever swept them, so they accumulate in the
   * ledger forever and the Active figure drifts away from the record. This is
   * the operator's broom.
   */
  const clearExpired = async () => {
    if (expiredEntries.length === 0) return;
    setClearingExpired(true);
    setError(null);
    try {
      const ids = expiredEntries.map((entry) => entry.id);
      /* `.select('id')` IS WHAT MAKES A REFUSAL VISIBLE. Under RLS a DELETE
         that matches no row returns 204 with `error` null, so this button
         reported nothing and appeared simply not to work. The row count is the
         only evidence the exclusions actually went. */
      const { data: cleared, error: deleteError } = await supabase
        .from('blacklists')
        .delete()
        .in('id', ids)
        .select('id');
      if (deleteError) throw deleteError;
      if (!cleared || cleared.length === 0) {
        throw new Error(
          'Those exclusions were not cleared - you may not have permission to remove them.'
        );
      }
      await loadEntries();
    } catch (clearError) {
      setError(safeErrorMessage(clearError, 'The expired exclusions could not be cleared.'));
    } finally {
      setClearingExpired(false);
    }
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
      const excluded = selectedMember;
      resetForm();
      await loadEntries();
      if (excluded) await checkSeated(excluded, resolvedClubId);
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
      /* THE WORST SHAPE ON THIS PAGE, BEFORE THIS CHANGE. A DELETE with no
         `.select()` returns 204 and no error when RLS matches nothing, and the
         line below then removed the row from local state - so the exclusion
         disappeared from the operator's screen while the player stayed excluded
         in the database, and the optimistic filter replaced the read that would
         have corrected it. The returned row is now the proof. */
      const { data: removed, error: deleteError } = await supabase
        .from('blacklists')
        .delete()
        .eq('id', entryId)
        .select('id');
      if (deleteError) throw deleteError;
      if (!removed || removed.length === 0) {
        throw new Error('That exclusion was not removed - you may not have permission to lift it.');
      }
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
        eyebrow="Access Control / Final Case State"
        title="Club Exclusion Control"
        description="Apply Deliberate, Auditable Club-Access Exclusions With A Stated Reason And An Optional Expiry."
        metrics={[
          { label: 'Active', value: activeCount, tone: activeCount ? 'risk' : 'neutral' },
          { label: 'Permanent', value: permanentCount },
          { label: 'Total Records', value: entries.length },
        ]}
        action={
          <button className={styles.addButton} type="button" onClick={() => setShowAddForm(true)}>
            Add Exclusion
          </button>
        }
      />

      <main className={styles.workspace}>
        <div className={styles.workspaceHeading}>
          <div>
            <p className={styles.kicker}>Controlled Access Ledger</p>
            <h2>Excluded Players</h2>
          </div>
          {clubId && <Link to={`/clubs/${clubId}/operations`}>Return To Operations</Link>}
        </div>

        {error && (
          <div className={styles.errorPanel} role="alert">
            <div>
              <strong>
                {loadFailed ? 'Exclusion Ledger Unavailable' : 'Control Action Incomplete'}
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
                <p className={styles.kicker}>New Control Record</p>
                <h2>Exclude A Player</h2>
              </div>
              <span>Reason Required</span>
            </div>
            <div className={styles.formGrid}>
              <div className={styles.field}>
                <label htmlFor="blacklist-member-search">Player</label>
                {selectedMember ? (
                  <div className={styles.selectedMember}>
                    <span>
                      {selectedMember.display_name}
                      {selectedMember.is_horse ? ' (Horse)' : ''}
                    </span>
                    <button
                      className={styles.secondaryButton}
                      type="button"
                      onClick={() => {
                        setSelectedMember(null);
                        setNewUserId('');
                        setMemberSearch('');
                      }}
                    >
                      Change
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      id="blacklist-member-search"
                      autoComplete="off"
                      placeholder="Search This Club's Roster By Name"
                      value={memberSearch}
                      onChange={(event) => setMemberSearch(event.target.value)}
                      aria-describedby="blacklist-member-help"
                    />
                    <p id="blacklist-member-help" className={styles.fieldHelp}>
                      {searchingMembers
                        ? 'Searching The Roster'
                        : memberSearch.trim().length < 2
                          ? 'Type At Least Two Characters'
                          : memberOptions.length === 0
                            ? 'No Member Of This Club Matches That Name'
                            : 'Choose The Player To Exclude'}
                    </p>
                    {memberOptions.length > 0 && (
                      <ul className={styles.memberOptions}>
                        {memberOptions.map((option) => (
                          <li key={option.user_id}>
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedMember(option);
                                setNewUserId(option.user_id);
                                setMemberOptions([]);
                              }}
                            >
                              <span>{option.display_name}</span>
                              {option.is_horse && <span className={styles.horseTag}>Horse</span>}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
              <div className={styles.field}>
                <label htmlFor="blacklist-reason">Reason</label>
                <input
                  id="blacklist-reason"
                  placeholder="Document The Control Decision"
                  value={newReason}
                  onChange={(event) => setNewReason(event.target.value)}
                  required
                />
              </div>
              <div className={styles.field}>
                <label htmlFor="blacklist-expiry">Expiry Date (Optional)</label>
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
                disabled={adding || !selectedMember || !newReason.trim()}
              >
                {adding ? 'Applying Exclusion…' : 'Apply Exclusion'}
              </button>
              <button className={styles.secondaryButton} type="button" onClick={resetForm}>
                Cancel
              </button>
            </div>
          </form>
        )}

        {seatedAfterExclusion && (
          <div className={styles.seatedPanel} role="alert">
            <div>
              <strong>
                {seatedAfterExclusion.member.display_name} Is Still Seated At{' '}
                {seatedAfterExclusion.tables.length} Table
                {seatedAfterExclusion.tables.length === 1 ? '' : 's'}
              </strong>
              <p>
                The Exclusion Stops Every Future Buy In, Rebuy And Tournament Entry. It Does Not
                Empty A Seat They Are Already In. Removing Them Now Cashes Their Stack Out To Their
                Club Wallet.
              </p>
            </div>
            <div className={styles.confirmActions}>
              <button
                className={styles.dangerButton}
                type="button"
                onClick={() => void removeFromPlay()}
                disabled={removingFromPlay}
              >
                {removingFromPlay ? 'Removing From Play…' : 'Remove From Play'}
              </button>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => setSeatedAfterExclusion(null)}
              >
                Leave Them Seated
              </button>
            </div>
          </div>
        )}

        {!loadFailed && (
          <section className={styles.ledger} aria-labelledby="blacklist-ledger-title">
            <div className={styles.panelHeader}>
              <div>
                <p className={styles.kicker}>Live Club Control</p>
                <h2 id="blacklist-ledger-title">Exclusion Ledger</h2>
              </div>
              <div className={styles.ledgerTools}>
                <span>{entries.length} Total</span>
                {expiredEntries.length > 0 && (
                  <button
                    className={styles.secondaryButton}
                    type="button"
                    onClick={() => void clearExpired()}
                    disabled={clearingExpired}
                  >
                    {clearingExpired
                      ? 'Clearing Expired…'
                      : `Clear ${expiredEntries.length} Expired`}
                  </button>
                )}
              </div>
            </div>

            {loading ? (
              <div className={styles.state} aria-live="polite">
                Loading Exclusion Records…
              </div>
            ) : entries.length === 0 ? (
              <div className={styles.state}>
                <strong>No Club Exclusions</strong>
                <p>Players With An Active Or Historical Exclusion Will Appear In This Ledger.</p>
              </div>
            ) : (
              <div
                className={styles.tableScroll}
                tabIndex={0}
                aria-label="Scrollable Exclusion Ledger"
              >
                <table>
                  <caption className={styles.srOnly}>Club Player Exclusion Records</caption>
                  <thead>
                    <tr>
                      <th scope="col">Player</th>
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
                          <td data-label="Player">
                            <span className={styles.playerCell}>
                              <strong>{names[entry.user_id] || 'Loading Name'}</strong>
                              <code>{entry.user_id.substring(0, 8)}</code>
                            </span>
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
                                Remove Access Control
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
