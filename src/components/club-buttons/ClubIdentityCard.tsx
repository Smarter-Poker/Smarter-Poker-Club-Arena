import type { ReactNode } from 'react';
import './ClubIdentityCard.css';

/* v3 moved the club and profile icons DOWN 32px so they sit level with the two
   ID lines they label (Dan, 2026-09-01). It is a new filename rather than a new
   copy of v2 because the old file is already in browser and CDN caches, and a
   card whose labels point one line too high is exactly the bug being fixed. */
const CLUB_IDENTITY_SHELL = `${import.meta.env.BASE_URL}assets/club-buttons/club/club-identity-template-no-level-v3.png`;

export interface ClubIdentityCardProps {
  clubName: string;
  logoUrl?: string | null;
  logoFallback?: ReactNode;
  pokerAlias: string;
  clubId: string | number;
  playerId?: string | number | null;
  /** Dan 2026-09-01, binding: the club level renders BELOW the logo inside a
   *  blue box, never overlapping it. A new club shows Level 1 from day one.
   *  (#2509 removed the level after the old placement overlapped the logo;
   *  the order was to move it into a blue box, not to delete it.) */
  level?: number | null;
  playersPlaying?: number | null;
  onCopyClubId?: () => void;
  onCopyPlayerId?: () => void;
  onShare?: () => void;
  shareIcon: ReactNode;
  className?: string;
}

function IdentityLine({
  label,
  accessibleLabel,
  value,
  onCopy,
}: {
  label: string;
  accessibleLabel: string;
  value: string | number;
  onCopy?: () => void;
}) {
  const content = (
    <>
      <span>{label}:</span>
      <strong>{value}</strong>
    </>
  );

  return onCopy ? (
    <button
      type="button"
      className="club-identity__line"
      onClick={onCopy}
      title={`Copy ${accessibleLabel}`}
      aria-label={`Copy ${accessibleLabel} ${value}`}
    >
      {content}
    </button>
  ) : (
    <div className="club-identity__line">{content}</div>
  );
}

export function ClubIdentityCard({
  clubName,
  logoUrl,
  logoFallback,
  pokerAlias,
  clubId,
  playerId,
  level,
  playersPlaying,
  onCopyClubId,
  onCopyPlayerId,
  onShare,
  shareIcon,
  className = '',
}: ClubIdentityCardProps) {
  return (
    <section
      className={`club-identity ${className}`.trim()}
      aria-label={`${clubName} Club Identity`}
    >
      <picture className="club-identity__shell" aria-hidden="true">
        <img src={CLUB_IDENTITY_SHELL} alt="" />
      </picture>

      <div className="club-identity__logo">
        {logoUrl ? <img src={logoUrl} alt={`${clubName} Logo`} loading="lazy" /> : logoFallback}
      </div>

      {level != null && (
        <span className="club-identity__level">
          <span>Level {level}</span>
        </span>
      )}

      <div className="club-identity__details">
        <h2 title={clubName}>{clubName}</h2>
        <p className="club-identity__alias" title={pokerAlias}>
          {pokerAlias}
        </p>
      </div>

      {/* Its own bay, pinned to the artwork icons that label these two lines.
          They used to be rows three and four of the details grid, which meant
          their vertical position was a by-product of the club name's row
          height and drifted away from the icons on every narrower card. */}
      <div className="club-identity__ids">
        <IdentityLine label="ID" accessibleLabel="Club ID" value={clubId} onCopy={onCopyClubId} />
        <IdentityLine
          label="ID"
          accessibleLabel="Player ID"
          value={playerId ?? '-'}
          onCopy={onCopyPlayerId}
        />
      </div>

      <div className="club-identity__footer">
        <span className="club-identity__playing" aria-live="polite">
          <strong>{playersPlaying == null ? '-' : playersPlaying.toLocaleString()}</strong>
          <span>Playing Now</span>
        </span>
        <button
          type="button"
          className="club-identity__share"
          onClick={onShare}
          aria-label="Copy Referral Link"
          title="Copy Referral Link"
        >
          {shareIcon}
        </button>
      </div>
    </section>
  );
}
