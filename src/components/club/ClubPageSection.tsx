import type { ComponentProps } from 'react';
import type { SpadeConsole, PlateButtonProps } from '../console/SpadeConsole';
import './ClubPageSection.css';

/** Normal document sections for the operator pages whose frames the owner removed.
 * Keeps headings, status and actions in flow, with no art-sized text zones. */
export function ClubPageSection({
  eyebrow,
  title,
  titleAs: Heading = 'h2',
  titleId,
  subtitle,
  pill,
  pillInk = 'blue',
  plates,
  children,
  className = '',
  as: Tag = 'section',
  onClose,
  crest: _crest,
  family: _family,
  foot: _foot,
  ...rest
}: ComponentProps<typeof SpadeConsole>) {
  const action = (props: PlateButtonProps, key: string) => {
    const { label, ink = 'blue', haptic: _haptic, buttonRef, href, ...buttonProps } = props;
    return href ? (
      <a key={key} href={href} className={`club-page-action sc-ink--${ink}`}>
        {label}
      </a>
    ) : (
      <button
        key={key}
        {...buttonProps}
        ref={buttonRef}
        type={buttonProps.type || 'button'}
        className={`club-page-action sc-ink--${ink}`}
      >
        {label}
      </button>
    );
  };
  return (
    <Tag {...rest} className={`club-page-section ${className}`}>
      <header className="club-page-heading">
        <div>
          {eyebrow && <p className="club-page-eyebrow">{eyebrow}</p>}
          <Heading id={titleId}>{title}</Heading>
          {subtitle && <p className="club-page-subtitle">{subtitle}</p>}
        </div>
        {pill && <span className={`club-page-status sc-ink--${pillInk}`}>{pill}</span>}
        {onClose && (
          <button type="button" className="club-page-action" onClick={onClose} aria-label="Close">
            Close
          </button>
        )}
      </header>
      <div className="club-page-body">{children}</div>
      {plates && (
        <div className="club-page-actions">
          {plates.secondary && action(plates.secondary, 'secondary')}
          {plates.primary && action(plates.primary, 'primary')}
        </div>
      )}
    </Tag>
  );
}
