/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  PLAYER SESSIONS PAGE — Club Players Operations
 * Ported from World Hub players.js → Club Arena TypeScript
 *
 * Tabs (4): Members, Sessions, Retention, Chip Flow
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { WalletService } from '../services/WalletService';
import { retryFetch } from '../utils/retryFetch';
import { exportToCSV } from '../lib/export';
import './AdminDashboardPage.css'; // reuse admin styles
import { useIsMounted } from '../hooks/useIsMounted';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { fmt, fmtChips, timeAgo } from '../utils/format';
import { reportError } from '../utils/errorReporter';
import { EmptyState } from '../components/common/EmptyState';

import { safeErrorMessage } from '../utils/safeErrorMessage';
interface PlayerSession {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  status: 'online' | 'idle' | 'away' | 'offline';
  role: string;
  chipBalance: number;
  lastActive?: string;
  txCount24h: number;
  volume24h: number;
  is_active?: boolean;
}

interface PlayerNote {
  player_type: string;
  color_label: string;
  notes: string;
}

type PlayersTab = 'members' | 'sessions' | 'retention' | 'chipflow';

// ── PlayerSessions Types ─────────────────────────────────────
interface MemberRow {
  user_id: string;
  role: string;
  is_active?: boolean;
  chip_balance: number;
  created_at: string;
}
interface ProfileRow {
  id: string;
  username?: string;
  display_name?: string;
  avatar_url?: string;
  last_seen?: string;
}
interface ActiveTable {
  id: string;
  name: string;
  current_players: number;
  max_players: number;
  status: string;
}
interface NoteRow {
  target_user_id: string;
  player_type: string;
  color_label: string;
  notes: string;
}
interface RetentionPlayer {
  userId: string;
  name: string;
  chipBalance: number;
  daysSinceActive: number;
}
interface ChipFlowEntry {
  userId: string;
  name: string;
  in: number;
  out: number;
  net: number;
}
interface ChipTxRow {
  from_user_id: string | null;
  to_user_id: string | null;
  amount: number;
  transaction_type: string;
  created_at: string;
}
interface RetentionMemberRow {
  user_id: string;
  chip_balance: number;
  created_at: string;
}
interface SessionSummary {
  totalMembers: number;
  online: number;
  idle: number;
  activeTables: number;
  totalSeated: number;
}

export default function PlayerSessionsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuthUser();

  const [tab, setTab] = useState<PlayersTab>('members');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [clubId, setClubId] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  // Members / Sessions state
  const [sessions, setSessions] = useState<PlayerSession[]>([]);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [tables, setTables] = useState<ActiveTable[]>([]);

  // Retention state
  const [retention, setRetention] = useState<{
    summary: { total: number; active: number; atRisk: number; churned: number };
    atRisk: RetentionPlayer[];
    churned: RetentionPlayer[];
  } | null>(null);
  const [retentionLoaded, setRetentionLoaded] = useState(false);

  // Chip Flow state
  const [chipFlow, setChipFlow] = useState<Record<
    string,
    { in: number; out: number; net: number }
  > | null>(null);
  const [chipFlowLoaded, setChipFlowLoaded] = useState(false);

  // Search / Filter
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('all');

  // Welcome-back modal
  const [wbTarget, setWbTarget] = useState<RetentionPlayer | null>(null);
  const [wbAmount, setWbAmount] = useState('');

  // Player Notes
  const [notes, setNotes] = useState<Record<string, PlayerNote>>({});
  const [notesLoaded, setNotesLoaded] = useState(false);
  const [noteTarget, setNoteTarget] = useState<PlayerSession | null>(null);
  const [noteData, setNoteData] = useState<PlayerNote>({
    player_type: 'unknown',
    color_label: 'none',
    notes: '',
  });
  const [savingNote, setSavingNote] = useState(false);

  const mountedRef = useIsMounted();

  // Auto-clear success
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 4000);
    return () => clearTimeout(t);
  }, [success]);

  // ── Cache Invalidation on Club Change ──────────────────────
  useEffect(() => {
    setRetentionLoaded(false);
    setChipFlowLoaded(false);
    setNotesLoaded(false);
    setRetention(null);
    setChipFlow({});
    setNotes({});
  }, [clubId]);

  const loadingRef = useRef(false);

  // ── Load Sessions (Primary Data) ──────────────────────────
  const loadSessions = useCallback(
    async (cId: string | null, silent = false) => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      try {
        if (!silent) {
          setLoading(true);
          setError(null);
        }
        const targetClubId = cId || clubId;
        if (!targetClubId) {
          setError('No club selected.');
          setLoading(false);
          return;
        }

        const uuid = await resolveClubUUID(targetClubId);

        // Load members with basic info
        const { data: members, error: memErr } = await retryFetch(
          () =>
            supabase
              .from('club_members')
              .select('user_id, role, is_active, chip_balance, created_at')
              .eq('club_id', uuid)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: mountedRef }
        );
        if (memErr) throw memErr;

        // Get profiles for display names
        const userIds = (members || []).map((m: MemberRow) => m.user_id).filter(Boolean);
        const profileMap: Record<string, ProfileRow> = {};
        if (userIds.length > 0) {
          const { data: profiles } = await retryFetch(
            () =>
              supabase
                .from('profiles')
                .select('id, username, display_name, avatar_url:arena_avatar_url, last_seen')
                .in('id', userIds)
                .then((r) => r),
            { maxRetries: 2, isMountedRef: mountedRef }
          );
          if (profiles) {
            profiles.forEach((p: ProfileRow) => {
              profileMap[p.id] = p;
            });
          }
        }

        // Get active tables
        const { data: activeTables } = await retryFetch(
          () =>
            supabase
              .from('tables')
              .select('id, name, current_players, max_players, status')
              .eq('club_id', uuid)
              .eq('status', 'active')
              .then((r) => r),
          { maxRetries: 2, isMountedRef: mountedRef }
        );

        if (!mountedRef.current) return;

        const now = Date.now();
        const sessionData: PlayerSession[] = (members || []).map((m: MemberRow) => {
          const profile = profileMap[m.user_id] || {};
          const lastSeen = profile.last_seen ? new Date(profile.last_seen).getTime() : 0;
          const minutesSince = lastSeen ? (now - lastSeen) / 60000 : 99999;
          let status: PlayerSession['status'] = 'offline';
          if (minutesSince < 5) status = 'online';
          else if (minutesSince < 30) status = 'idle';
          else if (minutesSince < 60) status = 'away';

          return {
            userId: m.user_id,
            displayName:
              profile.display_name || profile.username || m.user_id?.substring(0, 8) || 'Unknown',
            avatarUrl: profile.avatar_url,
            status,
            role: m.role || 'player',
            chipBalance: m.chip_balance || 0,
            lastActive: profile.last_seen || m.created_at,
            txCount24h: 0,
            volume24h: 0,
            is_active: m.is_active,
          };
        });

        // Sort: online first, then by last active
        sessionData.sort((a, b) => {
          const order = { online: 0, idle: 1, away: 2, offline: 3 };
          return (order[a.status] || 3) - (order[b.status] || 3);
        });

        setSessions(sessionData);
        setTables(activeTables || []);
        setSummary({
          totalMembers: sessionData.length,
          online: sessionData.filter((s) => s.status === 'online').length,
          idle: sessionData.filter((s) => s.status === 'idle').length,
          activeTables: (activeTables || []).length,
          totalSeated: (activeTables || []).reduce(
            (sum: number, t: ActiveTable) => sum + (t.current_players || 0),
            0
          ),
        });

        // Load notes in background
        if (!notesLoaded && userIds.length > 0) {
          try {
            const { data: notesData } = await supabase
              .from('player_notes')
              .select('target_user_id, player_type, color_label, notes')
              .eq('user_id', user?.id)
              .in('target_user_id', userIds);
            if (mountedRef.current && notesData) {
              const noteMap: Record<string, PlayerNote> = {};
              notesData.forEach((n: NoteRow) => {
                noteMap[n.target_user_id] = {
                  player_type: n.player_type || 'unknown',
                  color_label: n.color_label || 'none',
                  notes: n.notes || '',
                };
              });
              setNotes(noteMap);
              setNotesLoaded(true);
            }
          } catch (err) {
            console.warn('[PlayerSessions] Notes load skipped:', err);
            if (mountedRef.current) setNotesLoaded(true);
          }
        }
      } catch (err: any) {
        if (mountedRef.current) setError(safeErrorMessage(err));
      } finally {
        loadingRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    },
    [clubId, notesLoaded]
  );

  // ── Load Retention (Lazy) ─────────────────────────────────
  const loadRetention = useCallback(
    async (force = false) => {
      if (!force && retentionLoaded) return;
      if (!clubId) return;
      try {
        const uuid = await resolveClubUUID(clubId);
        const { data: members } = await retryFetch(
          () =>
            supabase
              .from('club_members')
              .select('user_id, chip_balance, created_at')
              .eq('club_id', uuid)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: mountedRef }
        );

        const userIds = (members || []).map((m: RetentionMemberRow) => m.user_id).filter(Boolean);
        const profileMap: Record<string, ProfileRow> = {};
        if (userIds.length > 0) {
          const { data: profiles } = await retryFetch(
            () =>
              supabase
                .from('profiles')
                .select('id, display_name, username, last_seen')
                .in('id', userIds)
                .then((r) => r),
            { maxRetries: 2, isMountedRef: mountedRef }
          );
          if (profiles)
            profiles.forEach((p: ProfileRow) => {
              profileMap[p.id] = p;
            });
        }

        if (!mountedRef.current) return;

        const now = Date.now();
        const atRisk: RetentionPlayer[] = [];
        const churned: RetentionPlayer[] = [];
        let active = 0;

        (members || []).forEach((m: RetentionMemberRow) => {
          const profile = profileMap[m.user_id] || {};
          const lastSeen = profile.last_seen ? new Date(profile.last_seen).getTime() : 0;
          const daysSince = lastSeen ? Math.floor((now - lastSeen) / 86400000) : 999;

          const playerInfo = {
            userId: m.user_id,
            name: profile.display_name || profile.username || m.user_id?.substring(0, 8),
            chipBalance: m.chip_balance || 0,
            daysSinceActive: daysSince,
          };

          if (daysSince <= 5) active++;
          else if (daysSince <= 14) atRisk.push(playerInfo);
          else churned.push(playerInfo);
        });

        setRetention({
          summary: {
            total: (members || []).length,
            active,
            atRisk: atRisk.length,
            churned: churned.length,
          },
          atRisk: atRisk.sort((a, b) => a.daysSinceActive - b.daysSinceActive),
          churned: churned.sort((a, b) => a.daysSinceActive - b.daysSinceActive),
        });
        setRetentionLoaded(true);
      } catch (err: any) {
        console.warn('[Players] Retention scan failed:', err.message);
      }
    },
    [clubId, retentionLoaded]
  );

  // ── Load Chip Flow (Lazy) ─────────────────────────────────
  const loadChipFlow = useCallback(async () => {
    if (chipFlowLoaded || !clubId) return;
    try {
      const uuid = await resolveClubUUID(clubId);
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();

      const { data: txns } = await retryFetch(
        () =>
          supabase
            .from('chip_transactions')
            .select('from_user_id, to_user_id, amount, transaction_type, created_at')
            .eq('club_id', uuid)
            .gte('created_at', sevenDaysAgo)
            .then((r) => r),
        { maxRetries: 2, isMountedRef: mountedRef }
      );

      if (!mountedRef.current) return;

      // chip_transactions has from_user_id (chips left) + to_user_id (chips received),
      // not a single user_id. Attribute the recipient's "in" and the sender's "out".
      const flow: Record<string, { in: number; out: number; net: number }> = {};
      const ensure = (uid: string) => {
        if (!flow[uid]) flow[uid] = { in: 0, out: 0, net: 0 };
      };
      (txns || []).forEach((t: ChipTxRow) => {
        const amt = Math.abs(t.amount || 0);
        if (t.to_user_id) {
          ensure(t.to_user_id);
          flow[t.to_user_id].in += amt;
          flow[t.to_user_id].net += amt;
        }
        if (t.from_user_id) {
          ensure(t.from_user_id);
          flow[t.from_user_id].out += amt;
          flow[t.from_user_id].net -= amt;
        }
      });

      setChipFlow(flow);
      setChipFlowLoaded(true);
    } catch (err: any) {
      console.warn('[Players] Chip flow failed:', err.message);
    }
  }, [clubId, chipFlowLoaded]);

  // ── Initial Load ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      if (!user?.id) return;
      const qClub = searchParams.get('club') || searchParams.get('clubId');
      let targetClub = qClub;

      if (!targetClub) {
        const { data: mems } = await supabase
          .from('club_members')
          .select('club_id, role')
          .eq('user_id', user.id)
          .in('role', ['owner', 'co_owner', 'admin', 'manager', 'super_agent', 'agent']);
        if (mems && mems.length > 0) targetClub = mems[0].club_id;
      }

      if (targetClub && !cancelled) {
        setClubId(targetClub);
        loadSessions(targetClub);
      } else if (!cancelled) {
        setError('No club found or selected.');
        setLoading(false);
      }
    };

    init();
    return () => {
      cancelled = true;
    };
  }, [user?.id, searchParams, loadSessions]);

  // ── Lazy Tab Loading ───────────────────────────────────────
  useEffect(() => {
    if (tab === 'retention') loadRetention();
    if (tab === 'chipflow') loadChipFlow();
  }, [tab, loadRetention, loadChipFlow]);

  // ── Bus Listeners (debounced) ──────────────────────────────
  useEffect(() => {
    if (!clubId) return;
    const refresh = () => loadSessions(clubId, true);
    const unsubs = [
      masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', refresh, 500),
      // PLAYER_JOINED removed 2026-08-28: nothing emits it as a BUS event —
      // RoomService's 'PLAYER_JOINED' is a room MESSAGE type, a name
      // collision that made this look wired. It never fired.
      masterBus.subscribeDebounced('CASHOUT_APPROVED', refresh, 500),
      masterBus.subscribeDebounced('CASHOUT_REQUESTED', refresh, 500),
    ];
    return () => unsubs.forEach((u) => u());
  }, [clubId, loadSessions]);

  // ── Supabase Realtime — cross-user WebSocket updates ──
  useEffect(() => {
    if (!clubId) return;
    let isMounted = true;
    const channelKey = `player-sessions-${clubId}`;

    const setupRealtime = async () => {
      const resolvedId = await resolveClubUUID(clubId);
      if (!isMounted) return;

      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'club_members',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => loadSessions(clubId, true)
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'cashout_requests',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => loadSessions(clubId, true)
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'PlayerSessionsPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[PlayerSessionsPage] Realtime channel timed out');
          }
        });
    };

    setupRealtime().catch((e) => console.warn('[PlayerSessionsPage] Realtime setup failed:', e));

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId, loadSessions]);

  // ── Visibility Refresh — throttled to 30s minimum gap ──────
  useVisibilityRefresh(() => {
    if (clubId) loadSessions(clubId, true);
  });

  // ── Derived Data ───────────────────────────────────────────
  const filtered = useMemo(
    () =>
      sessions.filter((p) => {
        if (statusFilter !== 'all' && p.status !== statusFilter) return false;
        if (roleFilter !== 'all' && p.role !== roleFilter) return false;
        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          return (
            (p.displayName || '').toLowerCase().includes(q) ||
            (p.userId || '').toLowerCase().includes(q)
          );
        }
        return true;
      }),
    [sessions, statusFilter, roleFilter, searchQuery]
  );

  const retSummary = retention?.summary ?? { total: 0, active: 0, atRisk: 0, churned: 0 };
  const atRisk = retention?.atRisk || [];
  const churned = retention?.churned || [];

  const chipFlowEntries = useMemo(() => {
    if (!chipFlow) return [];
    const nameMap: Record<string, string> = {};
    sessions.forEach((p) => {
      nameMap[p.userId] = p.displayName;
    });
    return Object.entries(chipFlow)
      .map(([userId, flow]) => ({
        userId,
        name: nameMap[userId] || userId.substring(0, 8),
        ...flow,
      }))
      .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  }, [chipFlow, sessions]);

  // ── Welcome Back Action ────────────────────────────────────
  const sendWelcomeBack = async () => {
    if (!wbTarget || !clubId) return;
    setProcessing(true);
    setError(null);
    try {
      const amt = parseInt(wbAmount, 10) || 500;
      // Resolve agent PK — distributePromo expects agents.id, NOT auth.users.id
      const resolvedClub = await resolveClubUUID(clubId);
      const { data: agentRow } = await supabase
        .from('agents')
        .select('id')
        .eq('user_id', user?.id || '')
        .eq('club_id', resolvedClub)
        .maybeSingle();
      if (!agentRow?.id) {
        setError('Agent record not found for this club');
        setProcessing(false);
        return;
      }
      await WalletService.distributePromo(agentRow.id, wbTarget.userId, amt);
      masterBus.emit('CHIPS_DISTRIBUTED', {
        clubId: resolvedClub,
        userId: wbTarget.userId,
        amount: amt,
      });
      setSuccess(`${fmtChips(amt)} welcome-back chips sent to ${wbTarget.name}!`);
      setWbTarget(null);
      setWbAmount('');
      loadRetention(true);
    } catch (err: any) {
      setError(safeErrorMessage(err));
    } finally {
      setProcessing(false);
    }
  };

  // ── Save Player Note ───────────────────────────────────────
  const saveNote = async () => {
    if (!noteTarget || !clubId || !user?.id) return;
    setSavingNote(true);
    try {
      const uuid = await resolveClubUUID(clubId);
      const { error: upsertErr } = await supabase.from('player_notes').upsert(
        {
          // club_id removed 2026-08-27: player_notes has no such column, so
          // naming it here rejected the whole upsert. My first pass corrected
          // only the conflict target and left the payload — the extended
          // write-payload gate caught that, which is exactly what it is for.
          target_user_id: noteTarget.userId,
          user_id: user?.id,
          player_type: noteData.player_type,
          color_label: noteData.color_label,
          notes: noteData.notes,
        },
        /* PHANTOM COLUMN FIX 2026-08-27: `player_notes` has no `club_id`
           column, so this upsert 400'd and Save Note could never succeed.
           The READ path at the top of this page is already club-agnostic —
           a note is per (author, subject), which is what the conflict target
           says now. */
        { onConflict: 'user_id,target_user_id' }
      );
      if (upsertErr) throw upsertErr;
      setNotes((prev) => ({ ...prev, [noteTarget.userId]: noteData }));
      masterBus.emit('PLAYER_NOTE_SAVED', { clubId: uuid, targetUserId: noteTarget.userId });
      setSuccess('Note saved!');
      setNoteTarget(null);
    } catch (err: any) {
      setError(safeErrorMessage(err));
    } finally {
      setSavingNote(false);
    }
  };

  // ── Loading State ──────────────────────────────────────────
  if (loading) {
    return (
      <div className="admin-page">
        <div className="admin-container">
          <div className="admin-skeleton" style={{ height: '48px', marginBottom: '16px' }} />
          <div style={{ display: 'flex', gap: '8px' }}>
            {[1, 2, 3].map((i) => (
              <div key={i} className="admin-skeleton" style={{ height: '36px', flex: 1 }} />
            ))}
          </div>
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="admin-skeleton" style={{ height: '52px', marginTop: '8px' }} />
          ))}
        </div>
      </div>
    );
  }

  if (!clubId) {
    return (
      <div className="admin-page">
        <EmptyState
          icon="CLUB"
          eyebrow="Operations Context Required"
          tone="permission"
          title="No Managed Club Is Available"
          description={
            error ||
            'Player sessions, retention, and chip flow are available to club operators from a club workspace.'
          }
          action={{ label: 'Return To Arena', onClick: () => navigate('/') }}
          secondaryAction={{ label: 'Find Clubs', onClick: () => navigate('/search') }}
        />
      </div>
    );
  }

  const statusColors: Record<string, string> = {
    online: '#31A24C',
    idle: '#F7C52A',
    away: '#4599FF',
    offline: '#6B7280',
  };
  const statusEmoji: Record<string, string> = {
    online: '●',
    idle: '●',
    away: '●',
    offline: '●',
  };

  return (
    <div className="admin-page">
      <div className="admin-container">
        {/* Banners */}
        {error && <div className="admin-error-banner">{error}</div>}
        {success && <div className="admin-success-banner">{success}</div>}

        {/* Welcome-Back Modal */}
        {wbTarget && (
          <div className="admin-modal-overlay" onClick={() => setWbTarget(null)}>
            <div
              className="admin-card"
              style={{ width: 'calc(100% - 32px)', maxWidth: '420px', margin: '60px auto' }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="admin-card-title">Send Welcome-Back Chips</h3>
              <p className="admin-text-secondary" style={{ marginBottom: '12px', lineHeight: 1.5 }}>
                Send Promo Chips To{' '}
                <strong style={{ color: 'var(--text-primary)' }}>{wbTarget.name}</strong> To
                Encourage Them To Return. They&apos;Ve Been Inactive For{' '}
                <strong style={{ color: '#F7C52A' }}>{wbTarget.daysSinceActive} Days</strong>.
              </p>
              <div style={{ marginBottom: '16px' }}>
                <label className="admin-label">Chip Amount</label>
                <input
                  className="admin-input"
                  type="number"
                  placeholder="500"
                  value={wbAmount}
                  onChange={(e) => setWbAmount(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button onClick={() => setWbTarget(null)} className="admin-btn admin-btn-ghost">
                  Cancel
                </button>
                <button
                  onClick={sendWelcomeBack}
                  className="admin-btn admin-btn-success"
                  disabled={processing}
                >
                  {processing ? 'Sending...' : 'Send Chips'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Player Note Modal */}
        {noteTarget && (
          <div className="admin-modal-overlay" onClick={() => !savingNote && setNoteTarget(null)}>
            <div
              className="admin-card"
              style={{ width: 'calc(100% - 32px)', maxWidth: '420px', margin: '60px auto' }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="admin-card-title">
                Note: {noteTarget.displayName || noteTarget.userId?.substring(0, 8)}
              </h3>
              <div style={{ marginBottom: '12px' }}>
                <label className="admin-label">Player Type</label>
                <select
                  className="admin-input"
                  value={noteData.player_type}
                  onChange={(e) => setNoteData((d) => ({ ...d, player_type: e.target.value }))}
                >
                  {['unknown', 'fish', 'reg', 'shark', 'whale', 'nit', 'lag', 'tag'].map((t) => (
                    <option key={t} value={t}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ marginBottom: '12px' }}>
                <label className="admin-label">Color Label</label>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  {[
                    ['none', '#6B7280'],
                    ['red', '#FA383E'],
                    ['orange', '#F5A623'],
                    ['yellow', '#F7C52A'],
                    ['green', '#31A24C'],
                    ['blue', '#4599FF'],
                    ['purple', '#C084FC'],
                  ].map(([c, hex]) => (
                    <button
                      key={c}
                      onClick={() => setNoteData((d) => ({ ...d, color_label: c }))}
                      style={{
                        width: '28px',
                        height: '28px',
                        borderRadius: '50%',
                        background: hex,
                        border:
                          noteData.color_label === c ? '3px solid #E4E6EB' : '2px solid #3A3B3C',
                        cursor: 'pointer',
                      }}
                    />
                  ))}
                </div>
              </div>
              <div style={{ marginBottom: '16px' }}>
                <label className="admin-label">Notes</label>
                <textarea
                  className="admin-input admin-textarea"
                  rows={4}
                  placeholder="Add Notes About This Player..."
                  value={noteData.notes}
                  onChange={(e) => setNoteData((d) => ({ ...d, notes: e.target.value }))}
                />
              </div>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button
                  onClick={() => setNoteTarget(null)}
                  className="admin-btn admin-btn-ghost"
                  disabled={savingNote}
                >
                  Cancel
                </button>
                <button
                  className="admin-btn admin-btn-primary"
                  disabled={savingNote}
                  onClick={saveNote}
                >
                  {savingNote ? 'Saving...' : 'Save Note'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="admin-page-header">
          <div className="admin-page-title">
            Players
            {summary && (
              <span
                style={{
                  fontSize: '14px',
                  color: 'var(--text-secondary)',
                  marginLeft: '12px',
                  fontWeight: 400,
                }}
              >
                {fmt(summary.totalMembers)} Members
              </span>
            )}
          </div>
          <div className="admin-header-actions">
            <button onClick={() => navigate('/')} className="admin-btn admin-btn-ghost">
              Lobby
            </button>
            <button onClick={() => loadSessions(clubId)} className="admin-btn admin-btn-ghost">
              ↻ Refresh
            </button>
          </div>
        </div>

        {/* Retention Alert Banner */}
        {retentionLoaded &&
          (retSummary.atRisk > 0 || retSummary.churned > 0) &&
          tab !== 'retention' && (
            <div
              className="admin-error-banner"
              style={{
                background: 'rgba(245,166,35,0.1)',
                borderColor: 'rgba(245,166,35,0.3)',
                color: '#F5A623',
                cursor: 'pointer',
                marginBottom: '16px',
              }}
              onClick={() => setTab('retention')}
            >
              <strong>{retSummary.atRisk + retSummary.churned}</strong> Player
              {retSummary.atRisk + retSummary.churned !== 1 ? 's' : ''} Need Attention -{' '}
              {retSummary.atRisk} At-Risk, {retSummary.churned} Churned
            </div>
          )}

        {/* Tabs */}
        <div className="admin-tabs">
          {[
            { id: 'members' as PlayersTab, label: 'Members', badge: summary?.totalMembers },
            { id: 'sessions' as PlayersTab, label: 'Sessions', badge: summary?.online },
            { id: 'retention' as PlayersTab, label: 'Retention' },
            { id: 'chipflow' as PlayersTab, label: 'Chip Flow' },
          ].map((t) => (
            <button
              key={t.id}
              className={`admin-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.badge ? (
                <span
                  style={{
                    marginLeft: '6px',
                    background: 'rgba(69,153,255,0.15)',
                    padding: '2px 6px',
                    borderRadius: '8px',
                    fontSize: '11px',
                  }}
                >
                  {t.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {/* ══════ TAB: MEMBERS ══════ */}
        {tab === 'members' && (
          <div className="admin-tab-content">
            {/* Summary */}
            {summary && (
              <div className="admin-stats-grid" style={{ marginBottom: '16px' }}>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                    {fmt(summary.totalMembers)}
                  </div>
                  <div className="admin-stat-label">Total Members</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                    {fmt(summary.online)}
                  </div>
                  <div className="admin-stat-label">Online Now</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#F7C52A' }}>
                    {fmt(summary.idle)}
                  </div>
                  <div className="admin-stat-label">Idle</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                    {fmt(summary.activeTables)}
                  </div>
                  <div className="admin-stat-label">Active Tables</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value">{fmt(summary.totalSeated)}</div>
                  <div className="admin-stat-label">Players Seated</div>
                </div>
              </div>
            )}

            {/* Filters */}
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
              <input
                className="admin-input"
                style={{ flex: '1 1 200px' }}
                placeholder="Search By Name Or ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              <select
                className="admin-input"
                style={{ flex: '0 0 140px' }}
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
              >
                <option value="all">All Status</option>
                <option value="online">Online</option>
                <option value="idle">Idle</option>
                <option value="away">Away</option>
                <option value="offline">Offline</option>
              </select>
              <select
                className="admin-input"
                style={{ flex: '0 0 140px' }}
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value)}
              >
                <option value="all">All Roles</option>
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="super_agent">Super Agent</option>
                <option value="agent">Agent</option>
                <option value="player">Player</option>
              </select>
              {filtered.length > 0 && (
                <button
                  className="admin-input"
                  style={{
                    flex: '0 0 120px',
                    cursor: 'pointer',
                    background: 'rgba(0,200,83,0.12)',
                    color: '#00C853',
                    border: '1px solid rgba(0,200,83,0.3)',
                    textAlign: 'center',
                    fontWeight: 600,
                    fontSize: '13px',
                  }}
                  onClick={() => {
                    try {
                      exportToCSV(filtered, 'player_sessions.csv', [
                        { key: 'displayName', label: 'Name' },
                        { key: 'userId', label: 'User ID' },
                        { key: 'role', label: 'Role' },
                        { key: 'status', label: 'Status' },
                        { key: 'chipBalance', label: 'Chip Balance' },
                        { key: 'txCount24h', label: 'Txns (24h)' },
                        { key: 'volume24h', label: 'Volume (24h)' },
                        { key: 'lastActive', label: 'Last Active' },
                      ]);
                    } catch (e) {
                      reportError(e, 'PlayerSessionsPage');
                      /* silent */
                    }
                  }}
                >
                  ⬇ Export CSV
                </button>
              )}
            </div>

            {/* Member Cards */}
            {filtered.length === 0 ? (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">◉</span>
                <span>
                  {searchQuery || statusFilter !== 'all'
                    ? 'No players match your filters'
                    : 'No members found'}
                </span>
              </div>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                  gap: '12px',
                }}
              >
                {filtered.map((p) => (
                  <div key={p.userId} className="admin-card" style={{ padding: '14px 16px' }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '8px',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {p.avatarUrl ? (
                          <img
                            src={p.avatarUrl}
                            alt=""
                            style={{
                              width: '32px',
                              height: '32px',
                              borderRadius: '50%',
                              border: `2px solid ${statusColors[p.status]}`,
                            }}
                          />
                        ) : (
                          <div
                            style={{
                              width: '32px',
                              height: '32px',
                              borderRadius: '50%',
                              background: '#3A3B3C',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '14px',
                              border: `2px solid ${statusColors[p.status]}`,
                            }}
                          >
                            {(p.displayName || '?')[0].toUpperCase()}
                          </div>
                        )}
                        <div>
                          <div style={{ fontWeight: 600, fontSize: '14px' }}>{p.displayName}</div>
                          <div style={{ fontSize: '11px', color: statusColors[p.status] }}>
                            {statusEmoji[p.status]} {p.status}
                          </div>
                        </div>
                      </div>
                      <span
                        className="admin-badge"
                        style={
                          p.role === 'agent' || p.role === 'super_agent'
                            ? { background: 'rgba(168,85,247,0.15)', color: '#C084FC' }
                            : undefined
                        }
                      >
                        {p.role}
                      </span>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        gap: '12px',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                        fontSize: '12px',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <span> {fmtChips(p.chipBalance)}</span>
                      <span> {timeAgo(p.lastActive)}</span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const existing = notes[p.userId];
                          setNoteData(
                            existing || { player_type: 'unknown', color_label: 'none', notes: '' }
                          );
                          setNoteTarget(p);
                        }}
                        style={{
                          background: 'none',
                          border: 'none',
                          cursor: 'pointer',
                          padding: '2px 6px',
                          fontSize: '14px',
                          color: notes[p.userId] ? '#F7C52A' : '#6B7280',
                        }}
                        title={notes[p.userId] ? 'Edit Note' : 'Add Note'}
                      >
                        {notes[p.userId] ? '▤' : '✏'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ══════ TAB: SESSIONS ══════ */}
        {tab === 'sessions' && (
          <div className="admin-tab-content">
            {tables.length > 0 && (
              <div style={{ marginBottom: '16px' }}>
                <h3 className="admin-section-title">Active Tables ({tables.length})</h3>
                <div className="admin-stats-grid">
                  {tables.map((t) => (
                    <div key={t.id} className="admin-stat-card">
                      <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                        {t.current_players}/{t.max_players}
                      </div>
                      <div className="admin-stat-label">{t.name || 'Table'}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <h3 className="admin-section-title">Player Sessions</h3>
            {sessions.length === 0 ? (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">▦</span>
                <span>No Session Data Available</span>
              </div>
            ) : (
              <div className="admin-table-scroll">
                <table className="admin-data-table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Player</th>
                      <th>Role</th>
                      <th>Chips</th>
                      <th>Last Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((p) => (
                      <tr key={p.userId}>
                        <td>
                          <span
                            style={{
                              display: 'inline-block',
                              width: '8px',
                              height: '8px',
                              borderRadius: '50%',
                              background: statusColors[p.status],
                              marginRight: '6px',
                              boxShadow:
                                p.status === 'online' ? '0 0 6px rgba(49,162,76,0.5)' : 'none',
                            }}
                          />
                          {p.status}
                        </td>
                        <td style={{ fontWeight: 600 }}>{p.displayName}</td>
                        <td>
                          <span
                            style={{
                              fontSize: '11px',
                              color: 'var(--text-secondary)',
                              textTransform: 'uppercase' as const,
                            }}
                          >
                            {p.role}
                          </span>
                        </td>
                        <td>{fmtChips(p.chipBalance)}</td>
                        <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                          {timeAgo(p.lastActive)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ══════ TAB: RETENTION ══════ */}
        {tab === 'retention' && (
          <div className="admin-tab-content">
            {!retentionLoaded ? (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">◷</span>
                <span>Scanning Player Activity...</span>
              </div>
            ) : (
              <>
                <div className="admin-stats-grid" style={{ marginBottom: '16px' }}>
                  <div className="admin-stat-card">
                    <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                      {fmt(retSummary.total)}
                    </div>
                    <div className="admin-stat-label">Total</div>
                  </div>
                  <div className="admin-stat-card">
                    <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                      {fmt(retSummary.active)}
                    </div>
                    <div className="admin-stat-label">Active</div>
                  </div>
                  <div className="admin-stat-card">
                    <div className="admin-stat-value" style={{ color: '#F7C52A' }}>
                      {fmt(retSummary.atRisk)}
                    </div>
                    <div className="admin-stat-label">At-Risk</div>
                  </div>
                  <div className="admin-stat-card">
                    <div className="admin-stat-value" style={{ color: '#FA383E' }}>
                      {fmt(retSummary.churned)}
                    </div>
                    <div className="admin-stat-label">Churned</div>
                  </div>
                </div>

                {atRisk.length > 0 && (
                  <div style={{ marginBottom: '24px' }}>
                    <h3 className="admin-section-title">⚠ At-Risk Players ({atRisk.length})</h3>
                    <div
                      className="admin-text-secondary"
                      style={{ marginBottom: '8px', fontSize: '12px' }}
                    >
                      Inactive For 5-14 Days - Reach Out Before They Churn
                    </div>
                    <div className="admin-table-scroll">
                      <table className="admin-data-table">
                        <thead>
                          <tr>
                            <th>Player</th>
                            <th>Chips</th>
                            <th>Days Inactive</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {atRisk.map((p) => (
                            <tr key={p.userId}>
                              <td style={{ fontWeight: 600 }}>{p.name}</td>
                              <td>{fmtChips(p.chipBalance)}</td>
                              <td style={{ color: '#F7C52A', fontWeight: 600 }}>
                                {p.daysSinceActive}d
                              </td>
                              <td>
                                <button
                                  onClick={() => {
                                    setWbTarget(p);
                                    setWbAmount('500');
                                  }}
                                  className="admin-btn admin-btn-ghost admin-btn-sm"
                                  style={{ borderColor: '#F7C52A', color: '#F7C52A' }}
                                >
                                  Welcome Back
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {churned.length > 0 && (
                  <div style={{ marginBottom: '24px' }}>
                    <h3 className="admin-section-title"> Churned Players ({churned.length})</h3>
                    <div
                      className="admin-text-secondary"
                      style={{ marginBottom: '8px', fontSize: '12px' }}
                    >
                      Inactive For 14+ Days
                    </div>
                    <div className="admin-table-scroll">
                      <table className="admin-data-table">
                        <thead>
                          <tr>
                            <th>Player</th>
                            <th>Chips</th>
                            <th>Days Inactive</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {churned.map((p) => (
                            <tr key={p.userId}>
                              <td style={{ fontWeight: 600 }}>{p.name}</td>
                              <td>{fmtChips(p.chipBalance)}</td>
                              <td style={{ color: '#FA383E', fontWeight: 600 }}>
                                {p.daysSinceActive}d
                              </td>
                              <td>
                                <button
                                  onClick={() => {
                                    setWbTarget(p);
                                    setWbAmount('1000');
                                  }}
                                  className="admin-btn admin-btn-ghost admin-btn-sm"
                                  style={{ borderColor: '#F7C52A', color: '#F7C52A' }}
                                >
                                  Re-Engage
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {atRisk.length === 0 && churned.length === 0 && (
                  <div className="admin-empty-state">
                    <span className="admin-empty-icon">✓</span>
                    <span>All Players Are Actively Engaged!</span>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ══════ TAB: CHIP FLOW ══════ */}
        {tab === 'chipflow' && (
          <div className="admin-tab-content">
            {!chipFlowLoaded ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {[1, 2, 3, 4].map((i) => (
                  <div key={i} className="admin-skeleton" style={{ height: '50px' }} />
                ))}
              </div>
            ) : chipFlowEntries.length === 0 ? (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">→</span>
                <span>No Chip Flow Data For The Last 7 Days</span>
              </div>
            ) : (
              <>
                <div className="admin-stats-grid" style={{ marginBottom: '16px' }}>
                  <div className="admin-stat-card">
                    <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                      {fmtChips(
                        chipFlowEntries.reduce(
                          (sum: number, e: ChipFlowEntry) => sum + (e.in || 0),
                          0
                        )
                      )}
                    </div>
                    <div className="admin-stat-label">Total Inflow</div>
                  </div>
                  <div className="admin-stat-card">
                    <div className="admin-stat-value" style={{ color: '#FA383E' }}>
                      {fmtChips(
                        chipFlowEntries.reduce(
                          (sum: number, e: ChipFlowEntry) => sum + (e.out || 0),
                          0
                        )
                      )}
                    </div>
                    <div className="admin-stat-label">Total Outflow</div>
                  </div>
                  <div className="admin-stat-card">
                    <div
                      className="admin-stat-value"
                      style={{
                        color:
                          chipFlowEntries.reduce(
                            (sum: number, e: ChipFlowEntry) => sum + (e.net || 0),
                            0
                          ) >= 0
                            ? '#31A24C'
                            : '#FA383E',
                      }}
                    >
                      {fmtChips(
                        chipFlowEntries.reduce(
                          (sum: number, e: ChipFlowEntry) => sum + (e.net || 0),
                          0
                        )
                      )}
                    </div>
                    <div className="admin-stat-label">Net Flow</div>
                  </div>
                  <div className="admin-stat-card">
                    <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                      {fmt(chipFlowEntries.length)}
                    </div>
                    <div className="admin-stat-label">Active Players</div>
                  </div>
                </div>

                <h3 className="admin-section-title">7-Day Player Chip Flow</h3>
                <div className="admin-table-scroll">
                  <table className="admin-data-table">
                    <thead>
                      <tr>
                        <th>Player</th>
                        <th>Chips In</th>
                        <th>Chips Out</th>
                        <th>Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chipFlowEntries.map((e) => (
                        <tr key={e.userId}>
                          <td style={{ fontWeight: 600 }}>{e.name}</td>
                          <td style={{ color: '#31A24C' }}>+{fmtChips(e.in)}</td>
                          <td style={{ color: '#FA383E' }}>-{fmtChips(e.out)}</td>
                          <td
                            style={{
                              fontWeight: 700,
                              color: (e.net || 0) >= 0 ? '#31A24C' : '#FA383E',
                            }}
                          >
                            {(e.net || 0) >= 0 ? '+' : ''}
                            {fmtChips(e.net)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
