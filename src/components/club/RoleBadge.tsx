/**
 * ROLE BADGE
 * ============================================================================
 * Dan 2026-08-23: "the blue dot is for agents currently. Inside the Club Arena
 * create small icon badges instead of dots, we need them for the following
 * roles and this is the hierarchy order: 1 Owner, 2 Co-Owner, 3 Admin,
 * 4 Super Agent, 5 Agent, 6 Sub Agent, 7 Player."
 *
 * WHAT WAS THERE. A bare glyph printed inline before the name, in a palette
 * that had wandered off the brand: #A855F7 purple for super agent, #FF6B6B
 * coral for admin, and a green dot for presence. Two of the seven roles
 * (co_owner, player) had no mark at all, so a co-owner was indistinguishable
 * from a player at a glance.
 *
 * WHAT THIS IS. A real badge: a filled chip carrying a glyph, sized and
 * weighted so the hierarchy reads top to bottom without anyone learning a
 * legend. Rank descends through the palette in one direction -- gold for the
 * two owners, smarter.poker royal blue for the club staff, arena cyan for the
 * three agent tiers, steel for a player -- and the glyph gets simpler as the
 * rank falls: filled star, open star, diamond, triangle, filled circle, open
 * circle, dot.
 *
 * NO GREEN AND NO PURPLE anywhere in here. Presence is drawn by the roster as a
 * separate cyan ring on the avatar, so colour never has to mean two things at
 * once.
 *
 * Glyphs are Unicode geometry, not emoji: emoji break the SWC compiler (house
 * rule 3 / code safety rule 5) and render differently on every platform.
 */

import { ROLE_LABEL, type ClubRole, normaliseRole } from '../../types/clubRoles';
import './RoleBadge.css';

export interface RoleBadgeSpec {
  /** Unicode geometry, never emoji. */
  glyph: string;
  /** Foreground / ring colour. */
  color: string;
  /** Chip fill, always a translucent wash of `color`. */
  wash: string;
  label: string;
}

export const ROLE_BADGE: Record<ClubRole, RoleBadgeSpec> = {
  owner: {
    glyph: '★', // filled star
    color: '#FFC93C',
    wash: 'rgba(255, 201, 60, 0.16)',
    label: ROLE_LABEL.owner,
  },
  co_owner: {
    glyph: '☆', // open star
    color: '#E0A82E',
    wash: 'rgba(224, 168, 46, 0.16)',
    label: ROLE_LABEL.co_owner,
  },
  admin: {
    glyph: '◆', // filled diamond
    color: '#4169E1',
    wash: 'rgba(65, 105, 225, 0.18)',
    label: ROLE_LABEL.admin,
  },
  super_agent: {
    glyph: '▲', // filled triangle
    color: '#1877F2',
    wash: 'rgba(24, 119, 242, 0.18)',
    label: ROLE_LABEL.super_agent,
  },
  agent: {
    glyph: '●', // filled circle
    color: '#00D4FF',
    wash: 'rgba(0, 212, 255, 0.16)',
    label: ROLE_LABEL.agent,
  },
  sub_agent: {
    glyph: '○', // open circle
    color: '#5AC8E8',
    wash: 'rgba(90, 200, 232, 0.16)',
    label: ROLE_LABEL.sub_agent,
  },
  player: {
    glyph: '·', // middle dot
    color: '#8A9AAA',
    wash: 'rgba(138, 154, 170, 0.14)',
    label: ROLE_LABEL.player,
  },
};

/** The colour a role's text should take. One lookup, seven answers. */
export function roleColor(role: unknown): string {
  return ROLE_BADGE[normaliseRole(role)].color;
}

interface RoleBadgeProps {
  role: unknown;
  /** 'sm' for the roster rows, 'md' for a page header. */
  size?: 'sm' | 'md';
  /** Print the role name beside the chip. */
  showLabel?: boolean;
  className?: string;
}

export default function RoleBadge({
  role,
  size = 'sm',
  showLabel = false,
  className = '',
}: RoleBadgeProps) {
  const key = normaliseRole(role);
  const spec = ROLE_BADGE[key];

  return (
    <span
      className={`role-badge role-badge--${size} ${className}`.trim()}
      // The seven colours are data, not seven CSS classes that could drift out
      // of step with the table above.
      style={
        {
          '--role-color': spec.color,
          '--role-wash': spec.wash,
        } as React.CSSProperties
      }
      title={spec.label}
    >
      <span className="role-badge__chip" aria-hidden="true">
        {spec.glyph}
      </span>
      {showLabel && <span className="role-badge__label">{spec.label}</span>}
      {!showLabel && <span className="sr-only">{spec.label}</span>}
    </span>
  );
}
