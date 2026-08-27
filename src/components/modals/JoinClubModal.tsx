import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { ClubsService } from '../../services/ClubsService';
import haptic from '../../services/HapticService';
import { useToast } from '../common/Toast';
import { useIsMounted } from '../../hooks/useIsMounted';
import { reportError } from '../../utils/errorReporter';
import { isJoinableClubCode, parseClubCode } from '../../utils/clubCode';

import styles from './JoinClubModal.module.css';

interface JoinClubModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (clubId: string) => void;
  /** Prefill from a deep link (`/clubs-list?c=12345`). Digits only. */
  initialCode?: string;
  /** Referral code from a deep link (`&ref=...`) — parked before the join so
   *  fn_redeem_club_invite_code can attach the upline agent afterwards. */
  initialRef?: string;
}

/** An invite link pasted anywhere in this modal routes to the invite page,
 *  which owns referral attribution. Returns the SPA path, or null. */
function parseInviteLink(text: string): string | null {
  const match = text.match(/\/invite\/([^/?\s]+)(?:\?ref=([a-zA-Z0-9]+))?/i);
  if (!match) return null;
  const [, clubId, ref] = match;
  return `/invite/${clubId}${ref ? `?ref=${ref}` : ''}`;
}

export default function JoinClubModal({
  isOpen,
  onClose,
  onSuccess,
  initialCode,
  initialRef,
}: JoinClubModalProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const isMounted = useIsMounted();

  const [clubCode, setClubCode] = useState('');
  const [isJoining, setIsJoining] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      // A deep-linked code lands prefilled so the player only confirms it.
      setClubCode(initialCode && isJoinableClubCode(initialCode) ? initialCode.trim() : '');
      setIsJoining(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen, initialCode]);

  const handleJoin = async () => {
    // Re-entry guard FIRST: the Enter key is not gated by the button's
    // disabled state, so a held or double-tapped Enter would otherwise
    // start two joins in flight.
    if (isJoining) return;

    // ONE definition of what a club code is — src/utils/clubCode.ts.
    // This modal used to hand-roll a third spelling of the 5-or-6-digit rule,
    // which is exactly how the first two screens came to disagree.
    const numericCode = parseClubCode(clubCode);
    if (numericCode === null) {
      toast.error(
        clubCode.trim() ? 'Club code must be a 5 or 6 digit number' : 'Please enter a club code'
      );
      return;
    }

    setIsJoining(true);
    try {
      // Find the club UUID from the numeric club_id
      const { data: club, error } = await supabase
        .from('clubs')
        .select('id, name')
        .eq('club_id', numericCode)
        .maybeSingle();

      if (error) {
        // A transport/database failure is not "wrong code" — telling the
        // player their valid code is invalid teaches them to stop using it.
        reportError(error, 'JoinClubModal.clubLookup');
        toast.error('Could not look up that code right now. Please try again.');
        return;
      }
      if (!club) {
        toast.error('Invalid club code. Please check and try again.');
        return;
      }

      // Park the deep-linked referral code before joining, under the club's
      // UUID — the spelling joinClub redeems it from.
      if (initialRef?.trim()) {
        ClubsService.rememberInviteCode(club.id, initialRef.trim());
      }

      // Join the club via ClubsService
      const membership = await ClubsService.join(club.id, 'member', club.name);

      if (!isMounted.current) return;

      if (membership?.status === 'pending') {
        toast.success(`Request sent to join ${club.name}. Pending approval.`);
      } else {
        toast.success(`Successfully joined ${club.name}!`);
      }

      onClose();
      onSuccess?.(club.id);

      // Navigate to the club immediately if joined
      if (membership?.status !== 'pending') {
        navigate(`/clubs/${club.id}`);
      }
    } catch (err: any) {
      reportError(err, 'JoinClubModal.handleJoin');
      if (isMounted.current) {
        if (err.message?.includes('already a member') || err.message?.includes('duplicate key')) {
          toast.info('You are already a member of this club.');
          onClose();
        } else {
          toast.error(err.message || 'Failed to join club');
        }
      }
    } finally {
      if (isMounted.current) setIsJoining(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modalContainer} onClick={(e) => e.stopPropagation()}>
        <button
          className={styles.closeButton}
          onClick={() => {
            haptic.light();
            onClose();
          }}
          aria-label="Close"
        />

        <h2 className={styles.title}>Join A Club</h2>

        <p className={styles.subtitle}>
          Enter A 5 Or 6 Digit Club Code To Join An Existing Poker Club.
        </p>

        <div className={styles.inputWrapper}>
          <input
            ref={inputRef}
            type="tel"
            inputMode="numeric"
            pattern="[0-9]{5,6}"
            maxLength={6}
            placeholder="e.g. 48291"
            className={styles.codeInput}
            value={clubCode}
            onPaste={(e) => {
              // Invite-link detection MUST happen here: maxLength={6}
              // truncates a pasted URL before onChange ever sees it, so an
              // onChange-only check can never match a full link.
              const pasted = e.clipboardData.getData('text');
              const invitePath = parseInviteLink(pasted);
              if (invitePath) {
                e.preventDefault();
                onClose();
                navigate(invitePath);
              }
            }}
            onChange={(e) => setClubCode(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
          />
        </div>

        <button
          className={styles.joinButton}
          onClick={() => {
            haptic.success();
            handleJoin();
          }}
          disabled={isJoining || !isJoinableClubCode(clubCode)}
        >
          {isJoining ? 'Joining...' : 'JOIN CLUB'}
        </button>
      </div>
    </div>
  );
}
