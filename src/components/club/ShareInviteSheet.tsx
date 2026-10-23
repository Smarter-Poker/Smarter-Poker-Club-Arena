/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SHARE & INVITE SHEET - the club lobby's invite button opens this
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-10-15. The link is the SENDER's own: one short code per member per
 * club (smarter.poker/i/<CODE>), so whoever shares it is credited and the new
 * player lands in their downline. On the sheet:
 *   - the short link, Copy and Share (the OS share sheet where there is one),
 *   - a QR code, for inviting the friend sitting next to you,
 *   - the sender's own numbers: opened, signed up, verified, joined,
 *   - for owners, co-owners, admins and agents: Invite Stats for the club (or
 *     the agent's downline), one row per inviter.
 *
 * Laid on the spade console like the referral modal (ReferralModal.css owns the
 * overlay, rows and lit words; ShareInviteSheet.css only adds the QR well and
 * the stats grid). No hover effects (tests/no-hover-effects.law.test.ts).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { SpadeConsole } from '../console/SpadeConsole';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useUserStore } from '../../stores/useUserStore';
import { reportError } from '../../utils/errorReporter';
import { IS_NATIVE_BUILD, isNativePlatform } from '../../lib/appBase';
import {
  getClubInviteStats,
  getMyInviteLink,
  getMyInviteStats,
  inviteShareText,
  type ClubInviteStatRow,
  type InviteLink,
  type InviteStats,
} from '../../services/ClubInviteService';
import '../social/ReferralModal.css';
import './ShareInviteSheet.css';

/**
 * The system share sheet on the app build (src/lib/native/share.ts). A function
 * of its own so IS_NATIVE_BUILD removes the import, and the Capacitor plugin
 * with it, from the web bundle (see StatsShareCard.tsx for why it cannot sit
 * inside the handler's try). Resolves false on the web, where the caller uses
 * navigator.share or the clipboard instead.
 */
async function shareInviteOnNative(title: string, text: string, url: string): Promise<boolean> {
  if (!IS_NATIVE_BUILD || !isNativePlatform()) return false;
  const { nativeShareText } = await import('../../lib/native/share');
  await nativeShareText(title, text, url);
  return true;
}

export interface ShareInviteSheetProps {
  isOpen: boolean;
  onClose: () => void;
  clubId: string;
  clubName: string;
  clubNumber: number | string | null | undefined;
  inviterAlias: string;
  /** Owners, co-owners, admins and agents get the stats table. */
  canSeeClubStats: boolean;
  quickStart?: boolean;
}

export function ShareInviteSheet({
  isOpen,
  onClose,
  clubId,
  clubName,
  clubNumber,
  inviterAlias,
  canSeeClubStats,
  quickStart = false,
}: ShareInviteSheetProps) {
  const accountId = useUserStore((state) => state.user?.id);
  const scopeIdentity = JSON.stringify([isOpen, clubId, accountId, quickStart, canSeeClubStats]);
  const renderedScope = useRef(scopeIdentity);
  // Reject old completions immediately on a new render, before effect cleanup.
  renderedScope.current = scopeIdentity;
  const scopeEpoch = useRef(0);
  const statsBusy = useRef(false);
  const [clubStatsError, setClubStatsError] = useState(false);
  const [link, setLink] = useState<InviteLink | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [stats, setStats] = useState<InviteStats | null>(null);
  const [clubRows, setClubRows] = useState<ClubInviteStatRow[] | null>(null);
  const [clubScope, setClubScope] = useState<'club' | 'downline' | null>(null);
  const [showClubStats, setShowClubStats] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [shareError, setShareError] = useState(false);
  const [linkAttempt, setLinkAttempt] = useState(0);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dialogRef = useFocusTrap(isOpen);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, onClose]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    []
  );

  // Every asynchronous result belongs to one open club/account session.
  // Cleanup invalidates pending actions as well as reads, including close/reopen.
  useEffect(() => {
    const epoch = ++scopeEpoch.current;
    const current = () => scopeEpoch.current === epoch && renderedScope.current === scopeIdentity;
    statsBusy.current = false;
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    setLink(null);
    setStats(null);
    setClubRows(null);
    setClubScope(null);
    setClubStatsError(false);
    setLinkError(null);
    setCopied(false);
    setCopyError(false);
    setShareError(false);
    setShowClubStats(false);
    if (isOpen && clubId) {
      getMyInviteLink(clubId)
        .then((l) => {
          if (current()) setLink(l);
        })
        .catch((err) => {
          reportError(err, 'ShareInviteSheet.link');
          if (current()) setLinkError('Your Invite Link Could Not Be Created. Please Try Again.');
        });
      if (!quickStart)
        getMyInviteStats(clubId)
          .then((s) => {
            if (current()) setStats(s);
          })
          .catch((err) => reportError(err, 'ShareInviteSheet.myStats'));
    }
    return () => {
      ++scopeEpoch.current;
    };
  }, [isOpen, clubId, accountId, linkAttempt, quickStart, canSeeClubStats, scopeIdentity]);

  const loadClubStats = useCallback(async () => {
    if (!isOpen || !canSeeClubStats || statsBusy.current) return;
    setShowClubStats(true);
    if (clubRows) return;
    const epoch = scopeEpoch.current;
    statsBusy.current = true;
    setClubStatsError(false);
    try {
      const r = await getClubInviteStats(clubId);
      if (scopeEpoch.current !== epoch || renderedScope.current !== scopeIdentity) return;
      setClubRows(r.allowed ? r.rows : []);
      setClubScope(r.scope);
    } catch (err) {
      reportError(err, 'ShareInviteSheet.clubStats');
      if (scopeEpoch.current === epoch && renderedScope.current === scopeIdentity)
        setClubStatsError(true);
    } finally {
      if (scopeEpoch.current === epoch && renderedScope.current === scopeIdentity)
        statsBusy.current = false;
    }
  }, [clubId, clubRows, isOpen, canSeeClubStats, scopeIdentity]);

  if (!isOpen) return null;

  const shareText = inviteShareText(inviterAlias, clubName, clubNumber);

  const handleCopy = async () => {
    if (!link) return;
    const epoch = scopeEpoch.current;
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(`${shareText}\n\n${link.shortUrl}`);
    } catch (err) {
      reportError(err, 'ShareInviteSheet.copy');
      if (scopeEpoch.current === epoch && renderedScope.current === scopeIdentity)
        setCopyError(true);
      return;
    }
    if (scopeEpoch.current !== epoch || renderedScope.current !== scopeIdentity) return;
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => {
      if (scopeEpoch.current === epoch && renderedScope.current === scopeIdentity) setCopied(false);
    }, 2000);
  };

  const handleShare = async () => {
    if (!link) return;
    const epoch = scopeEpoch.current;
    setShareError(false);
    try {
      if (await shareInviteOnNative(clubName, shareText, link.shortUrl)) return;
      if (scopeEpoch.current !== epoch || renderedScope.current !== scopeIdentity) return;
      if (navigator.share) {
        await navigator.share({ title: clubName, text: shareText, url: link.shortUrl });
      } else {
        await handleCopy();
      }
    } catch (err) {
      // AbortError is the player closing the share sheet, not a failure.
      if ((err as Error)?.name !== 'AbortError') {
        reportError(err, 'ShareInviteSheet.share');
        if (scopeEpoch.current === epoch && renderedScope.current === scopeIdentity)
          setShareError(true);
      }
    }
  };

  const figures: Array<[string, number | null]> = [
    ['Opened', stats ? stats.opened : null],
    ['Signed Up', stats ? stats.signedUp : null],
    ['Verified', stats ? stats.verified : null],
    ['Joined', stats ? stats.joined : null],
  ];

  /* Portalled to <body>: inside the club page the overlay sits in that page's
     z-index:1 stacking context, so the sticky header covered the close control
     and the fixed footer covered Share and Close on short screens. At the
     document root its z-index 10000 clears both and the overlay scrolls. */
  return createPortal(
    <div className="referral-overlay" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="rfc sis"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-invite-title"
        onClick={(e) => e.stopPropagation()}
      >
        <SpadeConsole
          onClose={onClose}
          eyebrow={clubName}
          title={quickStart ? 'Your Club Is Created' : 'Share & Invite'}
          titleId="share-invite-title"
          pill="Your Link"
          pillInk="blue"
          foot={quickStart ? 'plates' : 'foot'}
          plates={
            quickStart
              ? {
                  secondary: { label: 'Open Club', onClick: onClose },
                  primary: {
                    label: copied ? 'Link Copied' : 'Send Link',
                    onClick: handleShare,
                    disabled: !link,
                  },
                }
              : undefined
          }
          className="rfc__console"
        >
          <p className="sc-copy sc-copy--center">
            {quickStart
              ? 'Send Your Link To Invite Friends. Branding And Advanced Settings Can Wait.'
              : 'Everyone Who Joins With Your Link Is Credited To You And Placed In Your Downline.'}
          </p>

          {linkError ? (
            <p className="sc-copy sc-ink--red" role="alert">
              {linkError}
              <button
                type="button"
                className="rfc-word sc-ink--blue"
                onClick={() => setLinkAttempt((attempt) => attempt + 1)}
              >
                Retry Link
              </button>
            </p>
          ) : null}
          {shareError && (
            <p className="sc-copy sc-ink--red" role="alert">
              The Share Sheet Could Not Open. Copy Your Link To Send It.
            </p>
          )}
          {copyError ? (
            <p className="sc-copy sc-ink--red" role="alert">
              The Link Could Not Be Copied. Select It And Copy Manually.
            </p>
          ) : null}

          <div className="rfc__link">
            <span className="sc-label sc-ink--blue">Your Invite Link</span>
            <div className="rfc__link-row">
              <input
                readOnly
                value={link?.shortUrl || ''}
                placeholder="Preparing Your Link..."
                aria-label="Your Invite Link"
                className="rfc__input"
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                type="button"
                onClick={handleCopy}
                disabled={!link}
                className={`rfc-word ${copied ? 'sc-ink--green' : 'sc-ink--white'}`}
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          {!quickStart && (
            <div className="sis__qr-row">
              <div className="sis__qr" aria-label="Invite QR Code">
                {link ? (
                  <QRCodeSVG value={link.shortUrl} size={168} level="M" marginSize={2} />
                ) : (
                  <span className="sc-label sc-ink--silver">Preparing...</span>
                )}
              </div>
              <p className="sc-copy sis__qr-note">Friend Next To You? Have Them Scan This Code.</p>
            </div>
          )}

          {!quickStart && (
            <div className="sis__figures" aria-label="Your Invite Results">
              {figures.map(([label, value]) => (
                <div className="sis__figure" key={label}>
                  <span className="rfc__figure sc-ink--silver">
                    {value == null ? '-' : value.toLocaleString()}
                  </span>
                  <span className="sc-label sc-ink--blue">{label}</span>
                </div>
              ))}
            </div>
          )}

          {canSeeClubStats && !quickStart ? (
            <div className="sis__club">
              {!showClubStats ? (
                <button type="button" className="rfc-word sc-ink--blue" onClick={loadClubStats}>
                  View Invite Stats
                </button>
              ) : clubStatsError ? (
                <p className="sc-copy sc-ink--red" role="alert">
                  Invite Stats Could Not Be Loaded.
                  <button type="button" className="rfc-word sc-ink--blue" onClick={loadClubStats}>
                    Retry Invite Stats
                  </button>
                </p>
              ) : clubRows == null ? (
                <span className="sc-label sc-ink--silver">Loading Invite Stats...</span>
              ) : clubRows.length === 0 ? (
                <span className="sc-label sc-ink--silver">No Invites Yet.</span>
              ) : (
                <>
                  <span className="sc-label sc-ink--blue">
                    {clubScope === 'downline' ? 'Your Downline Invites' : 'Club Invites'}
                  </span>
                  <table className="sis__table">
                    <thead>
                      <tr>
                        <th scope="col">Player</th>
                        <th scope="col">Opened</th>
                        <th scope="col">Signed Up</th>
                        <th scope="col">Verified</th>
                        <th scope="col">Joined</th>
                      </tr>
                    </thead>
                    <tbody>
                      {clubRows.map((row) => (
                        <tr key={row.inviterId}>
                          <th scope="row">{row.alias}</th>
                          <td>{row.opened.toLocaleString()}</td>
                          <td>{row.signedUp.toLocaleString()}</td>
                          <td>{row.verified.toLocaleString()}</td>
                          <td>{row.joined.toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          ) : null}

          {!quickStart && (
            <div className="rfc__actions">
              <button
                type="button"
                className="rfc-word sc-ink--blue"
                onClick={handleShare}
                disabled={!link}
              >
                Share
              </button>
              <button type="button" className="rfc-word sc-ink--white" onClick={onClose}>
                Close
              </button>
            </div>
          )}
        </SpadeConsole>
      </div>
    </div>,
    document.body
  );
}

export default ShareInviteSheet;
