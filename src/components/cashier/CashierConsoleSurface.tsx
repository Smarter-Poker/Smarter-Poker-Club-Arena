import type { ReactNode } from 'react';
import {
  SpadeConsole,
  type ConsoleCrest,
  type ConsoleInk,
  type PlateButtonProps,
} from '../console/SpadeConsole';
import './CashierConsoleSurface.css';

type CashierConsoleSurfaceProps = {
  eyebrow?: string;
  title: string;
  titleId?: string;
  subtitle?: string;
  pill?: string;
  pillInk?: ConsoleInk;
  crest?: ConsoleCrest;
  className?: string;
  children: ReactNode;
  actions?: {
    secondary?: PlateButtonProps;
    primary?: PlateButtonProps;
  };
};

/**
 * The one painted chassis for every Cashier page and dialog.
 *
 * Live values and controls print onto the black glass. The frame, crest and
 * action plates are the approved #ClubArenaConsole master at native ratio;
 * this component deliberately draws no substitute card, icon or button.
 */
export default function CashierConsoleSurface({
  eyebrow = 'Club Arena Cashier',
  title,
  titleId,
  subtitle,
  pill,
  pillInk = 'blue',
  crest = 'club',
  className = '',
  children,
  actions,
}: CashierConsoleSurfaceProps) {
  return (
    <SpadeConsole
      eyebrow={eyebrow}
      title={title}
      titleId={titleId}
      subtitle={subtitle}
      pill={pill}
      pillInk={pillInk}
      crest={crest}
      foot={actions ? 'plates' : 'foot'}
      plates={actions}
      className={`cashier-console ${className}`.trim()}
    >
      <div className="cashier-console__glass">{children}</div>
    </SpadeConsole>
  );
}
