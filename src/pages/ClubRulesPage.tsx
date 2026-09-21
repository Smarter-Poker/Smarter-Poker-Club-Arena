/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB RULES PAGE — Custom Club Guidelines
 * ═══════════════════════════════════════════════════════════════════════════════
 * Admin-editable club rules that members see. Stored in club_settings.
 */

import { useState, useEffect, useRef } from 'react';
import { isClubStaff, normaliseRole, type ClubRole } from '../types/clubRoles';
import { useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { sanitizeInput } from '../utils/sanitizeInput';
import {
  resolveClubIdFilter,
  resolveClubUUID,
  resolveClubUUIDStrict,
} from '../utils/clubIdResolver';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import './ClubRulesPage.css';
import PageSkeleton from '../components/common/PageSkeleton';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import { reportError } from '../utils/errorReporter';
import { SpadeConsole } from '../components/console/SpadeConsole';

const rulesLineAnimationStyle = (index: number) => ({
  opacity: 0,
  transform: 'translateY(4px)',
  animation: `animationsFadeInUp 0.4s ease-out ${index * 40}ms forwards`,
});

export default function ClubRulesPage() {
  const { clubId } = useParams<{ clubId: string }>();
  const { user } = useAuthUser();
  const toast = useToast();

  // Re-fetch rules when user tabs back (covers WS disconnect gap)
  useVisibilityRefresh(() => {
    if (clubId && user?.id) loadRules();
  });

  const [rules, setRules] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clubName, setClubName] = useState('');
  const [userRole, setUserRole] = useState<ClubRole>('player');
  const [loadError, setLoadError] = useState(false);
  const loadingRef = useRef(false);

  // ── CRITICAL: Reset per-club state when navigating between clubs ──
  useEffect(() => {
    setIsAdmin(false);
    setUserRole('player');
    setIsEditing(false);
    setSaving(false);
    setLoadError(false);
    loadingRef.current = false;
  }, [clubId]);

  useEffect(() => {
    let isMounted = true;
    if (clubId && user?.id) loadRules(() => isMounted);
    return () => {
      isMounted = false;
    };
  }, [clubId, user?.id]);

  // ── WebSocket: live rule updates from other admins ──
  useEffect(() => {
    if (!clubId) return;
    let isMounted = true;
    const channelKey = `club-rules-${clubId}`;
    const setup = async () => {
      const resolvedId = await resolveClubUUID(clubId);
      if (!isMounted) return;
      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'clubs', filter: `id=eq.${resolvedId}` },
          () => {
            if (isMounted && !isEditing) loadRules(() => isMounted);
          }
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'ClubRulesPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[ClubRulesPage] Realtime channel timed out');
          }
        });
    };
    setup().catch((e) => console.warn('[ClubRulesPage] Realtime setup failed:', e));
    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId, isEditing]);

  // ── Bus Listener: reload rules if another admin updates the club ──
  useEffect(() => {
    let isMounted = true;
    const unsub = masterBus.subscribeDebounced(
      'CLUB_UPDATED',
      () => {
        if (isMounted && clubId && user?.id && !isEditing) loadRules(() => isMounted);
      },
      1000
    );
    return () => {
      isMounted = false;
      unsub();
    };
  }, [clubId, user?.id, isEditing]);

  const loadRules = async (getIsMounted?: () => boolean) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoadError(false);
    setLoading(true);
    try {
      // Load club info
      const { column: clubCol, value: clubVal } = resolveClubIdFilter(clubId!);

      // SWR: show cached rules instantly
      const swrKey = `rules_cache_${clubId}`;
      try {
        const cached = sessionStorage.getItem(swrKey);
        if (cached) {
          const c = JSON.parse(cached);
          if (c.name) setClubName(c.name);
          if (c.rules) setRules(c.rules);
          setLoading(false);
        }
      } catch {
        /* corrupt cache */
      }

      // Rules live in the clubs.settings jsonb (there is no clubs.rules_text column).
      /* THE ERROR IS READ. Without it a failed club read was identical to "this
         club has published no rules": the page rendered empty (or a stale
         sessionStorage copy), set no loadError, said nothing, and the owner
         lost the Edit button at the same time. */
      const { data: club, error: clubErr } = await supabase
        .from('clubs')
        .select('name, settings, owner_id')
        .eq(clubCol, clubVal)
        .maybeSingle();

      if (getIsMounted && !getIsMounted()) return;
      if (clubErr) throw clubErr;

      let adminFromOwner = false;
      if (club) {
        setClubName(club.name);
        setRules((club.settings as { rules_text?: string } | null)?.rules_text || '');
        adminFromOwner = club.owner_id === user?.id;
        if (adminFromOwner) {
          setIsAdmin(true);
          setUserRole('owner');
        }
        // SWR: cache successful fetch
        try {
          sessionStorage.setItem(
            swrKey,
            JSON.stringify({
              name: club.name,
              rules: (club.settings as { rules_text?: string } | null)?.rules_text || '',
            })
          );
        } catch {
          /* storage full */
        }
      }

      // Check if admin via club_members (only if not already owner)
      if (!adminFromOwner) {
        const resolvedId = await resolveClubUUID(clubId!);
        const { data: membership, error: membershipErr } = await supabase
          .from('club_members')
          .select('role')
          .eq('club_id', resolvedId)
          .eq('user_id', user?.id)
          .maybeSingle();

        if (getIsMounted && !getIsMounted()) return;
        /* Fails closed either way, but a staff member who is told nothing about
           why their Edit button vanished will try again and again. */
        if (membershipErr) reportError(membershipErr, 'ClubRulesPage.role_lookup_failed');

        if (isClubStaff(membership?.role)) {
          setIsAdmin(true);
          // isClubStaff narrows nothing for the compiler, and the cast used to
          // exclude co_owner - a co-owner would have been admitted here and
          // then stored under a type that says they cannot exist.
          setUserRole(normaliseRole(membership?.role) as 'owner' | 'co_owner' | 'admin');
        }
      }
    } catch (err) {
      if (getIsMounted && !getIsMounted()) return;
      reportError(err, 'ClubRulesPage.Failed_to_load_rules');
      setLoadError(true);
      toast.error('Failed to load rules');
    } finally {
      loadingRef.current = false;
      if (!getIsMounted || getIsMounted()) setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!clubId) return;
    setSaving(true);
    try {
      /**
       * ONE RPC, NOT A READ-MODIFY-WRITE (20260905083442).
       *
       * This used to select `clubs.settings`, spread `rules_text` into the
       * object and write the whole document back. Two defects came with it:
       *
       *  - the UPDATE had no `.select()`, and the `clubs` UPDATE policy is
       *    `owner_id = auth.uid()`. A co-owner or admin - both of whom this
       *    page SHOWS the Edit button to - matched zero rows, got a 204 with
       *    no error, and was told "Club rules updated!" over text that was
       *    never stored;
       *  - `settings` also carries rake cap, buy-in bounds, straddle, run it
       *    twice and the time bank default, so saving prose wrote back a stale
       *    copy of the club's rake configuration.
       *
       * `fn_set_club_rules` writes the one key with `jsonb_set`, refuses
       * anybody who is not owner, co-owner or admin, and RETURNS what it
       * stored - so an empty result is a refusal, not a success.
       */
      const resolvedForSave = await resolveClubUUIDStrict(clubId!);
      /* NO `.select()` ON AN RPC. The function RETURNS TABLE, so PostgREST
         already hands back the row and `.maybeSingle()` is all that is needed.
         Naming a column in a select after this call also made
         `check-phantom-columns` read that name against the last TABLE the file
         mentions - club_members - and fail the branch for a column that table
         has never had. The column list is the function's return type; it does
         not belong in the client at all. */
      const { data: saved, error } = await supabase
        .rpc('fn_set_club_rules', {
          p_club_id: resolvedForSave,
          p_rules: sanitizeInput(editValue),
        })
        .maybeSingle();

      if (error) throw error;
      if (!saved) {
        // No row means the write did not happen. Never paint it as if it did.
        toast.error('Those Rules Were Not Saved. Ask An Owner To Try.');
        return;
      }

      // Paint what the DATABASE stored, not what was typed: the function caps
      // the length, so the two can legitimately differ.
      const storedText = String((saved as { rules_text: string | null }).rules_text ?? '');
      setRules(storedText);
      setEditValue(storedText);
      setIsEditing(false);
      toast.success('Club Rules Updated');
      masterBus.emit('CLUB_UPDATED', { clubId });
    } catch (err) {
      reportError(err, 'ClubRulesPage.Failed_to_save_rules');
      toast.error('Failed to save rules');
    }
    setSaving(false);
  };

  /* THE CONSOLE (2026-09-04). The rules sat in a rounded navy card under a
     plain "Club Rules" heading with a rounded blue Edit button - the same
     generic sheet every other page had. It is now the spade console - the
     master every Omaha card is drawn from, cut into head, rails and foot:
     the club's name and CLUB RULES engraved in the header well, each rule
     printed on the glass with a lit blue numeral, and for staff the plates
     painted into the foot (COPY on steel, EDIT RULES on the blue glass;
     CANCEL / SAVE RULES while editing). Members see the closing foot only.
     Same data, same handlers, same guards (the fn_set_club_rules save path
     above is untouched). */
  const ruleLines = rules.split('\n');
  let ruleNumber = 0;
  const staffPlates =
    isAdmin && !loading && !loadError
      ? isEditing
        ? {
            secondary: {
              label: 'Cancel',
              className: 'rules-cancel',
              onClick: () => setIsEditing(false),
              disabled: saving,
            },
            primary: {
              label: saving ? 'Saving' : 'Save Rules',
              ink: 'white' as const,
              className: 'rules-save',
              onClick: () => void handleSave(),
              disabled: saving,
            },
          }
        : {
            secondary: {
              label: 'Copy',
              className: 'rules-copy',
              disabled: !rules,
              onClick: () => {
                void navigator.clipboard?.writeText(rules).then(
                  () => toast.success('Rules Copied'),
                  () => toast.error('Could Not Copy')
                );
              },
            },
            primary: {
              label: rules ? 'Edit Rules' : 'Add Rules',
              ink: 'white' as const,
              className: 'edit-btn',
              onClick: () => {
                setEditValue(rules);
                setIsEditing(true);
              },
            },
          }
      : undefined;

  return (
    <StandardContentLayout className="club-rules-page">
      <SpadeConsole
        className="club-rules-console"
        aria-busy={loading || saving || undefined}
        eyebrow={clubName || 'Club'}
        title="Club Rules"
        pill={loadError ? 'Offline' : isAdmin ? 'Staff' : undefined}
        pillInk={loadError ? 'red' : 'blue'}
        plates={staffPlates}
        foot={staffPlates ? 'plates' : 'foot'}
      >
        {loading ? (
          <div className="loading-state">
            <PageSkeleton variant="settings" />
          </div>
        ) : loadError ? (
          <div className="rules-empty">
            <span className="sc-label sc-ink--red">Could Not Load</span>
            <p className="sc-copy sc-copy--center">Failed To Load Club Rules.</p>
            <button type="button" className="rules-retry sc-ink--blue" onClick={() => loadRules()}>
              Retry
            </button>
          </div>
        ) : isEditing ? (
          <div className="rules-editor">
            <textarea
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              placeholder="Enter Your Club Rules And Guidelines Here...&#10;&#10;Example:&#10;1. Be Respectful To All Players&#10;2. No Slow-Rolling&#10;3. Minimum Buy-In Is 50 BB&#10;4. Seat Changes Allowed Between Hands&#10;5. No External Software Allowed"
              rows={14}
              className="rules-textarea"
              aria-label="Club Rules"
            />
          </div>
        ) : (
          <div className="rules-display">
            {rules ? (
              <ol className="rules-text">
                {ruleLines.map((line, i) => {
                  const trimmed = line.trim();
                  if (!trimmed) return <li key={i} className="rules-gap" aria-hidden="true" />;
                  /* A line that already starts with its own number keeps it
                     as the lit numeral; any other line is numbered in order. */
                  const m = trimmed.match(/^(\d+)[.)]\s*(.*)$/);
                  const label = m ? m[1] : String(++ruleNumber);
                  if (m) ruleNumber = Number(m[1]);
                  const body = m ? m[2] : trimmed;
                  return (
                    <li key={i} className="rules-line" style={rulesLineAnimationStyle(i)}>
                      <span className="rules-line__number sc-ink--blue" aria-hidden="true">
                        {label}
                      </span>
                      <span className="rules-line__text">{body}</span>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className="rules-empty empty-rules">
                <span className="sc-label sc-ink--blue">No Rules Set</span>
                <p className="sc-copy sc-copy--center">
                  {isAdmin
                    ? 'Add Rules And Guidelines For Your Club Members.'
                    : "The Club Owner Hasn't Set Any Rules Yet."}
                </p>
              </div>
            )}
          </div>
        )}
      </SpadeConsole>
    </StandardContentLayout>
  );
}
