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

  /**
   * THE STUCK-BANNER BUG (Dan 2026-08-27: "announcements ... sometimes glitch
   * and stay on the screen").
   *
   * `onDismiss` used to be in the auto-dismiss effect's dependency array. Its
   * call site passes an INLINE arrow (`onDismissAnnouncement={() =>
   * setAnnouncement(null)}`) through a parent that re-renders on every engine
   * websocket tick, so the prop had a new identity many times a second. Every
   * one of those re-renders tore the effect down and re-ran it, which cleared
   * the pending auto-dismiss timer and started a fresh full-length one. On a
   * busy table the timer could therefore never reach zero and the banner sat on
   * the felt until the component unmounted.
   *
   * The callback now lives in a ref, so the timer effect depends on `type`
   * alone and runs exactly once per announcement. The identity of the prop is
   * irrelevant. (The call site is ALSO stabilised with useCallback and the
   * parent memoised — belt and braces, because a future prop could re-introduce
   * the churn and this component must not care.)
   */
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // Unmount guard
  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      if (dismissCallbackTimerRef.current) clearTimeout(dismissCallbackTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!type) {
      // (c) The banner is gone; the next announcement must fade IN, not
      // inherit a stale `visible` and appear with no transition. Without this
      // reset an announcement dismissed by the parent left `visible` true.
      setVisible(false);
      return;
    }
    setVisible(true);
    dismissTimerRef.current = setTimeout(
      () => {
        dismissTimerRef.current = null;
        setVisible(false);
        dismissCallbackTimerRef.current = setTimeout(() => {
          dismissCallbackTimerRef.current = null;
          onDismissRef.current();
        }, 500); // Wait for fade-out
      },
      // Dan 2026-08-23: a level change is INFORMATION, not an event. It gets
      // the short banner treatment and gets out of the way; the moments that
      // genuinely deserve the table's full attention keep the long beat.
      type === 'level_up' ? 2600 : type === 'mystery_bounty_revealed' ? 5000 : 4000
    );
    return () => {
      // (b) BOTH timers. The cleanup used to clear only the outer one, so a
      // type change during the 500ms fade left the inner callback armed and it
      // dismissed the announcement that had just replaced it.
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
        dismissTimerRef.current = null;
      }
      if (dismissCallbackTimerRef.current) {
        clearTimeout(dismissCallbackTimerRef.current);
        dismissCallbackTimerRef.current = null;
      }
    };
  }, [type]);

  if (!type) return null;

  /* BRAND INK ONLY (#ClubArenaConsole, 2026-09-13). The accent each beat
     paints its title, icon glow and rule in is a smarter.poker schema colour:
     brass #d6ad52 (the warm accent), brand gold #ffd700, the lit blue #45adff
     the console prints numerals in, the house green #3fb950 and the accent
     red #f02849. The amber, orange, yellow and slate that used to sit here
     were nobody's colours. This overlay is felt cinematics, not a card, so it
     is inked rather than framed - the same ruling BombPotOverlay carries. */
  const config: Record<string, { icon: string; title: string; subtitle: string; color: string }> = {
    hand_for_hand: {
      icon: 'H',
      title: 'HAND FOR HAND',
      subtitle: 'All Tables Play One Hand At A Time - Bubble Approaching!',
      color: '#d6ad52',
    },
    bubble_burst: {
      icon: '$',
      title: 'BUBBLE BURST!',
      subtitle: 'Congratulations - All Remaining Players Are In The Money!',
      color: '#3fb950',
    },
    final_table: {
      icon: 'FT',
      title: 'FINAL TABLE',
      subtitle: `${data?.playersRemaining || 'All'} Players Remain - Final Table Begins!`,
      color: '#ffd700',
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
      color: '#45adff',
    },
    bounty_collected: {
      icon: '◎',
      title: data?.mode === 'pko' ? 'BOUNTY CLAIMED' : 'KNOCKOUT!',
      subtitle: (() => {
        // Title Case, like every other line on this overlay (popup law, Dan
        // 2026-08-20). These two dynamic lines were the only ones printed in
        // lower case.
        const who = data?.knockerName || 'A Player';
        const victim = data?.eliminatedName
          ? ` Knocked Out ${data.eliminatedName}`
          : ' Scored A Knockout';
        const amt = data?.amount != null ? ` - Collected ${data.amount}` : '';
        const head = data?.addedToHead > 0 ? ` (+${data.addedToHead} Onto Their Own Head)` : '';
        return `${who}${victim}${amt}${head}`;
      })(),
      color: '#f02849',
    },
    mystery_bounty_revealed: {
      icon: '◈',
      title: 'MYSTERY BOUNTY!',
      subtitle: (() => {
        const who = data?.knockerName || 'A Player';
        const victim = data?.playerName || data?.eliminatedName;
        const amt = data?.amount != null ? `${data.amount}` : 'A Mystery Prize';
        const big =
          data?.avgBounty && data?.amount && Number(data.amount) >= Number(data.avgBounty) * 3
            ? ' - JACKPOT!'
            : '';
        return victim
          ? `${who} Opened ${victim}'s Envelope: ${amt}${big}`
          : `${who} Revealed ${amt}${big}`;
      })(),
      color: '#ffd700',
    },
    seven_deuce_bounty: {
      icon: '72',
      title: 'SEVEN-DEUCE BOUNTY',
      subtitle: data?.winnerName
        ? `${data.winnerName} Won With 7-2 - Collected ${data?.amount ?? ''} From The Table`
        : `Won With 7-2 - Collected ${data?.amount ?? ''} From The Table`,
      color: '#f02849',
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
