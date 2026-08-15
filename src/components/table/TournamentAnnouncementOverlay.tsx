import React, { useState, useEffect, useRef } from 'react';
import './TournamentAnnouncementOverlay.css';

interface TournamentAnnouncementProps {
  type:
    | 'hand_for_hand'
    | 'bubble_burst'
    | 'final_table'
    | 'level_up'
    | 'seven_deuce_bounty'
    | 'bounty_collected'
    | 'mystery_bounty_revealed'
    | null;
  data?: any;
  onDismiss: () => void;
}

const TournamentAnnouncementOverlay: React.FC<TournamentAnnouncementProps> = ({
  type,
  data,
  onDismiss,
}) => {
  const [visible, setVisible] = useState(false);
  // CA-5 BUG FIX: the inner setTimeout(onDismiss, 500) inside the outer auto-dismiss
  // callback had no ref — clearTimeout(timer) on the outer one doesn't cancel it.
  // Added dismissCallbackTimerRef so unmount cancels both.
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissCallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Unmount guard
  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      if (dismissCallbackTimerRef.current) clearTimeout(dismissCallbackTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (type) {
      setVisible(true);
      dismissTimerRef.current = setTimeout(
        () => {
          setVisible(false);
          dismissCallbackTimerRef.current = setTimeout(onDismiss, 500); // Wait for fade-out
        },
        type === 'level_up' ? 2000 : type === 'mystery_bounty_revealed' ? 5000 : 4000
      );
      return () => {
        if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      };
    }
  }, [type, onDismiss]);

  if (!type) return null;

  const config: Record<string, { icon: string; title: string; subtitle: string; color: string }> = {
    hand_for_hand: {
      icon: 'H',
      title: 'HAND FOR HAND',
      subtitle: 'All tables play one hand at a time — bubble approaching!',
      color: '#f59e0b',
    },
    bubble_burst: {
      icon: '$',
      title: 'BUBBLE BURST!',
      subtitle: 'Congratulations — all remaining players are in the money!',
      color: '#10b981',
    },
    final_table: {
      icon: '*',
      title: 'FINAL TABLE',
      subtitle: `${data?.playersRemaining || 'All'} players remain — final table begins!`,
      color: '#8b5cf6',
    },
    level_up: {
      icon: '⬆',
      title: `LEVEL ${data?.level || 1}`,
      subtitle: `Blinds: ${data?.smallBlind ?? '—'}/${data?.bigBlind ?? '—'}${data?.ante ? ` Ante: ${data.ante}` : ''}`,
      color: '#3b82f6',
    },
    bounty_collected: {
      icon: '\u{1F3AF}',
      title: data?.mode === 'pko' ? 'BOUNTY CLAIMED' : 'KNOCKOUT!',
      subtitle: (() => {
        const who = data?.knockerName || 'A player';
        const victim = data?.eliminatedName
          ? ` knocked out ${data.eliminatedName}`
          : ' scored a knockout';
        const amt = data?.amount != null ? ` — collected ${data.amount}` : '';
        const head = data?.addedToHead > 0 ? ` (+${data.addedToHead} onto their own head)` : '';
        return `${who}${victim}${amt}${head}`;
      })(),
      color: '#f97316',
    },
    mystery_bounty_revealed: {
      icon: '\u{1F381}',
      title: 'MYSTERY BOUNTY!',
      subtitle: (() => {
        const who = data?.knockerName || 'A player';
        const victim = data?.playerName || data?.eliminatedName;
        const amt = data?.amount != null ? `${data.amount}` : 'a mystery prize';
        const big =
          data?.avgBounty && data?.amount && Number(data.amount) >= Number(data.avgBounty) * 3
            ? ' — JACKPOT!'
            : '';
        return victim ? `${who} opened ${victim}'s envelope: ${amt}${big}` : `${who} revealed ${amt}${big}`;
      })(),
      color: '#eab308',
    },
    seven_deuce_bounty: {
      icon: '72',
      title: 'SEVEN-DEUCE BOUNTY',
      subtitle: data?.winnerName
        ? `${data.winnerName} won with 7-2 — collected ${data?.amount ?? ''} from the table`
        : `Won with 7-2 — collected ${data?.amount ?? ''} from the table`,
      color: '#ef4444',
    },
  };

  const c = config[type] || config.level_up;

  return (
    <div
      className={`tournamentAnnouncement ${visible ? 'visible' : ''}`}
      style={{ '--accent-color': c.color } as React.CSSProperties}
    >
      <div className="announcementContent">
        <div className="announcementIcon">{c.icon}</div>
        <div className="announcementTitle">{c.title}</div>
        <div className="announcementSubtitle">{c.subtitle}</div>
      </div>
    </div>
  );
};

export default TournamentAnnouncementOverlay;
