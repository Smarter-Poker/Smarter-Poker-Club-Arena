/**
 * ♠ CLUB ARENA — AvatarCosmetics
 *
 * The single overlay that draws an equipped frame and/or aura on top of an
 * avatar. Purely presentational: two absolutely-positioned, pointer-events-none
 * siblings that sit inside whatever element already clips the avatar.
 *
 * USAGE — the parent must be `position: relative` and must own the border
 * radius. This component inherits both, so it is correct on the round header
 * orb and on the rounded-rect seat portrait without knowing which it is in.
 *
 *   <div style={{ position: 'relative' }}>
 *     <img src={avatar} />
 *     <AvatarCosmetics frame={p.frame} aura={p.aura} />
 *   </div>
 *
 * An unknown or retired token renders NOTHING (see resolveCosmetic). A player
 * whose row holds a token this build has never heard of sees a plain avatar,
 * not a broken one.
 */

import React from 'react';
import { cosmeticClassName } from '../../cosmetics/avatarCosmetics';
import './AvatarCosmetics.css';

export interface AvatarCosmeticsProps {
  frame?: string | null;
  aura?: string | null;
  /**
   * Suppresses the aura's animation. Set on dense surfaces — a nine-handed felt
   * would otherwise run up to nine infinite keyframe loops at once, and
   * `aura-glitch` repeats every 0.3s.
   */
  still?: boolean;
  className?: string;
}

export const AvatarCosmetics: React.FC<AvatarCosmeticsProps> = ({
  frame,
  aura,
  still = false,
  className = '',
}) => {
  const frameClass = cosmeticClassName(frame, 'frame');
  const auraClass = cosmeticClassName(aura, 'aura');

  if (!frameClass && !auraClass) return null;

  return (
    <>
      {auraClass && (
        <span
          aria-hidden="true"
          className={`sp-cosmetic sp-cosmetic--aura ${auraClass} ${
            still ? 'sp-cosmetic--still' : ''
          } ${className}`.trim()}
        />
      )}
      {frameClass && (
        <span
          aria-hidden="true"
          className={`sp-cosmetic sp-cosmetic--frame ${frameClass} ${className}`.trim()}
        />
      )}
    </>
  );
};

export default AvatarCosmetics;
