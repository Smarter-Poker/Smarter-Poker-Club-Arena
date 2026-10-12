import { useEffect, useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { readLightningPrefs, writeLightningPrefs } from '../../lightning/lightningPrefs';
import type { LightningShortcutModifier } from '../../lightning/lightningShortcuts';
import { SpadeConsole } from '../console/SpadeConsole';
import './LightningPreferences.css';

export default function LightningPreferences({ onClose }: { onClose: () => void }) {
  const [prefs, setPrefs] = useState(readLightningPrefs);
  const focus = useFocusTrap(true);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [onClose]);
  const modifier = prefs.shortcutModifier === 'alt_shift' ? 'Alt + Shift' : 'Shift';
  return (
    <div className="lightning-preferences-overlay" onClick={onClose}>
      <div
        className="lightning-preferences"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lightning-preferences-title"
        ref={focus}
        onClick={(e) => e.stopPropagation()}
      >
        <SpadeConsole
          eyebrow="Lightning"
          title="Preferences"
          pill="Device"
          titleId="lightning-preferences-title"
          onClose={onClose}
          plates={{
            secondary: {
              label: 'Reset Defaults',
              onClick: () =>
                setPrefs(writeLightningPrefs({ shortcutModifier: 'shift', milestoneHands: 0 })),
            },
            primary: { label: 'Done', onClick: onClose },
          }}
        >
          <label className="lightning-preferences__row sc-copy">
            <span className="sc-ink--blue">Shortcut Modifier</span>
            <select
              aria-label="Shortcut Modifier"
              value={prefs.shortcutModifier}
              onChange={(e) =>
                setPrefs(
                  writeLightningPrefs({
                    shortcutModifier: e.target.value as LightningShortcutModifier,
                  })
                )
              }
            >
              <option value="shift">Shift</option>
              <option value="alt_shift">Alt + Shift</option>
              <option value="off">Off</option>
            </select>
          </label>
          <p className="sc-copy sc-ink--muted">
            {prefs.shortcutModifier === 'off'
              ? 'Lightning Shortcuts Are Off.'
              : `${modifier} + F: Lightning Fold. ${modifier} + V: Fold And Watch. ${modifier} + N: Next Urgent Table. ${modifier} + P: Previous Table. ${modifier} + D: Focus Decision.`}
          </p>
          <label className="lightning-preferences__row sc-copy">
            <span className="sc-ink--blue">Milestone Sound</span>
            <select
              aria-label="Milestone Sound"
              value={prefs.milestoneHands}
              onChange={(e) =>
                setPrefs(writeLightningPrefs({ milestoneHands: Number(e.target.value) }))
              }
            >
              <option value={0}>Off</option>
              <option value={100}>Every 100 Hands</option>
              <option value={250}>Every 250 Hands</option>
              <option value={500}>Every 500 Hands</option>
            </select>
          </label>
          <p className="sc-copy sc-ink--muted">
            Counts New Hands In This Room During This Visit. Action Alerts Come First. Your Sound
            Setting Applies.
          </p>
        </SpadeConsole>
      </div>
    </div>
  );
}
