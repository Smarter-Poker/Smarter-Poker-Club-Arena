/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MEMBER MANAGEMENT - one member, everything about them
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-23. The Players tab used to open a bottom sheet with three buttons
 * in it. Tapping a row now opens this instead, because everything an owner or an
 * agent actually wants -- who carries this player, what they have generated, what
 * is in their wallets, who sits beneath them, and what role they should hold --
 * is a page's worth of information and was never going to fit in a sheet.
 *
 * WHAT IT IS BUILT ON. `ca_club_member_detail` and `ca_club_member_downline`,
 * both reached through services/ClubRosterService, which has already turned every
 * PostgREST `numeric` string into a number. Nothing on this page parses a number
 * a second time and nothing here talks to Supabase directly except the two writes
 * that belong to it: the nickname/remark update, and the role change.
 *
 * THE RANGE CONTROL (requirement 5). Overall, 7 Days, or a chosen span. Both date
 * fields are native `<input type="date">` - they are localised, keyboard
 * accessible and on iOS they open the system picker, none of which a hand-rolled
 * calendar grid gets for free. Changing the range re-asks the server; the stats
 * are computed in Postgres against hand_history, so there is nothing to filter
 * client-side even if we wanted to.
 *
 * PROMOTE AND DEMOTE. Ported verbatim in behaviour from the PlayerActionModal
 * that lived at the bottom of ClubMembersPage before the rebuild, comments and
 * all, because the reasoning behind the single write path is the load-bearing
 * part. It is a section of the page now rather than a sheet, but it still asks
 * the server what may be offered, still confirms, and still refuses to guess.
 *
 * A MEMBER WHO IS NOT IN THIS CLUB comes back from the RPC as an object with a
 * null identity and zero stats rather than an error. That renders as "Member Not
 * Found", not as a wall of zeroes that looks like a real, very unlucky player.
 *
 * Palette is ClubMembersPage's, to the token. No green, no purple. Positive
 * money is arena cyan, negative money is --danger-red, and those are the only two
 * colours that carry meaning here beyond the role badge.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { sizedStorageUrl, generateAvatarSvg } from '../utils/avatarGenerator';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import PageSkeleton from '../components/common/PageSkeleton';
import RoleBadge, { roleColor } from '../components/club/RoleBadge';
import ChipTransferModal from '../components/agent/ChipTransferModal';
import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import { toTitleCase } from '../utils/titleCase';
import { resolveClubUUID } from '../utils/clubIdResolver';
import {
  ROLE_DESCRIPTION,
  isAgentRole,
  isClubStaff,
  normaliseRole,
  roleLabel,
  roleRank,
  type ClubRole,
} from '../types/clubRoles';
import ClubRosterService, {
  RANGE_OVERALL,
  lastDaysRange,
  isoDate,
  type MemberDetail,
  type MemberRange,
  type DownlineMember,
} from '../services/ClubRosterService';
import './MemberManagementPage.css';

/* ═══════════════════════════════════════════════════════════════════════════════
   FORMATTING
   ═══════════════════════════════════════════════════════════════════════════════ */

/** Counts. Never padStart, never a raw number in the DOM. */
function count(value: number): string {
  return (value ?? 0).toLocaleString();
}

/** Money and chips. Two decimals, always, so a column of them lines up. */
function money(value: number): string {
  return (value ?? 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Chips read as whole numbers unless they are not. */
function chips(value: number): string {
  return (value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleString();
}

/* ═══════════════════════════════════════════════════════════════════════════════
   THE RANGE CONTROL (requirement 5)
   ═══════════════════════════════════════════════════════════════════════════════ */

type RangeMode = 'overall' | 'week' | 'custom';

const RANGE_LABEL: Record<RangeMode, string> = {
  overall: 'Overall',
  week: '7 Days',
  custom: 'Select',
};

/** The downline list is capped so a 319-strong agent does not render 319 rows. */
const DOWNLINE_RENDER_CAP = 50;

/* ═══════════════════════════════════════════════════════════════════════════════
   PAGE
   ═══════════════════════════════════════════════════════════════════════════════ */

export default function MemberManagementPage() {
  const { clubId: routeClubId, userId: routeUserId } = useParams();
  const [searchParams] = useSearchParams();
  const clubId = routeClubId || searchParams.get('club') || undefined;
  const userId = routeUserId || undefined;

  const navigate = useNavigate();
  const toast = useToast();
  const { user } = useAuthUser();
  const isMountedRef = useIsMounted();

  const [resolvedClubId, setResolvedClubId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const [downline, setDownline] = useState<DownlineMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [myRole, setMyRole] = useState<ClubRole>('player');

  const [rangeMode, setRangeMode] = useState<RangeMode>('overall');
  const [customFrom, setCustomFrom] = useState<string>(() => isoDate(new Date()));
  const [customTo, setCustomTo] = useState<string>(() => isoDate(new Date()));
  const [range, setRange] = useState<MemberRange>(RANGE_OVERALL);

  /* ── Load ───────────────────────────────────────────────────────────────── */

  const loadDetail = useCallback(
    async (activeRange: MemberRange, getIsMounted?: () => boolean) => {
      if (!clubId || !userId) return;
      const live = () => (getIsMounted ? getIsMounted() : true) && isMountedRef.current;

      if (live()) {
        setLoading(true);
        setLoadError(false);
      }
      try {
        const resolved = await resolveClubUUID(clubId);
        if (!live()) return;
        if (!resolved) {
          setDetail(null);
          return;
        }
        setResolvedClubId(resolved);

        const [memberDetail, memberDownline] = await Promise.all([
          ClubRosterService.getMemberDetail(resolved, userId, activeRange),
          ClubRosterService.getDownline(resolved, userId),
        ]);
        if (!live()) return;
        setDetail(memberDetail);
        setDownline(memberDownline);

        // Whoever is reading decides what this page lets them do. One row, and
        // only for the viewer, so it costs a single indexed lookup.
        if (user?.id) {
          const { data: mine } = await supabase
            .from('club_members')
            .select('role')
            .eq('club_id', resolved)
            .eq('user_id', user.id)
            .maybeSingle();
          if (live() && mine) setMyRole(normaliseRole(mine.role));
        }
      } catch (error) {
        reportError(error, 'MemberManagementPage.loadDetail');
        if (live()) {
          setLoadError(true);
          toast.error('Failed To Load This Member');
        }
      } finally {
        if (live()) setLoading(false);
      }
    },
    [clubId, userId, user?.id, isMountedRef, toast]
  );

  useEffect(() => {
    let mounted = true;
    loadDetail(range, () => mounted);
    return () => {
      mounted = false;
    };
  }, [loadDetail, range]);

  const reload = useCallback(() => {
    void loadDetail(range);
  }, [loadDetail, range]);

  /* ── Range ──────────────────────────────────────────────────────────────── */

  const chooseRange = useCallback((mode: RangeMode) => {
    setRangeMode(mode);
    if (mode === 'overall') setRange(RANGE_OVERALL);
    if (mode === 'week') setRange(lastDaysRange(7));
    // 'custom' waits for Confirm: re-fetching on every keystroke of a date field
    // would fire three times before the year is finished being typed.
  }, []);

  const confirmCustomRange = useCallback(() => {
    if (!customFrom || !customTo) {
      toast.error('Choose Both A Start And An End Date');
      return;
    }
    if (customFrom > customTo) {
      toast.error('The Start Date Must Come Before The End Date');
      return;
    }
    setRange({ from: customFrom, to: customTo });
  }, [customFrom, customTo, toast]);

  /* ── Derived ────────────────────────────────────────────────────────────── */

  const identity = detail?.identity;
  const found = !!identity?.user_id;

  const shownDownline = downline.slice(0, DOWNLINE_RENDER_CAP);

  /* ── Render ─────────────────────────────────────────────────────────────── */

  if (loading && !detail) {
    return (
      <div className="member-mgmt-page">
        <PageHeader onBack={() => navigate(-1)} />
        <PageSkeleton variant="settings" />
      </div>
    );
  }

  if (loadError && !detail) {
    return (
      <div className="member-mgmt-page">
        <PageHeader onBack={() => navigate(-1)} />
        <div className="mm-empty" role="alert">
          <span className="mm-empty__mark" aria-hidden="true">
            ↻
          </span>
          <p className="mm-empty__heading">The Member Ledger Did Not Respond</p>
          <p className="mm-empty__body">
            Your Access Has Not Changed. Retry The Live Record Without Leaving This Page.
          </p>
          <button type="button" className="mm-empty__retry" onClick={reload}>
            Retry Member
          </button>
        </div>
      </div>
    );
  }

  if (!found) {
    return (
      <div className="member-mgmt-page">
        <PageHeader onBack={() => navigate(-1)} />
        <div className="mm-empty">
          <span className="mm-empty__mark" aria-hidden="true">
            ○
          </span>
          <p className="mm-empty__heading">Member Not Found</p>
          <p className="mm-empty__body">
            This Player Is Not A Member Of This Club, Or You Do Not Have Permission To View Them.
          </p>
        </div>
      </div>
    );
  }

  const stats = detail!.stats;
  const wallets = detail!.wallets;
  const counts = detail!.downline;
  const alias = identity!.alias || 'Unknown';
  const initial = alias[0]?.toUpperCase() ?? '?';

  return (
    <div className="member-mgmt-page">
      <PageHeader onBack={() => navigate(-1)} />

      {/* ── Identity ─────────────────────────────────────────────────────── */}

      <section className="mm-card mm-identity">
        <div className={`mm-avatar${detail!.presence.is_online ? ' mm-avatar--online' : ''}`}>
          {identity!.avatar_url ? (
            <img
              src={sizedStorageUrl(identity!.avatar_url!, 56)}
              alt=""
              loading="lazy"
              onError={(e) => {
                e.currentTarget.onerror = null;
                e.currentTarget.src = generateAvatarSvg(userId || 'member', identity!.alias || '?');
              }}
            />
          ) : (
            <span>{initial}</span>
          )}
        </div>

        <div className="mm-identity__main">
          <div className="mm-identity__line">
            <RoleBadge role={identity!.role} size="md" showLabel />
          </div>
          <span className="mm-alias">{alias}</span>
          {identity!.username && <span className="mm-username">{identity!.username}</span>}
        </div>

        {/* The player number is what one member gives another and what an agent
            is handed in a support ticket. Never invented: absent means absent. */}
        <span className="mm-player-id">
          {identity!.player_number ? `ID: ${identity!.player_number}` : 'ID: Not Assigned'}
        </span>
      </section>

      {/* ── Nickname and remark ──────────────────────────────────────────── */}

      {detail!.capabilities.can_view_notes && (
        <NotesEditor
          key={identity!.user_id!}
          clubId={resolvedClubId}
          userId={identity!.user_id!}
          initialNickname={identity!.nickname}
          initialRemark={identity!.remark}
          editable={detail!.capabilities.can_edit_notes}
        />
      )}

      {/* ── Provenance ───────────────────────────────────────────────────── */}

      <section className="mm-card mm-provenance">
        {detail!.capabilities.can_view_financials && (
          <InfoLine label="Last Login" value={formatTimestamp(identity!.last_login)} />
        )}
        <InfoLine label="Joined" value={formatTimestamp(identity!.joined_at)} />
        <InfoLine
          label="Upline Agent"
          value={
            identity!.upline_name
              ? identity!.upline_player_number
                ? `${identity!.upline_name} (ID: ${identity!.upline_player_number})`
                : identity!.upline_name
              : 'None'
          }
        />
        {identity!.home_club_name && (
          <InfoLine label="Home Club" value={identity!.home_club_name} />
        )}
      </section>

      {/* ── Range control (requirement 5) ────────────────────────────────── */}

      {stats && (
        <section className="mm-range">
          <div className="mm-range__tabs" role="group" aria-label="Statistics Date Range">
            {(Object.keys(RANGE_LABEL) as RangeMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={rangeMode === mode ? 'active' : ''}
                onClick={() => chooseRange(mode)}
              >
                {RANGE_LABEL[mode]}
              </button>
            ))}
          </div>

          {rangeMode === 'custom' && (
            <div className="mm-range__custom">
              <label className="mm-date">
                <span>From</span>
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || undefined}
                  onChange={(e) => setCustomFrom(e.target.value)}
                />
              </label>
              <label className="mm-date">
                <span>To</span>
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={(e) => setCustomTo(e.target.value)}
                />
              </label>
              <button type="button" className="mm-range__confirm" onClick={confirmCustomRange}>
                Confirm
              </button>
            </div>
          )}

          <p className="mm-range__caption">
            {detail!.range.is_overall
              ? 'Showing Lifetime Totals'
              : `Showing ${detail!.range.from ?? '?'} To ${detail!.range.to ?? '?'}`}
          </p>
        </section>
      )}

      {/* ── Stats ────────────────────────────────────────────────────────── */}

      {stats && (
        <section className="mm-card mm-stats">
          <h2 className="mm-card__title">Activity</h2>
          <StatRow label="Hands" value={count(stats.hands)} />
          <StatRow label="Total Fee" value={money(stats.total_fee)} />
          <StatRow label="MTT Fee" value={money(stats.mtt_fee)} />
          <StatRow label="Claimed Back" value={money(stats.claimed_back)} />
          <StatRow label="Sent Out" value={money(stats.sent_out)} />
          <StatRow
            label="Total Winnings"
            value={money(stats.total_winnings)}
            signed={stats.total_winnings}
          />
          <StatRow
            label="MTT Winnings"
            value={money(stats.mtt_winnings)}
            signed={stats.mtt_winnings}
          />
        </section>
      )}

      {/* ── Wallets ──────────────────────────────────────────────────────── */}

      {wallets && (
        <section className="mm-card mm-stats">
          <h2 className="mm-card__title">Wallets</h2>
          <StatRow label="Club Chips" value={chips(wallets.chip_balance)} />
          <StatRow label="Player Wallet" value={chips(wallets.player_wallet)} />
          <StatRow label="Agent Wallet" value={chips(wallets.agent_wallet)} />
          <StatRow label="Promo Wallet" value={chips(wallets.promo_wallet)} />
        </section>
      )}

      {/* ── Downline ─────────────────────────────────────────────────────── */}

      {counts && (
        <section className="mm-card mm-stats">
          <h2 className="mm-card__title">Downline</h2>
          <StatRow label="Downlines Direct" value={count(counts.downline_direct)} />
          <StatRow label="Downlines Total" value={count(counts.downline_total)} />

          {shownDownline.length > 0 && (
            <div className="mm-downline">
              {shownDownline.map((d) => (
                <div key={d.user_id} className="mm-downline__row">
                  <RoleBadge role={d.role} size="sm" />
                  <span className="mm-downline__names">
                    <span className="mm-downline__alias">{d.alias}</span>
                    {d.username && d.username.toLowerCase() !== d.alias.toLowerCase() && (
                      <span className="mm-downline__username">{d.username}</span>
                    )}
                  </span>
                  {d.player_number && (
                    <span className="mm-downline__number">No. {d.player_number}</span>
                  )}
                  <span className="mm-downline__fees">{money(d.total_fees)}</span>
                </div>
              ))}
              {downline.length > DOWNLINE_RENDER_CAP && (
                <p className="mm-downline__more">
                  Showing {count(shownDownline.length)} Of {count(downline.length)}
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {/* ── Role ─────────────────────────────────────────────────────────── */}

      {detail!.capabilities.can_manage_role && identity!.home_club_id && (
        <RoleSection
          clubId={clubId!}
          resolvedClubId={identity!.home_club_id}
          targetUserId={identity!.user_id!}
          targetName={alias}
          targetRole={identity!.role}
          myRole={myRole}
          onRoleChanged={reload}
        />
      )}

      {/* ── Navigation rows ──────────────────────────────────────────────── */}

      <nav className="mm-nav">
        {detail!.capabilities.can_view_financials && (
          <button
            type="button"
            className="mm-nav__row"
            onClick={() => navigate(`/clubs/${clubId}/promo-vault?player=${identity!.user_id}`)}
          >
            <span className="mm-nav__label">Promo Vault</span>
            <span className="mm-nav__chevron" aria-hidden="true">
              ›
            </span>
          </button>
        )}
        {detail!.capabilities.can_view_financials && (
          <button
            type="button"
            className="mm-nav__row"
            onClick={() => navigate(`/clubs/${clubId}/members/${identity!.user_id}/statistics`)}
          >
            <span className="mm-nav__label">Player Statistics</span>
            <span className="mm-nav__chevron" aria-hidden="true">
              ›
            </span>
          </button>
        )}
      </nav>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   HEADER
   ═══════════════════════════════════════════════════════════════════════════════ */

function PageHeader({ onBack }: { onBack: () => void }) {
  return (
    <header className="mm-header">
      <button type="button" className="mm-back" onClick={onBack} aria-label="Go Back">
        ‹
      </button>
      <h1 className="mm-title">Member Management</h1>
      {/* A spacer so the title is optically centred without absolute positioning,
          which would overlap the back button on a 320px screen. */}
      <span className="mm-header__spacer" aria-hidden="true" />
    </header>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   NICKNAME AND REMARK
   ═══════════════════════════════════════════════════════════════════════════════

   Saved on blur rather than on every keystroke: a remark is a sentence, and
   thirty writes per sentence is thirty chances for one of them to lose a race
   with the next.

   A FAILED SAVE NEVER DISCARDS WHAT WAS TYPED. The input keeps the user's text,
   the row is marked unsaved, and a toast says so - the alternative, snapping
   back to the last known server value, throws away the only copy of something
   somebody just wrote.
   ═══════════════════════════════════════════════════════════════════════════════ */

function NotesEditor({
  clubId,
  userId,
  initialNickname,
  initialRemark,
  editable,
}: {
  clubId: string | null;
  userId: string;
  initialNickname: string | null;
  initialRemark: string | null;
  editable: boolean;
}) {
  const toast = useToast();
  const isMountedRef = useIsMounted();

  const [nickname, setNickname] = useState(initialNickname ?? '');
  const [remark, setRemark] = useState(initialRemark ?? '');
  const [nicknameUnsaved, setNicknameUnsaved] = useState(false);
  const [remarkUnsaved, setRemarkUnsaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // The saved values, so a blur that changed nothing does not write anything.
  const savedRef = useRef({
    nickname: initialNickname ?? '',
    remark: initialRemark ?? '',
  });
  const draftRef = useRef({
    nickname: initialNickname ?? '',
    remark: initialRemark ?? '',
  });
  const savingRef = useRef(false);
  const queuedSaveRef = useRef(false);

  useEffect(() => {
    setNickname(initialNickname ?? '');
    setRemark(initialRemark ?? '');
    savedRef.current = { nickname: initialNickname ?? '', remark: initialRemark ?? '' };
    draftRef.current = { nickname: initialNickname ?? '', remark: initialRemark ?? '' };
    queuedSaveRef.current = false;
    setNicknameUnsaved(false);
    setRemarkUnsaved(false);
  }, [initialNickname, initialRemark, userId]);

  const save = useCallback(async () => {
    if (!clubId) return;
    if (savingRef.current) {
      queuedSaveRef.current = true;
      return;
    }
    const draft = { ...draftRef.current };
    if (savedRef.current.nickname === draft.nickname && savedRef.current.remark === draft.remark)
      return;

    savingRef.current = true;
    setSaving(true);
    try {
      const requestId =
        typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await ClubRosterService.updateMemberNotes(
        clubId,
        userId,
        draft.nickname,
        draft.remark,
        requestId
      );
      const persisted = {
        nickname: result.nickname ?? '',
        remark: result.remark ?? '',
      };
      savedRef.current = persisted;
      if (!isMountedRef.current) return;
      setNicknameUnsaved(draftRef.current.nickname !== persisted.nickname);
      setRemarkUnsaved(draftRef.current.remark !== persisted.remark);
      toast.success('Member Notes Saved');
    } catch (e) {
      reportError(e, 'MemberManagementPage.saveNotes');
      if (!isMountedRef.current) return;
      setNicknameUnsaved(savedRef.current.nickname !== draftRef.current.nickname);
      setRemarkUnsaved(savedRef.current.remark !== draftRef.current.remark);
      toast.error(safeErrorMessage(e, 'Could Not Save. Your Text Is Still Here'));
    } finally {
      savingRef.current = false;
      if (isMountedRef.current) setSaving(false);
      if (isMountedRef.current && queuedSaveRef.current) {
        queuedSaveRef.current = false;
        queueMicrotask(() => void save());
      }
    }
  }, [clubId, isMountedRef, toast, userId]);

  const discardDraft = useCallback(() => {
    const saved = savedRef.current;
    draftRef.current = { ...saved };
    setNickname(saved.nickname);
    setRemark(saved.remark);
    setNicknameUnsaved(false);
    setRemarkUnsaved(false);
  }, []);

  if (!editable) {
    return (
      <section className="mm-card mm-notes">
        <InfoLine label="Nickname" value={nickname || 'None'} />
        <InfoLine label="Remark" value={remark || 'None'} />
      </section>
    );
  }

  return (
    <section className="mm-card mm-notes">
      <label className="mm-field">
        <span className="mm-field__label">Nickname</span>
        <input
          type="text"
          value={nickname}
          maxLength={64}
          placeholder={toTitleCase('enter the nickname here...')}
          onChange={(e) => {
            setNickname(e.target.value);
            draftRef.current.nickname = e.target.value;
            setNicknameUnsaved(savedRef.current.nickname !== e.target.value);
          }}
          onBlur={() => void save()}
        />
        {nicknameUnsaved && <span className="mm-field__unsaved">Not Saved Yet</span>}
      </label>

      <label className="mm-field">
        <span className="mm-field__label">Remark</span>
        <input
          type="text"
          value={remark}
          maxLength={240}
          placeholder={toTitleCase('enter remark here...')}
          onChange={(e) => {
            setRemark(e.target.value);
            draftRef.current.remark = e.target.value;
            setRemarkUnsaved(savedRef.current.remark !== e.target.value);
          }}
          onBlur={() => void save()}
        />
        {remarkUnsaved && <span className="mm-field__unsaved">Not Saved Yet</span>}
      </label>

      <div className="mm-notes__actions">
        <span className="mm-notes__status" role="status" aria-live="polite">
          {saving
            ? 'Saving Through The Audited Club Ledger...'
            : nicknameUnsaved || remarkUnsaved
              ? 'Changes Are Still Local To This Device.'
              : 'Notes Match The Audited Club Record.'}
        </span>
        <button
          type="button"
          className="mm-notes__discard"
          onClick={discardDraft}
          disabled={saving || (!nicknameUnsaved && !remarkUnsaved)}
        >
          Revert
        </button>
        <button
          type="button"
          className="mm-notes__save"
          onClick={() => void save()}
          disabled={saving || (!nicknameUnsaved && !remarkUnsaved)}
        >
          {saving ? 'Saving...' : 'Save Notes'}
        </button>
      </div>
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   PROMOTE AND DEMOTE

   Ported from the PlayerActionModal that used to sit at the bottom of
   ClubMembersPage. The behaviour and the reasoning are unchanged; only the
   container is - it is a section of the page now, not a bottom sheet.
   ═══════════════════════════════════════════════════════════════════════════════ */

function RoleSection({
  clubId,
  resolvedClubId,
  targetUserId,
  targetName,
  targetRole,
  myRole,
  onRoleChanged,
}: {
  clubId: string;
  resolvedClubId: string;
  targetUserId: string;
  targetName: string;
  targetRole: ClubRole;
  myRole: ClubRole;
  onRoleChanged: () => void;
}) {
  const toast = useToast();
  const [promoting, setPromoting] = useState(false);
  const [confirmRole, setConfirmRole] = useState<ClubRole | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // Percentages, not fractions. Blank on purpose: a rate that arrives
  // pre-filled is a rate nobody chose, which is the bug this pair fixes.
  const [commissionPct, setCommissionPct] = useState('');
  const [rakebackPct, setRakebackPct] = useState('');
  // Prepaid or a credit line, and how much. Blank for the same reason the rates
  // are blank: Dan asked for the funding to be ASSIGNED at promotion, and a
  // default sitting in the box is not a choice anybody made. The server refuses
  // an agent role that arrives without one (needs_funding).
  const [funding, setFunding] = useState<'' | 'prepaid' | 'credit'>('');
  const [creditLimit, setCreditLimit] = useState('');

  // ───────────────────────────────────────────────────────────────────────────
  // FUND THEM NOW?
  // ───────────────────────────────────────────────────────────────────────────
  // A promotion assigns the TERMS - commission, rakeback, prepaid or a credit
  // line. It does not put a single chip in the agent wallet. A credit LIMIT is
  // authorization, never an automatic transfer. The owner must deliberately
  // send chips through the audited club-bank cashier when they want to fund the
  // wallet; this prompt merely offers that separate action.
  //
  // Asked rather than done. Funding somebody is a transfer of chips and it is
  // not implied by choosing their commission rate, so this offers the step and
  // takes "Not Now" for an answer.
  const [fundPrompt, setFundPrompt] = useState<{ role: ClubRole } | null>(null);
  const [showFundModal, setShowFundModal] = useState(false);

  // CA-18 BUG FIX: the 1.2s "show success then refresh" timer was fire-and-forget.
  // If the user left the screen before 1.2s, the component unmounted and the
  // callback fired on a dead component tree.
  const roleChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (roleChangeTimerRef.current) clearTimeout(roleChangeTimerRef.current);
    };
  }, []);

  // The server decides what may be offered. fn_club_grantable_roles is the
  // rule; this asks it rather than guessing, so the buttons on screen and the
  // write that follows cannot disagree - and "is this player in my downline",
  // which the client has no way to answer, is answered where the tree lives.
  const [promotableRoles, setPromotableRoles] = useState<ClubRole[]>([]);
  const [rolesLoading, setRolesLoading] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      setRolesLoading(true);
      try {
        const { data, error: rolesErr } = await supabase.rpc('ca_club_grantable_roles', {
          p_club_id: resolvedClubId,
          p_target_user_id: targetUserId,
        });
        if (!live) return;
        if (rolesErr) throw rolesErr;
        const roles = (data as { roles?: string[] } | null)?.roles ?? [];
        setPromotableRoles(roles.map(normaliseRole));
      } catch (e) {
        reportError(e, 'MemberManagementPage.grantable_roles');
        // Offering nothing is the safe direction to be wrong in: the user is
        // told, rather than shown a button the server will refuse.
        if (live) setPromotableRoles([]);
      } finally {
        if (live) setRolesLoading(false);
      }
    })();
    return () => {
      live = false;
    };
    // targetRole is a dependency because the answer changes once the role does:
    // after promoting a player to agent, "agent" must stop being on offer.
  }, [resolvedClubId, targetUserId, targetRole]);

  const canManage = promotableRoles.length > 0 && targetRole !== 'owner';

  const noRolesReason =
    targetRole === 'owner'
      ? 'The Club Owner Cannot Be Changed From Here.'
      : roleRank(myRole) <= roleRank('sub_agent')
        ? 'Your Role Does Not Allow Changing Anyone Else’s.'
        : 'You Can Only Change The Role Of Players In Your Own Downline.';

  const handlePromote = async (newRole: ClubRole) => {
    setPromoting(true);
    setError('');
    setSuccess('');

    // THE RATE IS CHOSEN HERE OR IT IS NOT CHOSEN AT ALL.
    //
    // Dan, 2026-08-31: "MAKE SURE THAT RAKE BACK PERCENTAGES ARE ASSIGNED WHEN
    // CREATING THEM (CO-OWNERS AND ADMINS GET NO RAKE BACK)."
    //
    // This screen used to send the role and nothing else, and the server
    // invented a pair of rates - 50/30 for a super agent, 30/20 for the other
    // two - that nobody had agreed to, and applied them only when the agents
    // row did not already exist. fn_club_set_member_role now refuses an agent
    // role that arrives without a rate, so the two fields below are the whole
    // point of the confirm step rather than decoration on it.
    let rates:
      | {
          p_commission_rate: number;
          p_player_rakeback_rate: number;
          p_is_prepaid: boolean;
          p_credit_limit: number;
        }
      | undefined;
    if (isAgentRole(newRole)) {
      const comm = Number(commissionPct);
      const rake = Number(rakebackPct);
      if (commissionPct.trim() === '' || rakebackPct.trim() === '') {
        setError('Enter A Commission And A Rakeback Percentage.');
        setPromoting(false);
        return;
      }
      if (!Number.isFinite(comm) || comm < 0 || comm > 70) {
        setError('Commission Must Be Between 0 And 70 Percent.');
        setPromoting(false);
        return;
      }
      if (!Number.isFinite(rake) || rake < 0 || rake > 50) {
        setError('Rakeback Must Be Between 0 And 50 Percent.');
        setPromoting(false);
        return;
      }
      if (rake > comm) {
        setError('Rakeback Cannot Be More Than The Commission It Is Paid Out Of.');
        setPromoting(false);
        return;
      }
      // THE FUNDING IS CHOSEN HERE TOO.
      //
      // Dan, 2026-08-31: "THEY ALSO NEED TO BE ASSIGNED 'PRE PAID' OR CREDIT
      // LINE, (AND IF SO, THEN HOW MUCH)". Every promotion before this one sent
      // no funding at all, so the server stored the single combination that can
      // send nothing: not prepaid, and no line to draw on.
      if (funding === '') {
        setError('Choose Prepaid Or A Credit Line.');
        setPromoting(false);
        return;
      }
      const limit = funding === 'prepaid' ? 0 : Number(creditLimit);
      if (funding === 'credit' && (creditLimit.trim() === '' || !Number.isFinite(limit))) {
        setError('Enter A Credit Limit.');
        setPromoting(false);
        return;
      }
      if (funding === 'credit' && limit <= 0) {
        setError('A Credit Limit Must Be Greater Than 0, Or The Agent Should Be Prepaid.');
        setPromoting(false);
        return;
      }

      // The database stores a fraction. The field asks for a percentage.
      rates = {
        p_commission_rate: comm / 100,
        p_player_rakeback_rate: rake / 100,
        p_is_prepaid: funding === 'prepaid',
        p_credit_limit: limit,
      };
    }

    try {
      // ONE WRITE PATH. This used to fall back to
      // `.from('club_members').update({ role })` whenever the RPC errored,
      // which skipped every rule the RPC enforces - a club admin could appoint
      // a co-owner, or promote outside their downline, by making one request
      // fail. A trigger on club_members now refuses that update outright, so
      // the fallback could not work even if someone put it back.
      const { data, error: rpcError } = await supabase.rpc('fn_club_set_member_role', {
        p_club_id: resolvedClubId,
        p_user_id: targetUserId,
        p_role: newRole,
        ...(rates ?? {}),
      });
      if (rpcError) throw rpcError;

      const result = data as { success?: boolean; error?: string } | null;
      if (!result?.success) throw new Error(result?.error || 'Role change refused');

      setSuccess(`${targetName} Is Now ${roleLabel(newRole)}`);
      setConfirmRole(null);
      toast.success(`${targetName} Is Now ${roleLabel(newRole)}`);

      masterBus.emit('CLUB_UPDATED', { clubId });
      const agentRoles: ClubRole[] = ['super_agent', 'agent', 'sub_agent'];
      if (agentRoles.includes(newRole) || agentRoles.includes(targetRole)) {
        masterBus.emit('AGENT_UPDATED', { clubId, agentId: targetUserId });
      }
      masterBus.emit('MEMBER_ROLE_CHANGED', {
        clubId,
        userId: targetUserId,
        newRole,
        previousRole: targetRole,
      });

      // An agent who has just been given terms and no chips is the state this
      // phase exists to stop shipping quietly. Offer the funding step - but only
      // when the wallet really is empty, so re-grading an agent who is already
      // carrying float does not ask a question with an obvious answer.
      if (isAgentRole(newRole)) {
        let float_ = 0;
        try {
          const { data: agentRow, error: balanceError } = await supabase
            .from('agents')
            .select('agent_wallet_balance')
            .eq('club_id', resolvedClubId)
            .eq('user_id', targetUserId)
            .maybeSingle();
          // Bound and acted on rather than discarded. supabase-js returns the
          // failure, it does not throw one, so an unbound `error` here would
          // read a missing row and a denied read as the same thing: zero. That
          // is the wrong direction to be silent in - "their wallet is empty" is
          // exactly the claim this prompt makes to the person's face.
          if (balanceError) throw balanceError;
          float_ = Number(agentRow?.agent_wallet_balance ?? 0) || 0;
        } catch (e) {
          // A balance we cannot read is not a reason to withhold the offer, and
          // not a reason to fail a promotion that already succeeded. Ask anyway:
          // the transfer screen reads the real number itself.
          reportError(e, 'MemberManagementPage.fundPromptBalance');
        }
        if (float_ <= 0) {
          setFundPrompt({ role: newRole });
          return; // The prompt owns what happens next, including the refresh.
        }
      }

      if (roleChangeTimerRef.current) clearTimeout(roleChangeTimerRef.current);
      roleChangeTimerRef.current = setTimeout(() => {
        roleChangeTimerRef.current = null;
        onRoleChanged();
      }, 1200);
    } catch (err) {
      setError(safeErrorMessage(err, 'Failed To Update Role'));
    } finally {
      setPromoting(false);
    }
  };

  return (
    <section className="mm-card mm-roles">
      <h2 className="mm-card__title">Role</h2>

      <div className="mm-roles__current">
        <span className="mm-roles__current-label">Current</span>
        <span className="mm-roles__current-value" style={{ color: roleColor(targetRole) }}>
          {roleLabel(targetRole)}
        </span>
      </div>

      {/* The offer. It takes the place of the role controls while it is up,
          because the promotion is already done and the only question left is
          whether to fund it now. */}
      {fundPrompt ? (
        <div className="mm-roles__fund">
          <p className="mm-roles__fund-title">
            {targetName} Is Now {roleLabel(fundPrompt.role)}
          </p>
          <p className="mm-roles__fund-note">
            Their Agent Wallet Is Empty, So They Cannot Send Chips To Anybody Yet. Fund Them Now?
          </p>
          <div className="mm-roles__confirm-actions">
            <button
              type="button"
              className="mm-roles__confirm-yes"
              onClick={() => setShowFundModal(true)}
            >
              Send Chips
            </button>
            <button
              type="button"
              className="mm-roles__confirm-no"
              onClick={() => {
                setFundPrompt(null);
                onRoleChanged();
              }}
            >
              Not Now
            </button>
          </div>
        </div>
      ) : rolesLoading ? (
        <p className="mm-roles__note">Checking What You May Grant...</p>
      ) : !canManage ? (
        <p className="mm-roles__note">{noRolesReason}</p>
      ) : confirmRole ? (
        <div className="mm-roles__confirm">
          <p>
            Change <strong>{targetName}</strong> To{' '}
            <strong style={{ color: roleColor(confirmRole) }}>{roleLabel(confirmRole)}</strong>?
          </p>

          {isAgentRole(confirmRole) && (
            <div className="mm-roles__rates">
              <p className="mm-roles__rates-note">
                Set The Deal Now. The Server Will Not Accept An Agent Without One.
              </p>
              <label className="mm-field">
                <span className="mm-field__label">Commission Percent (0 To 70)</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={70}
                  step={1}
                  value={commissionPct}
                  placeholder="E.G. 40"
                  onChange={(e) => setCommissionPct(e.target.value)}
                  disabled={promoting}
                />
              </label>
              <label className="mm-field">
                <span className="mm-field__label">Player Rakeback Percent (0 To 50)</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={50}
                  step={1}
                  value={rakebackPct}
                  placeholder="E.G. 30"
                  onChange={(e) => setRakebackPct(e.target.value)}
                  disabled={promoting}
                />
              </label>
              <div className="mm-roles__funding">
                <span className="mm-field__label">Funding</span>
                <div className="mm-roles__funding-choice" role="group" aria-label="Funding">
                  <button
                    type="button"
                    className={`mm-roles__funding-option${
                      funding === 'prepaid' ? ' mm-roles__funding-option--on' : ''
                    }`}
                    aria-pressed={funding === 'prepaid'}
                    onClick={() => {
                      setFunding('prepaid');
                      setCreditLimit('');
                    }}
                    disabled={promoting}
                  >
                    Prepaid
                  </button>
                  <button
                    type="button"
                    className={`mm-roles__funding-option${
                      funding === 'credit' ? ' mm-roles__funding-option--on' : ''
                    }`}
                    aria-pressed={funding === 'credit'}
                    onClick={() => setFunding('credit')}
                    disabled={promoting}
                  >
                    Credit Line
                  </button>
                </div>
              </div>

              {funding === 'prepaid' && (
                <p className="mm-roles__rates-note">
                  A Prepaid Agent Sends Only Chips They Already Hold.
                </p>
              )}

              {funding === 'credit' && (
                <label className="mm-field">
                  <span className="mm-field__label">Credit Limit In Chips</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={1}
                    value={creditLimit}
                    placeholder="E.G. 50000"
                    onChange={(e) => setCreditLimit(e.target.value)}
                    disabled={promoting}
                  />
                </label>
              )}

              <p className="mm-roles__rates-note">
                Rakeback Is Paid Out Of The Commission, So It Cannot Be The Larger Of The Two, And
                Neither May Exceed The Upline They Report To. A Credit Line Cannot Exceed The Upline
                Limit Either, And It Is Owed Back Weekly.
              </p>
            </div>
          )}

          {isClubStaff(confirmRole) && (
            <p className="mm-roles__rates-note">
              This Role Earns No Rakeback. Any Rate This Member Carries Is Set To Zero.
            </p>
          )}

          <div className="mm-roles__confirm-actions">
            <button
              type="button"
              className="mm-roles__confirm-yes"
              onClick={() => void handlePromote(confirmRole)}
              disabled={promoting}
            >
              {promoting ? 'Updating...' : 'Confirm'}
            </button>
            <button
              type="button"
              className="mm-roles__confirm-no"
              onClick={() => setConfirmRole(null)}
              disabled={promoting}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mm-roles__list">
          {promotableRoles.map((role) => (
            <button
              key={role}
              type="button"
              className={`mm-roles__option${role === targetRole ? ' mm-roles__option--current' : ''}`}
              onClick={() => {
                setError('');
                setCommissionPct('');
                setRakebackPct('');
                setFunding('');
                setCreditLimit('');
                setConfirmRole(role);
              }}
              disabled={role === targetRole || promoting}
            >
              <RoleBadge role={role} size="sm" />
              <span className="mm-roles__option-main">
                <span className="mm-roles__option-name" style={{ color: roleColor(role) }}>
                  {roleLabel(role)}
                </span>
                <span className="mm-roles__option-desc">{ROLE_DESCRIPTION[role]}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {error && <p className="mm-roles__error">{error}</p>}
      {success && <p className="mm-roles__success">{success}</p>}

      {/* The transfer screen itself, aimed at the person just promoted. It
          reads the real balances and routes the send by role, so nothing about
          the money is re-decided here. */}
      {showFundModal && (
        <ChipTransferModal
          isOpen={showFundModal}
          clubId={resolvedClubId}
          recipientId={targetUserId}
          onClose={() => {
            setShowFundModal(false);
            setFundPrompt(null);
            onRoleChanged();
          }}
          onTransferComplete={() => {
            toast.success(`${targetName} Has Been Funded.`);
            masterBus.emit('AGENT_UPDATED', { clubId, agentId: targetUserId });
          }}
        />
      )}
    </section>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   SMALL PARTS
   ═══════════════════════════════════════════════════════════════════════════════ */

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="mm-info">
      <span className="mm-info__label">{label}</span>
      <span className="mm-info__value">{value}</span>
    </div>
  );
}

/**
 * `signed` is the raw number behind `value`, supplied only for figures that can
 * legitimately go below zero. Positive reads arena cyan and negative reads
 * --danger-red; there is no green in this product, so "up" is the primary colour
 * rather than a second hue nobody else uses.
 */
function StatRow({ label, value, signed }: { label: string; value: string; signed?: number }) {
  const tone =
    signed === undefined || signed === 0 ? '' : signed > 0 ? ' mm-stat--up' : ' mm-stat--down';

  return (
    <div className={`mm-stat${tone}`}>
      <span className="mm-stat__label">{label}</span>
      <span className="mm-stat__value">{value}</span>
    </div>
  );
}
