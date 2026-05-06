/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  REFERRAL DASHBOARD — Shows referral code, stats, milestones, and share button
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import {
  referralService,
  type ReferralStats,
  type ReferralMilestone,
} from '../../services/ReferralService';
import { useToast } from '../common/Toast';
import './ReferralDashboard.css';
import { reportError } from '../../utils/errorReporter';

interface ReferralDashboardProps {
  userId: string;
}

export default function ReferralDashboard({ userId }: ReferralDashboardProps) {
  const [stats, setStats] = useState<ReferralStats>({
    code: '',
    totalReferrals: 0,
    totalChipsEarned: 0,
  });
  const [milestones, setMilestones] = useState<ReferralMilestone[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const toast = useToast();
  const isMounted = useIsMounted();
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!userId) return;
    loadData();

    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, [userId]);

  useMasterBusSubscription('BALANCE_UPDATED', () => {
    if (isMounted.current) loadData();
  });

  const loadData = async () => {
    setLoading(true);
    try {
      const s = await referralService.getStats(userId);
      const m = referralService.getMilestones(s.totalReferrals);
      if (isMounted.current) {
        setStats(s);
        setMilestones(m);
      }
      // Check for unclaimed milestones
      await referralService.checkMilestones(userId, s.totalReferrals);
    } catch (err) {
      reportError(err, 'ReferralDashboard.load_error');
    }
    if (isMounted.current) setLoading(false);
  };

  const handleCopy = async () => {
    if (!stats.code) return;
    try {
      await navigator.clipboard.writeText(stats.code);
      if (!isMounted.current) return;
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        if (isMounted.current) setCopied(false);
      }, 2000);
    } catch (err) {
      reportError(err, 'ReferralDashboard.Error');
      if (isMounted.current) toast.error('Failed to copy');
    }
  };

  const handleShare = async () => {
    const shareText = `Join me on Club Arena! Use my referral code ${stats.code} to get 250 bonus chips! https://smarter.poker`;
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'Join Club Arena',
          text: shareText,
          url: 'https://smarter.poker',
        });
      } else {
        await navigator.clipboard.writeText(shareText);
        if (isMounted.current) toast.success('Invite link copied!');
      }
    } catch (err) {
      reportError(err, 'ReferralDashboard.Error');
      // user cancelled
    }
  };

  if (loading) {
    return (
      <div className="refd-container">
        <h3 className="refd-title">Referral Program</h3>
        <div className="refd-skeleton" />
      </div>
    );
  }

  return (
    <div className="refd-container">
      <h3 className="refd-title">Referral Program</h3>
      <p className="refd-subtitle">Invite friends and earn chips together!</p>

      {/* Code Display */}
      <div className="refd-code-box">
        <span className="refd-code">{stats.code || '...'}</span>
        <button className="refd-copy-btn" onClick={handleCopy}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>

      {/* Stats Row */}
      <div className="refd-stats">
        <div className="refd-stat">
          <span className="refd-stat-value">{stats.totalReferrals}</span>
          <span className="refd-stat-label">Referrals</span>
        </div>
        <div className="refd-stat">
          <span className="refd-stat-value">{stats.totalChipsEarned.toLocaleString()}</span>
          <span className="refd-stat-label">Chips Earned</span>
        </div>
      </div>

      {/* Milestones */}
      <div className="refd-milestones">
        {milestones.map((m) => (
          <div key={m.count} className={`refd-milestone ${m.unlocked ? 'refd-unlocked' : ''}`}>
            <span className="refd-ms-icon">{m.unlocked ? '✅' : '🔒'}</span>
            <span className="refd-ms-label">{m.label}</span>
            <span className="refd-ms-reward">{m.reward.toLocaleString()} chips</span>
          </div>
        ))}
      </div>

      {/* Share Button */}
      <button className="refd-share-btn" onClick={handleShare}>
        Invite Friends
      </button>
    </div>
  );
}
