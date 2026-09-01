import { useMemo, useState } from 'react';
import { ClubIdentityCard } from '../../components/club-buttons/ClubIdentityCard';
import { ClubLobbyCommandTop } from '../../components/lobby/ClubLobbyCommandTop';
import {
  ArenaGameCard,
  NLH_PREMIUM_ASSETS,
  type ArenaGameCardActions,
  type ArenaGameCardData,
} from '../../components/lobby/game-cards';
import { ClubBBJShell } from '../../components/wallet/ClubWalletArtwork';
import '../ClubHomePage.css';
import '../../components/lobby/ClubLobbyCommandTop.css';
import './ArenaGameCardsShowcasePage.css';

const MOBILE_REVIEW_ROOT = `${import.meta.env.BASE_URL}`;

const NLH_REFERENCE_DATA: ArenaGameCardData = {
  id: 'nlh-reference-calibration',
  family: 'nlh',
  title: 'NLH 25/50',
  subtitle: 'Insurance Test',
  gameType: 'NLH',
  stakes: '25/50',
  players: '3/6',
  buyIn: '2,000 - 10,000',
  status: 'running',
  statusLabel: 'Running',
  rules: [],
};

const NLH_SECONDARY_DATA: ArenaGameCardData = {
  ...NLH_REFERENCE_DATA,
  id: 'nlh-secondary-calibration',
  title: 'NLH 10/20',
  subtitle: 'Deep Stack Cash',
  stakes: '10/20',
  players: '5/8',
  buyIn: '800 - 4,000',
};

function LiveNlhCard({
  actions,
  className,
  data = NLH_REFERENCE_DATA,
}: {
  actions: ArenaGameCardActions;
  className?: string;
  data?: ArenaGameCardData;
}) {
  return (
    <ArenaGameCard
      data={data}
      actions={actions}
      presentation="mobile"
      skin="spade-nlh-premium-v1"
      className={className}
    />
  );
}

function ClubLinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.5 14.5 14.5 9.5M7.2 16.8l-1 1a3.4 3.4 0 0 0 4.8 4.8l3.2-3.2a3.4 3.4 0 0 0 0-4.8M16.8 7.2l1-1A3.4 3.4 0 0 0 13 1.4L9.8 4.6a3.4 3.4 0 0 0 0 4.8"
      />
    </svg>
  );
}

function MobileLobbyReview({
  actions,
  lastAction,
}: {
  actions: ArenaGameCardActions;
  lastAction: string;
}) {
  const [walletsOpen, setWalletsOpen] = useState(false);
  const gameTypes = ['All', 'MTT', 'NLH', 'PLO', 'Limit', 'Spins', 'Heads Up'];
  const statuses = ['All', 'Full', 'Empty', 'Open Seats', 'Favorites'];

  return (
    <main className="agc-mobile-page">
      <output className="agc-mobile-handler-output" aria-live="polite">
        {lastAction}
      </output>
      <section className="agc-mobile-sessionbar" aria-label="Open Table Tabs">
        <button type="button" aria-label="Open Table Menu">
          <span />
          <span />
          <span />
        </button>
        <span className="agc-mobile-sessionbar__tab">
          <strong>NLH</strong>
          <small>25/50</small>
        </span>
        <button
          type="button"
          className="agc-mobile-sessionbar__add"
          aria-label="Open Another Table"
        >
          +
        </button>
      </section>

      <section className="agc-mobile-unified-shell" aria-label="Shark Club Lobby Controls">
        <section className="club-mobile-welcome" aria-labelledby="mobile-review-club-name">
          <span>Welcome To The</span>
          <h1 id="mobile-review-club-name">Shark Club</h1>
        </section>

        <section className="club-mobile-owner-message" aria-label="Club Owner Message">
          <button type="button" className="club-mobile-owner-message__copy" disabled>
            Welcome To The Shark Club, All Fish Of All Shapes And Sizes Are Welcome!
          </button>
        </section>

        <header className="lobby-top">
          <div className="lobby-top__main">
            <ClubIdentityCard
              className="lobby-top__identity"
              clubName="Shark Club"
              logoUrl={`${MOBILE_REVIEW_ROOT}images/shark-club-logo.jpg`}
              pokerAlias="Dan Bekavac"
              clubId="25450"
              playerId="1"
              level={29}
              playersPlaying={223}
              shareIcon={<ClubLinkIcon />}
            />

            <button type="button" className="lobby-bbj" aria-label="Bad Beat Jackpot: 93,293.98">
              <ClubBBJShell className="lobby-bbj__shell" />
              <span className="lobby-bbj__label">Bad Beat Jackpot</span>
              <strong className="lobby-bbj__amount">93,293.98</strong>
            </button>

            <div className="lobby-top__wallet">
              <button
                type="button"
                className="lobby-wallets-trigger"
                aria-expanded={walletsOpen}
                onClick={() => setWalletsOpen((open) => !open)}
              >
                <span className="lobby-wallets-trigger__icon" aria-hidden="true" />
                <span className="lobby-wallets-trigger__copy">
                  <strong>My Wallets</strong>
                  <small>3 Balances</small>
                </span>
                <span
                  className={`lobby-wallets-trigger__chevron ${walletsOpen ? 'is-expanded' : ''}`}
                  aria-hidden="true"
                />
              </button>
              <div className="agc-mobile-wallet-list" data-expanded={walletsOpen}>
                {[
                  ['Player Wallet', '80,000.00'],
                  ['Diamonds', '493,640'],
                  ['Club Bank', '1,376,610.47'],
                ].map(([label, value]) => (
                  <button type="button" key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </header>

        <section className="club-lobby-machine" aria-label="Shark Club Game Lobby">
          <ClubLobbyCommandTop
            welcome={<span />}
            controls={
              <section className="lobby-controls" aria-label="Browse Games">
                <div className="lobby-controls__heading">
                  <div>
                    <span className="lobby-controls__eyebrow">Live Club Schedule</span>
                    <strong className="lobby-controls__title">Find Your Game</strong>
                  </div>
                  <span className="lobby-controls__total">
                    <strong>135</strong> Games
                  </span>
                </div>
                <div className="game-bar">
                  <div className="game-bar__types" role="tablist" aria-label="Game Type">
                    {gameTypes.map((type) => (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={type === 'NLH'}
                        className={`game-bar__type ${type === 'NLH' ? 'is-active' : ''}`}
                        key={type}
                      >
                        {type}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="game-bar__filter-btn"
                    aria-label="Filters And Sort"
                  >
                    <span className="agc-mobile-filter-icon" aria-hidden="true" />
                    <span>Filters</span>
                  </button>
                </div>
                <div className="quickprefs">
                  <div className="quickprefs__row quickprefs__row--status" aria-label="Game Status">
                    {statuses.map((status) => (
                      <button
                        type="button"
                        className={`quickprefs__chip ${status === 'All' ? 'is-on' : ''}`}
                        aria-pressed={status === 'All'}
                        key={status}
                      >
                        {status}
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            }
            campaign={
              <button type="button" className="club-lobby-command-top__campaign-button">
                <img
                  src={`${MOBILE_REVIEW_ROOT}assets/club-buttons/lobby/shark-club-championship-ad-mobile-v4.png`}
                  alt="Shark Club Championship Series, 250,000 Guaranteed Main Event"
                />
              </button>
            }
          />
        </section>
      </section>

      <div className="agc-mobile-lobby-games">
        <LiveNlhCard actions={actions} />
        <LiveNlhCard actions={actions} data={NLH_SECONDARY_DATA} />
      </div>
    </main>
  );
}

function ReferenceStage({ label }: { label: string }) {
  return (
    <figure className="agc-calibration__figure">
      <figcaption>{label}</figcaption>
      <div className="agc-calibration__stage">
        <img src={NLH_PREMIUM_ASSETS.reference} alt="Approved NLH 25/50 Reference" />
      </div>
    </figure>
  );
}

function LiveStage({
  actions,
  label,
  className,
}: {
  actions: ArenaGameCardActions;
  label: string;
  className?: string;
}) {
  return (
    <figure className={`agc-calibration__figure${className ? ` ${className}` : ''}`}>
      <figcaption>{label}</figcaption>
      <div className="agc-calibration__stage agc-calibration__live">
        <LiveNlhCard actions={actions} />
      </div>
    </figure>
  );
}

export default function ArenaGameCardsShowcasePage() {
  const [lastAction, setLastAction] = useState('No interaction yet');
  const actions = useMemo<ArenaGameCardActions>(
    () => ({
      secondaryLabel: 'View Table',
      primaryLabel: 'Join Table',
      onSecondary: () => setLastAction('VIEW TABLE handler fired'),
      onPrimary: () => setLastAction('JOIN TABLE handler fired'),
    }),
    []
  );

  if (new URLSearchParams(window.location.search).get('review') === 'mobile') {
    return <MobileLobbyReview actions={actions} lastAction={lastAction} />;
  }

  return (
    <main className="agc-calibration">
      <header className="agc-calibration__header">
        <div>
          <p>NLH Production Reconstruction · 729 × 945 Master</p>
          <h1>Approved Artwork, Live Values, Real Hit Targets</h1>
        </div>
        <output aria-live="polite">{lastAction}</output>
      </header>

      <section className="agc-calibration__section" aria-labelledby="comparison-title">
        <div className="agc-calibration__section-heading">
          <span>01</span>
          <div>
            <h2 id="comparison-title">430px Side-By-Side Comparison</h2>
            <p>The Live Card Uses The Exact Sample Values From The Approved Source.</p>
          </div>
        </div>
        <div className="agc-calibration__pair">
          <ReferenceStage label="Approved Reference" />
          <LiveStage actions={actions} label="Actual Live 430px Render" />
        </div>
      </section>

      <section className="agc-calibration__section" aria-labelledby="asset-pack-title">
        <div className="agc-calibration__section-heading">
          <span>02</span>
          <div>
            <h2 id="asset-pack-title">Static Premium Asset Set</h2>
            <p>Chassis, State Art, Type Plaque, And Button Faces Remain Image-Owned.</p>
          </div>
        </div>
        <div className="agc-calibration__assets">
          <figure className="agc-calibration__asset agc-calibration__asset--chassis">
            <img src={NLH_PREMIUM_ASSETS.chassis} alt="NLH Premium Static Chassis" />
            <figcaption>Chassis</figcaption>
          </figure>
          <figure className="agc-calibration__asset">
            <img src={NLH_PREMIUM_ASSETS.statusRunning} alt="Running Status Artwork" />
            <figcaption>Running Status</figcaption>
          </figure>
          <figure className="agc-calibration__asset">
            <img src={NLH_PREMIUM_ASSETS.liveDot} alt="Live Dot Artwork" />
            <figcaption>Live Dot</figcaption>
          </figure>
          <figure className="agc-calibration__asset">
            <img src={NLH_PREMIUM_ASSETS.gameTypeNlh} alt="NLH Game-Type Plaque Artwork" />
            <figcaption>NLH Type Plaque</figcaption>
          </figure>
          <figure className="agc-calibration__asset">
            <img src={NLH_PREMIUM_ASSETS.viewTable} alt="View Table Button Artwork" />
            <figcaption>View Table</figcaption>
          </figure>
          <figure className="agc-calibration__asset">
            <img src={NLH_PREMIUM_ASSETS.joinTable} alt="Join Table Button Artwork" />
            <figcaption>Join Table</figcaption>
          </figure>
        </div>
      </section>
    </main>
  );
}
