import { useLayoutEffect, useRef, type ReactNode } from 'react';
import './ClubLobbyCommandTop.css';

interface ClubLobbyCommandTopProps {
  welcome: ReactNode;
  controls: ReactNode;
  campaign: ReactNode;
}

/**
 * Live content for the Club Arena controls and campaign. ClubHomePage places
 * this real DOM in the desktop workspace or mobile stack; the supplied design
 * is never mounted as a screenshot behind it.
 */
/**
 * THE DECK PUBLISHES WHERE IT ENDS (Dan 2026-09-09): the filter row "should
 * lock under the FIND YOUR GAME row when it scrolls up, it should not be able
 * to scroll past that."
 *
 * The controls block is already pinned under the global header on a phone
 * (ClubLobbyCommandTop.css, MOBILE FIND-YOUR-GAME LOCK), and the sort row has
 * to pin directly beneath it. Its height is not a constant that CSS could
 * carry: the selector deck grows and shrinks with the tab, the club and the
 * viewer's role - four rows on NLH, three when there is no Filters button, more
 * again when an operator gets the create actions.
 *
 * So it is measured and published to the document root as
 * `--ca-lobby-controls-h`, exactly as GlobalHeader publishes its own height as
 * `--ca-global-header-height`, and LobbySortBar.css adds the two together. A
 * layout effect writes it before paint; a ResizeObserver keeps it true through
 * a tab change, a rotation or a font resize; unmount clears it so a route
 * without this deck cannot inherit the last value it happened to see.
 */
const LOBBY_CONTROLS_HEIGHT_VAR = '--ca-lobby-controls-h';

export function ClubLobbyCommandTop({ welcome, controls, campaign }: ClubLobbyCommandTopProps) {
  const controlsRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const el = controlsRef.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = () =>
      root.style.setProperty(LOBBY_CONTROLS_HEIGHT_VAR, `${el.getBoundingClientRect().height}px`);

    publish();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
    observer?.observe(el);
    window.addEventListener('resize', publish, { passive: true });

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', publish);
      root.style.removeProperty(LOBBY_CONTROLS_HEIGHT_VAR);
    };
  }, []);

  return (
    <section className="club-lobby-command-top" aria-label="Club Lobby Controls And Promotion">
      <div className="club-lobby-command-top__welcome club-lobby-command-top__welcome--approved-universal">
        {welcome}
      </div>
      <div className="club-lobby-command-top__controls" ref={controlsRef}>
        {controls}
      </div>
      <div className="club-lobby-command-top__campaign">{campaign}</div>
    </section>
  );
}

export default ClubLobbyCommandTop;
