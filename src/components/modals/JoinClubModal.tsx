import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { ClubsService } from '../../services/ClubsService';
import { masterBus } from '../../core/MasterBus';
import haptic from '../../services/HapticService';
import { useToast } from '../common/Toast';
import { useIsMounted } from '../../hooks/useIsMounted';
import { sanitizeInput } from '../../utils/sanitizeInput';
import { reportError } from '../../utils/errorReporter';

// You can create a CSS module for this, but for now we will reuse existing global/modal styles or create one.
import styles from './CreateClubModal.module.css';

interface JoinClubModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: (clubId: string) => void;
}

export default function JoinClubModal({ isOpen, onClose, onSuccess }: JoinClubModalProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const isMounted = useIsMounted();

  const [clubCode, setClubCode] = useState('');
  const [isJoining, setIsJoining] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setClubCode('');
      setIsJoining(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const handleJoin = async () => {
    if (!clubCode.trim()) {
      toast.error('Please enter a club code');
      return;
    }

    const sanitized = sanitizeInput(clubCode.trim());
    const numericCode = parseInt(sanitized.replace(/\D/g, ''), 10);
    if (isNaN(numericCode) || numericCode < 10000 || numericCode > 999999) {
      toast.error('Club code must be a 5 or 6 digit number');
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

      if (error || !club) {
        toast.error('Invalid club code. Please check and try again.');
        setIsJoining(false);
        return;
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
      <div
        className={styles.modalContainer}
        onClick={(e) => e.stopPropagation()}
        style={{
          padding: '2rem',
          background: '#11131a',
          borderRadius: '12px',
          border: '1px solid rgba(255,255,255,0.1)',
          width: '90%',
          maxWidth: '400px',
        }}
      >
        <h2 style={{ margin: '0 0 1rem', color: '#fff', fontSize: '1.5rem', textAlign: 'center' }}>
          Join A Club
        </h2>

        <p
          style={{
            color: '#a0aec0',
            fontSize: '0.9rem',
            marginBottom: '1.5rem',
            textAlign: 'center',
          }}
        >
          Enter A 5 Or 6 Digit Club Code To Join An Existing Poker Club.
        </p>

        <input
          ref={inputRef}
          type="tel"
          inputMode="numeric"
          pattern="[0-9]{5,6}"
          maxLength={6}
          placeholder="e.g. 48291"
          value={clubCode}
          onChange={(e) => {
            const val = e.target.value;
            // Detect pasted invite link
            const match = val.match(/\/invite\/([^/?]+)(?:\?ref=([a-zA-Z0-9]+))?/i);
            if (match) {
              const [, extractedClubId, extractedRef] = match;
              onClose();
              navigate(`/invite/${extractedClubId}${extractedRef ? `?ref=${extractedRef}` : ''}`);
              return;
            }
            setClubCode(val.replace(/\D/g, ''));
          }}
          onKeyDown={(e) => e.key === 'Enter' && handleJoin()}
          style={{
            width: '100%',
            padding: '1rem',
            fontSize: '1.5rem',
            textAlign: 'center',
            letterSpacing: '0.2em',
            background: 'rgba(0,0,0,0.5)',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: '8px',
            color: '#fff',
            marginBottom: '1.5rem',
          }}
        />

        <button
          onClick={() => {
            haptic.success();
            handleJoin();
          }}
          disabled={isJoining || clubCode.length < 5}
          style={{
            width: '100%',
            padding: '1rem',
            background: isJoining || clubCode.length < 5 ? '#2d3748' : '#3182ce',
            color: '#fff',
            border: 'none',
            borderRadius: '8px',
            fontSize: '1.1rem',
            fontWeight: 'bold',
            cursor: isJoining || clubCode.length < 5 ? 'not-allowed' : 'pointer',
          }}
        >
          {isJoining ? 'Joining...' : 'JOIN CLUB'}
        </button>
      </div>
    </div>
  );
}
