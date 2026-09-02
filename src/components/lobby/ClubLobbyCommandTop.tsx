import type { ReactNode } from 'react';
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
export function ClubLobbyCommandTop({ welcome, controls, campaign }: ClubLobbyCommandTopProps) {
  return (
    <section className="club-lobby-command-top" aria-label="Club Lobby Controls And Promotion">
      <div className="club-lobby-command-top__welcome club-lobby-command-top__welcome--approved-universal">
        {welcome}
      </div>
      <div className="club-lobby-command-top__controls">{controls}</div>
      <div className="club-lobby-command-top__campaign">{campaign}</div>
    </section>
  );
}

export default ClubLobbyCommandTop;
