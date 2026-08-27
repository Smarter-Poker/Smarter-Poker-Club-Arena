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
        // Dan 2026-08-23: a level change is INFORMATION, not an event. It gets
        // the short banner treatment and gets out of the way; the moments that
        // genuinely deserve the table's full attention keep the long beat.
        type === 'level_up' ? 2600 : type === 'mystery_bounty_revealed' ? 5000 : 4000
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
      subtitle: 'All tables play one hand at a time - bubble approaching!',
      color: '#f59e0b',
    },
    bubble_burst: {
      icon: '$',
      title: 'BUBBLE BURST!',
      subtitle: 'Congratulations - all remaining players are in the money!',
      color: '#3fb950',
    },
    final_table: {
      icon: 'FT',
      title: 'FINAL TABLE',
      subtitle: `${data?.playersRemaining || 'All'} players remain - final table begins!`,
      color: '#d9aa4e',
    },
    level_up: {
      icon: '⬆',
      /**
       * Dan 2026-08-25 (binding): "blind levels on the screen are never
       * increasing... still says LEVEL 1 even though it's clearly LEVEL 2."
       *
       * `data.level` is now the HUMAN level (1-based). It used to be handed
       * straight through from the engine broadcast, where it is the 0-BASED
       * structure index, so this banner was permanently one behind the felt
       * masthead beside it — announcing "LEVEL 1" at the exact moment the
       * blinds became level 2's. The +1 is applied once, at the emit site in
       * TablePage (`level_up` handler), so there is a single place that knows
       * the engine's indexing. Do not add another +1 here.
       *
       * `??` not `||`: a genuine 0 must not be laundered into 1, it must look
       * wrong so the indexing bug cannot hide again.
       */
      title: `LEVEL ${data?.level ?? '-'}`,
      subtitle: `Blinds: ${data?.smallBlind ?? '-'}/${data?.bigBlind ?? '-'}${data?.ante ? ` Ante: ${data.ante}` : ''}`,
      color: '#3b82f6',
    },
    bounty_collected: {
      icon: '◎',
      title: data?.mode === 'pko' ? 'BOUNTY CLAIMED' : 'KNOCKOUT!',
      subtitle: (() => {
        const who = data?.knockerName || 'A player';
        const victim = data?.eliminatedName
          ? ` knocked out ${data.eliminatedName}`
          : ' scored a knockout';
        const amt = data?.amount != null ? ` - collected ${data.amount}` : '';
        const head = data?.addedToHead > 0 ? ` (+${data.addedToHead} onto their own head)` : '';
        return `${who}${victim}${amt}${head}`;
      })(),
      color: '#f97316',
    },
    mystery_bounty_revealed: {
      icon: '◈',
      title: 'MYSTERY BOUNTY!',
      subtitle: (() => {
        const who = data?.knockerName || 'A player';
        const victim = data?.playerName || data?.eliminatedName;
        const amt = data?.amount != null ? `${data.amount}` : 'a mystery prize';
        const big =
          data?.avgBounty && data?.amount && Number(data.amount) >= Number(data.avgBounty) * 3
            ? ' - JACKPOT!'
            : '';
        return victim
          ? `${who} opened ${victim}'s envelope: ${amt}${big}`
          : `${who} revealed ${amt}${big}`;
      })(),
      color: '#eab308',
    },
    seven_deuce_bounty: {
      icon: '72',
      title: 'SEVEN-DEUCE BOUNTY',
      subtitle: data?.winnerName
        ? `${data.winnerName} won with 7-2 - collected ${data?.amount ?? ''} from the table`
        : `Won with 7-2 - collected ${data?.amount ?? ''} from the table`,
      color: '#ef4444',
    },
  };

  const c = config[type] || config.level_up;

  /**
   * Dan 2026-08-23: "when the level goes up there should be a small pop up
   * that announces it and then disappears. Currently it blocks the whole
   * screen."
   *
   * A blind change happens every few minutes for the whole life of a
   * tournament. Blacking out the felt, blurring the cards and stopping the
   * eye for it - which is what the full-bleed treatment did - is the wrong
   * weight for something that routine, and it lands right when a player is
   * trying to read the board. It now rides in as a compact banner at the top
   * of the table: never covers the cards, never blurs anything, never takes
   * pointer events, and leaves on its own.
   *
   * The rare, genuinely dramatic beats - the bubble bursting, the final table
   * forming, a mystery bounty opening - keep the cinematic treatment, because
   * those happen once.
   */
  const compact = type === 'level_up';

  return (
    <div
      className={`tournamentAnnouncement ${compact ? 'compact' : ''} ${type === 'final_table' ? 'finalTableAnnouncement' : ''} ${visible ? 'visible' : ''}`}
      style={{ '--accent-color': c.color } as React.CSSProperties}
      role="status"
      aria-live="polite"
    >
      <div className="announcementContent">
        <div className="announcementIcon">{c.icon}</div>
        <div className="announcementText">
          <div className="announcementTitle">{c.title}</div>
          <div className="announcementSubtitle">{c.subtitle}</div>
        </div>
      </div>
    </div>
  );
};

export default TournamentAnnouncementOverlay;
