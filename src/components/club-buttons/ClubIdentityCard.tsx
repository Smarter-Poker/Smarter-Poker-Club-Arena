import type { ReactNode } from 'react';
import { useFitText } from '../lobby/game-cards/useFitText';
import './ClubIdentityCard.css';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CLUB IDENTITY CARD — Dan's 2026-09-04 master, `kingfish-v1`
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-04: "YOU NEED TO MAKE THE CLUB CARD LOOK EXACTLY LIKE THIS."
 * The attached master is a 1566 x 672 plate: clubs chip crest top centre,
 * the player's poker alias as the headline, the club and player IDs under it
 * beside their painted house / person icons, the referral copy frame top
 * right, "N PLAYING NOW" and the blue LEVEL plate bottom right. There is no
 * club name and no club logo on it - the lobby header already says whose
 * club this is - so those props are kept for callers and the name is spoken
 * to assistive tech only.
 *
 * Built the way every layered card is built: the master with its dynamic
 * words lifted out is the chassis (`kingfish-v1/chassis.png`, transparent
 * outside the chrome), and live DOM text is printed into coordinates
 * measured on the master. Sizes are in cqw against the card, so a 320px
 * phone and a 430px one get the same picture. The share button, the two ID
 * lines and the level are real semantic controls sitting on the paint.
 *
 * The old master (`club-identity-template-no-level-v6.png`) and its sizing
 * helpers (`clubNameSizeCqw`, `fittedNameSizeCqw`, `fittedPlayingSizeCqw`)
 * are retired with this: the alias and the count are fitted by measurement
 * (`useFitText`), like every card title.
 */

const assetRoot = `${import.meta.env.BASE_URL}assets/club-buttons/club/kingfish-v1`;
export const CLUB_IDENTITY_SHELL = `${assetRoot}/chassis.png`;

export const CLUB_IDENTITY_CANVAS = { width: 1566, height: 672 } as const;

interface Zone {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Pixel coordinates on the 1566 x 672 master. */
export const CLUB_IDENTITY_ZONES = {
  alias: { x: 240, y: 205, width: 570, height: 145 },
  clubId: { x: 290, y: 374, width: 440, height: 74 },
  clubIdText: { x: 388, y: 380, width: 340, height: 62 },
  playerId: { x: 290, y: 458, width: 440, height: 74 },
  playerIdText: { x: 388, y: 464, width: 340, height: 62 },
  playing: { x: 880, y: 380, width: 182, height: 62 },
  level: { x: 990, y: 466, width: 325, height: 66 },
  /* The arena rail sits over BOTH of the two zones above. A chip club's
     master paints "PLAYING NOW" beside the count and carries a level plate;
     an arena has neither, so its rail is opaque and covers that paint rather
     than printing over it. The playing zone starts two pixels above the share
     button's bottom edge, so covering it fully means clipping that corner: the
     rail is painted BEFORE the button, which keeps the button on top and keeps
     the 44px target its ::after already guarantees. */
  arenaStats: { x: 852, y: 374, width: 494, height: 184 },
  share: { x: 1064, y: 188, width: 226, height: 194 },
} satisfies Record<string, Zone>;

function zoneStyle(zone: Zone) {
  return {
    left: `${(zone.x / CLUB_IDENTITY_CANVAS.width) * 100}%`,
    top: `${(zone.y / CLUB_IDENTITY_CANVAS.height) * 100}%`,
    width: `${(zone.width / CLUB_IDENTITY_CANVAS.width) * 100}%`,
    height: `${(zone.height / CLUB_IDENTITY_CANVAS.height) * 100}%`,
  };
}

export interface ClubIdentityCardProps {
  clubName: string;
  /** Accepted for callers; the 2026-09-04 master carries no club logo. */
  logoUrl?: string | null;
  logoFallback?: ReactNode;
  pokerAlias: string;
  clubId: string | number;
  playerId?: string | number | null;
  /** A new club shows Level 1 from day one; the level sits in the blue plate. */
  level?: number | null;
  playersPlaying?: number | null;
  /**
   * Diamond Arena, Dan 2026-09-11: "HAVE IT SAY JUST 'ACTIVE' AND THE NUMBER
   * UNDER IT. AND THE FREE ROLL STARTS CLOCK."
   *
   * The arena is one open club: it has no join code to level up and no
   * membership to count, so neither the painted "PLAYING NOW" rail nor the
   * level plate says anything true there. Passing this replaces both with the
   * two figures that do: who is playing now, and when the next free seat is.
   */
  arenaStats?: {
    activeCount: number | null;
    freerollText: string;
    freerollTitle: string;
    freerollImminent?: boolean;
  } | null;
  onCopyClubId?: () => void;
  onCopyPlayerId?: () => void;
  onShare?: () => void;
  /** Accepted for callers; the copy frame is painted into the master. */
  shareIcon?: ReactNode;
  className?: string;
}

function IdentityLine({
  zone,
  textZone,
  accessibleLabel,
  value,
  onCopy,
}: {
  zone: Zone;
  textZone: Zone;
  accessibleLabel: string;
  value: string | number;
  onCopy?: () => void;
}) {
  const ref = useFitText<HTMLElement>(String(value));
  /* The text zone is measured on the master like everything else, but it
     lives INSIDE the line's own box, so its offsets are relative to that. */
  const inner = {
    left: `${((textZone.x - zone.x) / zone.width) * 100}%`,
    top: `${((textZone.y - zone.y) / zone.height) * 100}%`,
    width: `${(textZone.width / zone.width) * 100}%`,
    height: `${(textZone.height / zone.height) * 100}%`,
  };
  const text = (
    <span className="club-identity__line-text" style={inner}>
      <strong ref={ref}>
        <span>ID:</span> {value}
      </strong>
    </span>
  );
  return onCopy ? (
    <button
      type="button"
      className="club-identity__line"
      style={zoneStyle(zone)}
      onClick={onCopy}
      title={`Copy ${accessibleLabel}`}
      aria-label={`Copy ${accessibleLabel} ${value}`}
    >
      {text}
    </button>
  ) : (
    <div className="club-identity__line" style={zoneStyle(zone)} aria-label={accessibleLabel}>
      {text}
    </div>
  );
}

export function ClubIdentityCard({
  clubName,
  pokerAlias,
  clubId,
  playerId,
  level,
  playersPlaying,
  arenaStats,
  onCopyClubId,
  onCopyPlayerId,
  onShare,
  className = '',
}: ClubIdentityCardProps) {
  const aliasRef = useFitText<HTMLElement>(pokerAlias, 1, 0.3);
  const playingRef = useFitText<HTMLElement>(String(playersPlaying ?? ''), 1, 0.5);
  const count = playersPlaying == null ? '0' : playersPlaying.toLocaleString();

  return (
    <section
      className={`club-identity ${className}`.trim()}
      aria-label={`${clubName} Club Identity`}
    >
      <img
        className="club-identity__shell"
        src={CLUB_IDENTITY_SHELL}
        alt=""
        aria-hidden="true"
        draggable={false}
      />

      {/* The club's name is spoken, not painted: the master has no name band
          and the lobby header above the card already carries it. */}
      <h2 className="club-identity__name sr-only">{clubName}</h2>

      <p
        className="club-identity__alias"
        style={zoneStyle(CLUB_IDENTITY_ZONES.alias)}
        title={pokerAlias}
      >
        <span ref={aliasRef}>{pokerAlias}</span>
      </p>

      <div className="club-identity__ids">
        <IdentityLine
          zone={CLUB_IDENTITY_ZONES.clubId}
          textZone={CLUB_IDENTITY_ZONES.clubIdText}
          accessibleLabel="Club ID"
          value={clubId}
          onCopy={onCopyClubId}
        />
        <IdentityLine
          zone={CLUB_IDENTITY_ZONES.playerId}
          textZone={CLUB_IDENTITY_ZONES.playerIdText}
          accessibleLabel="Player ID"
          value={playerId ?? '-'}
          onCopy={onCopyPlayerId}
        />
      </div>

      <div className="club-identity__footer">
        {!arenaStats && (
          /* The count only; PLAYING NOW is painted beside it on the master. */
          <span
            className="club-identity__playing"
            style={zoneStyle(CLUB_IDENTITY_ZONES.playing)}
            aria-live="polite"
            aria-label={`${count} Playing Now`}
          >
            <strong ref={playingRef}>{count}</strong>
          </span>
        )}

        {arenaStats && (
          <span className="club-identity__arena" style={zoneStyle(CLUB_IDENTITY_ZONES.arenaStats)}>
            <span className="club-identity__arena-stat">
              <span className="club-identity__arena-label">ACTIVE</span>
              <strong className="club-identity__arena-value" aria-live="polite">
                {arenaStats.activeCount == null ? '0' : arenaStats.activeCount.toLocaleString()}
              </strong>
            </span>
            <span
              className={`club-identity__arena-stat${
                arenaStats.freerollImminent ? ' club-identity__arena-stat--imminent' : ''
              }`}
              title={arenaStats.freerollTitle}
            >
              <span className="club-identity__arena-label">NEXT FREEROLL</span>
              <strong
                className="club-identity__arena-value club-identity__arena-value--timer"
                role="timer"
                aria-live="off"
                aria-label={`Next Freeroll Starts In ${arenaStats.freerollText}`}
              >
                {arenaStats.freerollText}
              </strong>
            </span>
          </span>
        )}

        {level != null && !arenaStats && (
          <span className="club-identity__level" style={zoneStyle(CLUB_IDENTITY_ZONES.level)}>
            <span>Level {level}</span>
          </span>
        )}

        <button
          type="button"
          className="club-identity__share"
          style={zoneStyle(CLUB_IDENTITY_ZONES.share)}
          onClick={onShare}
          aria-label="Copy Referral Link"
          title="Copy Referral Link"
        />
      </div>
    </section>
  );
}
