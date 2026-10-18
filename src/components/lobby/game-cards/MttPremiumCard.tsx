import { useTournamentCardText } from './useTournamentCardText';
import type { ArenaGameCardActions, ArenaGameCardData } from './arenaGameCardTypes';
import { zoneText } from './arenaGameCardTypes';
import { useFitText } from './useFitText';
import './MttPremiumCard.css';
import { useLayoutEffect, useRef, useState } from 'react';

function Fitted({ text, enabled }: { text: string; enabled: boolean }) {
  const ref = useFitText<HTMLSpanElement>(text, 1, 0.35, { enabled });
  return (
    <span ref={ref} className="agc-mtt-premium__fit">
      {text}
    </span>
  );
}

/** One native-ratio chassis. Every live value occupies its own measured face. */
export function MttPremiumCard({
  data,
  actions,
}: {
  data: ArenaGameCardData;
  actions: ArenaGameCardActions;
}) {
  const { phase, destination } = useTournamentCardText(data);
  const cardRef = useRef<HTMLDivElement>(null);
  const [fitReady, setFitReady] = useState(false);
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const margin = window.innerHeight;
    // Keep every card and action mounted. Only the thousands of text layout
    // measurements below the fold wait until their card approaches the screen.
    if (
      (rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom >= -margin &&
        rect.top <= window.innerHeight + margin) ||
      typeof IntersectionObserver === 'undefined'
    ) {
      setFitReady(true);
      return;
    }
    let disposed = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (disposed || !entries.some((entry) => entry.target === card && entry.isIntersecting))
          return;
        setFitReady(true);
        observer.disconnect();
      },
      { rootMargin: `${margin}px 0px` }
    );
    observer.observe(card);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, []);
  const titleRef = useFitText<HTMLHeadingElement>(data.title, 1, 0.45, {
    enabled: fitReady,
    wrapBelow: 0.95,
    maxLines: 2,
  });
  const metrics = [
    ['startingTime', 'Starting Time', data.startTime],
    ['buyIn', 'Buy-In', data.buyIn],
    ['guarantee', 'Guarantee', data.guarantee],
    ['registered', 'Registered', data.registered],
    ['startingStack', 'Starting Stack', data.startingStack],
    ['currentLevel', 'Current Level', data.currentLevel],
  ] as const;
  return (
    <div ref={cardRef} className="agc-mtt-premium">
      <img
        className="agc-mtt-premium__chassis"
        src={`${import.meta.env.BASE_URL}assets/club-buttons/game-cards/mtt/cash-style-v3/chassis.png`}
        alt=""
        aria-hidden="true"
        draggable={false}
      />
      <header className="agc-mtt-premium__header">
        <h3 ref={titleRef} title={data.title} data-zone="title">
          {data.title}
        </h3>
        <div className="agc-mtt-premium__status" data-zone="status">
          <Fitted
            enabled={fitReady}
            text={[data.registeredByViewer ? 'Registered' : '', phase].filter(Boolean).join(' · ')}
          />
        </div>
        {destination && (
          <div className="agc-mtt-premium__destination" data-zone="satelliteDestination">
            <Fitted enabled={fitReady} text={destination} />
          </div>
        )}
      </header>
      {metrics.map(([zone, label, value], index) => (
        <div
          key={zone}
          data-zone={zone}
          className={`agc-mtt-premium__bay agc-mtt-premium__bay--${index}`}
        >
          <span className="agc-mtt-premium__label">{label}</span>
          <strong>
            <Fitted enabled={fitReady} text={zoneText(zone, value)} />
          </strong>
          {zone === 'currentLevel' && data.currentBlinds && <small>{data.currentBlinds}</small>}
        </div>
      ))}
      {actions.secondaryLabel && (
        <button
          type="button"
          data-zone="secondaryAction"
          className="agc-mtt-premium__action agc-mtt-premium__action--secondary"
          onClick={actions.onSecondary}
        >
          <Fitted enabled={fitReady} text={actions.secondaryLabel} />
        </button>
      )}
      <button
        type="button"
        data-zone="primaryAction"
        className={`agc-mtt-premium__action agc-mtt-premium__action--primary agc-mtt-premium__action--${actions.primaryTone || 'blue'}`}
        disabled={actions.primaryDisabled || actions.busy}
        onClick={actions.onPrimary}
      >
        <Fitted enabled={fitReady} text={actions.busy ? 'Working...' : actions.primaryLabel} />
      </button>
    </div>
  );
}
