import { useCallback, useEffect, useRef, useState } from 'react';
import PlayerHistoryService, {
  type HistoryEntry,
  type HistoryKind,
  type HistoryPage,
} from '../../services/PlayerHistoryService';
import { useMasterBusBroadcastChannel } from '../../hooks/useMasterBusBroadcastChannel';
import { reportError } from '../../utils/errorReporter';
import { titleCase } from '../../utils/titleCase';
import './PlayerChangeHistory.css';

const KINDS: Record<HistoryKind, string> = {
  all: 'All Changes',
  roles: 'Roles',
  status: 'Status',
  notes: 'Notes',
  exports: 'Exports',
};
const ACTIONS: Record<string, string> = {
  set_member_role: 'Role Assigned',
  role_change: 'Role Changed',
  set_member_status: 'Status Assigned',
  member_status_change: 'Status Changed',
  depart_club_member: 'Member Departed',
  kick_member: 'Member Removed',
  member_left: 'Member Left',
  banned: 'Member Banned',
  unban_member: 'Member Unbanned',
  update_member_notes: 'Notes Updated',
  export_club_roster: 'Roster Exported',
};

function description(entry: HistoryEntry): string {
  const before = entry.before;
  const after = entry.after;
  if (entry.kind === 'roles')
    return `${before.role == null ? 'Not Recorded' : titleCase(String(before.role).replace(/_/g, ' '))} To ${after.role == null ? 'Not Recorded' : titleCase(String(after.role).replace(/_/g, ' '))}`;
  if (entry.kind === 'status')
    return `${before.status == null ? 'Not Recorded' : titleCase(String(before.status))} To ${after.status == null ? 'Not Recorded' : titleCase(String(after.status))}`;
  if (entry.kind === 'notes') {
    const noteState = (state: HistoryEntry['after'], field: 'nickname' | 'remark') =>
      `${state[`${field}_present`] ? 'Present' : 'Not Set'} (${Number(state[`${field}_length`]).toLocaleString()} Characters)`;
    return `Nickname: ${noteState(before, 'nickname')} To ${noteState(after, 'nickname')}. Remark: ${noteState(before, 'remark')} To ${noteState(after, 'remark')}. Note Text Is Not Stored In This History.`;
  }
  return `${Number(after.row_count).toLocaleString()} Rows. ${after.selected_only ? 'Selected Players' : 'All Matching Players'}. Filter: ${titleCase(String(after.filter ?? 'Not Recorded').replace(/_/g, ' '))}. Sort: ${titleCase(String(after.sort ?? 'Not Recorded').replace(/_/g, ' '))}. Search ${after.search_used ? 'Used' : 'Not Used'}.`;
}

type HistoryChannelOptions = Parameters<typeof useMasterBusBroadcastChannel>[0];
function HistoryChannel(options: HistoryChannelOptions) {
  useMasterBusBroadcastChannel(options);
  return null;
}

/** One scoped reader per disclosure. Persisted audit records remain authoritative. */
export default function PlayerChangeHistory({
  clubId,
  playerId,
  viewerId,
  enabled,
}: {
  clubId: string;
  playerId?: string;
  viewerId: string;
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<HistoryKind>('all');
  const [fromDraft, setFromDraft] = useState('');
  const [toDraft, setToDraft] = useState('');
  const [dates, setDates] = useState({ from: '', to: '' });
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ owner: string; page: HistoryPage } | null>(null);
  const [busyOwner, setBusyOwner] = useState<string | null>(null);
  const [error, setError] = useState<{ owner: string; message: string } | null>(null);
  const [updates, setUpdates] = useState(false);
  const [, setConnectionRevision] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const connectionScope = `${clubId}:${playerId ?? ''}:${viewerId}:${enabled}:${open}`;
  const connections = useRef({
    scope: connectionScope,
    joined: new Set<string>(),
    failed: new Set<string>(),
  });
  if (connections.current.scope !== connectionScope) {
    connections.current = {
      scope: connectionScope,
      joined: new Set<string>(),
      failed: new Set<string>(),
    };
  }
  const liveUnavailable = connections.current.failed.size > 0;
  const eventRevision = useRef(0);
  const identity = `${clubId}:${playerId ?? ''}:${viewerId}:${enabled}:${open}:${kind}:${dates.from}:${dates.to}:${revision}`;
  const ownership = useRef({ identity, epoch: 0 });
  if (ownership.current.identity !== identity) {
    ownership.current = { identity, epoch: ownership.current.epoch + 1 };
  }
  const owner = `${identity}:${ownership.current.epoch}`;
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const page = result?.owner === owner ? result.page : null;
  const busy = busyOwner === owner;
  const currentError = error?.owner === owner ? error.message : null;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controllerRef.current?.abort();
    };
  }, []);
  const load = useCallback(
    async (older?: HistoryPage) => {
      if (!enabled || !open) return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const current = () =>
        alive.current &&
        ownerRef.current === owner &&
        controllerRef.current === controller &&
        !controller.signal.aborted;
      const readEventRevision = eventRevision.current;
      setBusyOwner(owner);
      setError(null);
      try {
        const next = await PlayerHistoryService.getPlayerHistory(
          clubId,
          {
            playerId,
            kind,
            dateFrom: dates.from || undefined,
            dateTo: dates.to || undefined,
            cursor: older?.nextCursor ?? undefined,
          },
          controller.signal
        );
        if (!current()) return;
        const previous = older?.rows ?? [];
        const seen = new Set(previous.map((row) => row.id));
        setResult({
          owner,
          page: { ...next, rows: [...previous, ...next.rows.filter((row) => !seen.has(row.id))] },
        });
        if (!older) setUpdates(eventRevision.current !== readEventRevision);
      } catch (failure) {
        if (!current()) return;
        reportError(failure, 'PlayerChangeHistory.read');
        // An unreadable or denied read is never a verified empty history.
        setResult(null);
        setError({
          owner,
          message:
            'Change History Could Not Be Loaded. Access May Have Changed. Refresh To Check Again.',
        });
      } finally {
        if (current()) setBusyOwner(null);
      }
    },
    [clubId, playerId, enabled, open, owner, kind, dates.from, dates.to]
  );
  useEffect(() => {
    if (enabled && open) void load();
    else {
      controllerRef.current?.abort();
      setResult(null);
    }
    return () => controllerRef.current?.abort();
  }, [enabled, open, load]);

  const scopeIds = page?.scopeClubIds ?? [clubId];
  const connectionError = (scopeId: string) => {
    if (!alive.current || !enabled || !open || ownerRef.current !== owner) return;
    connections.current.failed.add(scopeId);
    setConnectionRevision((value) => value + 1);
  };
  const connectionStatus = (scopeId: string, status: string) => {
    if (
      !alive.current ||
      !enabled ||
      !open ||
      ownerRef.current !== owner ||
      status !== 'SUBSCRIBED'
    )
      return;
    if (connections.current.joined.has(scopeId)) setUpdates(true);
    connections.current.joined.add(scopeId);
    connections.current.failed.delete(scopeId);
    setConnectionRevision((value) => value + 1);
  };
  const channel: HistoryChannelOptions = {
    channelName: enabled && open ? `player-history:${scopeIds[0]}` : null,
    event: 'history_changed',
    private: true,
    enabled: enabled && open,
    onPayload: (payload) => {
      if (!alive.current || !enabled || !open || ownerRef.current !== owner) return;
      const row = (
        payload as { payload?: { club_id?: string; target_id?: string; action?: string } } | null
      )?.payload;
      if (
        !row ||
        typeof row.club_id !== 'string' ||
        typeof row.action !== 'string' ||
        !scopeIds.includes(row.club_id) ||
        !Object.prototype.hasOwnProperty.call(ACTIONS, String(row.action))
      )
        return;
      eventRevision.current += 1;
      if (row.target_id === viewerId && row.action !== 'export_club_roster') {
        controllerRef.current?.abort();
        setResult(null);
        setRevision((value) => value + 1);
      } else if (!playerId || row.target_id === playerId) setUpdates(true);
    },
    onSubscriptionError: () => connectionError(scopeIds[0]),
    onSubscriptionStatus: (status) => connectionStatus(scopeIds[0], status),
  };
  useMasterBusBroadcastChannel(channel);
  if (!enabled) return null;
  const invalidDates = !!(fromDraft && toDraft && fromDraft > toDraft);
  return (
    <details
      className="player-history"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{playerId ? 'Player Change History' : 'Club Player Change History'}</summary>
      {enabled &&
        open &&
        scopeIds
          .slice(1)
          .map((scopeId) => (
            <HistoryChannel
              key={scopeId}
              {...channel}
              channelName={`player-history:${scopeId}`}
              onSubscriptionError={() => connectionError(scopeId)}
              onSubscriptionStatus={(status) => connectionStatus(scopeId, status)}
            />
          ))}
      <div className="player-history__body">
        <p>
          Recorded Role, Status And Note Changes{!playerId && ', Plus Club Roster Exports'}. Newest
          First. Separate Audit Records May Describe The Same Change. Missing Records Are Not
          Reconstructed.
        </p>
        <div className="player-history__controls">
          <label>
            History Type
            <select
              aria-label="History Type"
              value={kind}
              onChange={(event) => setKind(event.target.value as HistoryKind)}
            >
              {Object.entries(KINDS)
                .filter(([key]) => !playerId || key !== 'exports')
                .map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
          <label>
            History From
            <input
              type="date"
              aria-label="History From"
              value={fromDraft}
              onChange={(event) => setFromDraft(event.target.value)}
            />
          </label>
          <label>
            History To
            <input
              type="date"
              aria-label="History To"
              value={toDraft}
              onChange={(event) => setToDraft(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={invalidDates}
            onClick={() => setDates({ from: fromDraft, to: toDraft })}
          >
            Apply Dates
          </button>
          <button type="button" disabled={busy} onClick={() => setRevision((value) => value + 1)}>
            Refresh History
          </button>
        </div>
        <p role="note">
          Displayed History: {dates.from || 'All Recorded Dates'}
          {dates.to ? ` To ${dates.to}` : ''}. Date Boundaries Are Inclusive UTC Calendar Days.
        </p>
        {(dates.from !== fromDraft || dates.to !== toDraft) && (
          <p role="status">Draft Dates Are Not Applied.</p>
        )}
        {invalidDates && <p role="alert">The From Date Must Not Be After The To Date.</p>}
        {updates && <p role="status">New Changes Are Available. Refresh History To Read Them.</p>}
        {liveUnavailable && (
          <p role="status">
            Live Changes Could Not Be Confirmed. Refresh History To Read The Latest Records.
          </p>
        )}
        {currentError ? (
          <p role="alert">{currentError}</p>
        ) : busy && !page ? (
          <p role="status">Loading Change History...</p>
        ) : page && page.rows.length === 0 ? (
          <p role="status">No Recorded Changes Match This Scope.</p>
        ) : (
          page && (
            <>
              <p role="status">
                {page.rows.length.toLocaleString()} Recorded Changes Loaded
                {page.hasMore ? '. Older Records Are Available.' : '.'}
              </p>
              <ol className="player-history__entries" aria-label="Recorded Changes">
                {page.rows.map((entry) => (
                  <li key={entry.id}>
                    <strong>{ACTIONS[entry.action] ?? 'Recorded Change'}</strong>
                    <time dateTime={entry.createdAt}>
                      {new Date(entry.createdAt)
                        .toISOString()
                        .replace('T', ' ')
                        .replace(/\.000Z$/, 'Z')
                        .replace('Z', ' UTC')}
                    </time>
                    <p>{description(entry)}</p>
                    <p>
                      By{' '}
                      {entry.actorName
                        ? titleCase(entry.actorName)
                        : entry.actorId
                          ? `Actor ${entry.actorId.slice(0, 8)}`
                          : 'Actor Not Recorded'}
                      {entry.actorRole ? ` (${titleCase(entry.actorRole.replace(/_/g, ' '))})` : ''}
                    </p>
                    {!playerId && entry.targetUserId && (
                      <p>Player {entry.targetUserId.slice(0, 8)}</p>
                    )}
                    <small>
                      Recorded Action: {titleCase(entry.action.replace(/_/g, ' '))}. Reference:{' '}
                      {entry.id}
                    </small>
                  </li>
                ))}
              </ol>
              {page.hasMore && (
                <button type="button" disabled={busy} onClick={() => void load(page)}>
                  {busy ? 'Loading Older Changes...' : 'Show Older Changes'}
                </button>
              )}
            </>
          )
        )}
      </div>
    </details>
  );
}
