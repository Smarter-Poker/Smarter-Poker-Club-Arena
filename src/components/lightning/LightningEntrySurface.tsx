import './LightningEntrySurface.css';
import { useId, type ReactNode } from 'react';
import { SpadeConsole, type PlateButtonProps } from '../console/SpadeConsole';
import { titleCase } from '../../utils/titleCase';
import { lightningStakeText } from '../../lightning/lightningStakeText';

type Action = { label: string; onClick?: () => void; disabled?: boolean; testId?: string };

export default function LightningEntrySurface({
  eyebrow = 'Lightning',
  title,
  description,
  tone,
  pill,
  action,
  secondaryAction,
  children,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  tone?: 'error';
  pill?: string;
  action?: Action;
  secondaryAction?: Action;
  children?: ReactNode;
}) {
  const titleId = useId();
  const primary: (PlateButtonProps & { 'data-testid'?: string }) | undefined = action
    ? {
        label: titleCase(action.label),
        ink: 'white',
        onClick: action.onClick,
        disabled: action.disabled,
        'data-testid': action.testId,
      }
    : undefined;
  const pair = action && secondaryAction;
  const single = !pair ? (action ?? secondaryAction) : undefined;
  return (
    <SpadeConsole
      className="lightning-entry__console"
      titleId={titleId}
      aria-labelledby={titleId}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      eyebrow={titleCase(eyebrow)}
      title={titleCase(lightningStakeText(title))}
      pill={titleCase(pill ?? (tone === 'error' ? 'Error' : 'Entry'))}
      foot={pair ? 'plates' : 'foot'}
      plates={
        pair
          ? {
              primary,
              secondary: {
                label: titleCase(secondaryAction.label),
                onClick: secondaryAction.onClick,
              },
            }
          : undefined
      }
    >
      {description ? (
        <p className="sc-copy lightning-entry__guidance">
          {titleCase(lightningStakeText(description))}
        </p>
      ) : null}
      {children}
      {single ? (
        <button
          type="button"
          className="lightning-entry__single-action"
          onClick={single.onClick}
          disabled={single.disabled}
          data-testid={single.testId}
        >
          {titleCase(single.label)}
        </button>
      ) : null}
    </SpadeConsole>
  );
}
