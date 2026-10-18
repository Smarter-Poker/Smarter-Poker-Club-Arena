import type { ButtonHTMLAttributes } from 'react';
import { useFitText } from '../lobby/game-cards/useFitText';
import './TournamentRegisterButton.css';

/** Live registration text on the compact plate derived from the approved master. */
export function TournamentRegisterButton({
  children,
  className = '',
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & { children: string }) {
  const textRef = useFitText<HTMLSpanElement>(children, 1, 0.55, {
    wrapBelow: 0.85,
    maxLines: 2,
  });
  return (
    <button type="button" className={`tournament-register-button ${className}`} {...props}>
      <span className="tournament-register-button__face">
        <span className="tournament-register-button__text" ref={textRef}>
          {children}
        </span>
      </span>
    </button>
  );
}
