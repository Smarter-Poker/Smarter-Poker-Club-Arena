import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import {
  DEFAULT_TICKER_SETTINGS,
  tickerManagementService,
  validateTickerContrast,
  type ManagedTickerSettings,
  type TickerSource,
} from '../../services/TickerManagementService';
import { useToast } from '../common/Toast';
import { isManagementContentConflict } from '../../services/ManagementContentError';
import { confirmDialog } from '../common/confirmDialog';
import { SpadeConsole, type ConsoleInk } from '../console/SpadeConsole';
import { safeErrorMessage } from '../../utils/safeErrorMessage';
import { titleCase } from '../../utils/titleCase';
import styles from './TickerManagementPanel.module.css';

const SOURCE_OPTIONS: Array<{ key: TickerSource; label: string; detail: string }> = [
  {
    key: 'overlays',
    label: 'Overlay Alerts',
    detail: 'Promote Real Late-Registration Overlays Players Can Still Enter.',
  },
  {
    key: 'starting_soon',
    label: 'Tournament Starting Soon',
    detail: 'Count Down Scheduled MTTs During Their Final Five Minutes.',
  },
  {
    key: 'custom_messages',
    label: 'Custom Messages',
    detail: 'Rotate Operator-Written Messages With Live Game Notices.',
  },
  {
    key: 'registration_closing',
    label: 'Registration Closing',
    detail: 'Call Out Late-Registration Doors Before They Close.',
  },
  {
    key: 'guarantees',
    label: 'Guaranteed Events',
    detail: 'Feature Upcoming Guaranteed Tournaments.',
  },
  {
    key: 'table_openings',
    label: 'New Table Openings',
    detail: 'Tell Players When Fresh Cash Tables Become Available.',
  },
  {
    key: 'maintenance',
    label: 'Maintenance & Service',
    detail: 'Reserve The Ticker For Planned Service Notices.',
  },
  {
    key: 'winner_results',
    label: 'Winners & Results',
    detail: 'Celebrate Recently Completed Events And Results.',
  },
];

/**
 * TICKER MANAGEMENT IS ITS OWN PAGE (Dan 2026-09-20: "DO NOT ATTACH EVERYTHING
 * TOGETHER WITH THE SAME DISPLAY WINDOWS").
 *
 * This panel used to print as frameless content inside the Game Board's
 * console, one of three interchangeable screens. It now draws its own frame:
 * the shark family - a thinner chamfered chassis than the board's spade, its
 * own diamond crest - whose foot carries exactly ONE plate, which is exactly
 * the one action this page has: Save Ticker. The on-air preview leads the page
 * like a broadcast monitor; sources, pace and rotations sit under it as rows
 * on the glass. Every load, draft, conflict and save rule below is unchanged.
 */
export default function TickerManagementPanel({
  scope,
  scopeId,
  scopeName,
  onDirtyChange,
}: {
  scope: 'club' | 'union';
  scopeId: string;
  /** The club or union the ticker belongs to, printed under the title. */
  scopeName?: string;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const toast = useToast();
  const [settings, setSettings] = useState<ManagedTickerSettings>(DEFAULT_TICKER_SETTINGS);
  const [savedSettings, setSavedSettings] = useState<ManagedTickerSettings | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [remoteUpdate, setRemoteUpdate] = useState(false);
  const [messageDraft, setMessageDraft] = useState('');
  const [serviceDraft, setServiceDraft] = useState('');

  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const loadEpochRef = useRef(0);

  const dirty = useMemo(
    () =>
      Boolean(savedSettings) &&
      (JSON.stringify(settings) !== JSON.stringify(savedSettings) ||
        Boolean(messageDraft.trim()) ||
        Boolean(serviceDraft.trim())),
    [messageDraft, savedSettings, serviceDraft, settings]
  );
  const contrastError = validateTickerContrast(settings);

  useEffect(() => {
    dirtyRef.current = dirty;
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const load = useCallback(async () => {
    const requestId = ++loadEpochRef.current;
    const isCurrent = () => loadEpochRef.current === requestId;
    setLoading(true);
    setLoadError(null);
    try {
      const snapshot = await tickerManagementService.getManagement(scope, scopeId);
      if (!isCurrent()) return;
      setSettings(snapshot.settings);
      setSavedSettings(snapshot.settings);
      setRevision(snapshot.revision);
      setMessageDraft('');
      setServiceDraft('');
      setRemoteUpdate(false);
      dirtyRef.current = false;
    } catch (error) {
      if (!isCurrent()) return;
      // A plain Title Case sentence on the glass, never the raw error text.
      setLoadError(
        titleCase(safeErrorMessage(error, 'Could Not Load The Authoritative Ticker Settings.'))
      );
      setRevision(null);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [scope, scopeId]);

  useEffect(() => {
    setSavedSettings(null);
    setRevision(null);
    void load();
  }, [load]);

  useMasterBusSubscription(
    'TICKER_SETTINGS_CHANGED',
    (payload) => {
      if (payload.scope !== scope || payload.scopeId !== scopeId || savingRef.current) return;
      if (dirtyRef.current) setRemoteUpdate(true);
      else void load();
    },
    { debounce: 200 }
  );

  const update = <K extends keyof ManagedTickerSettings>(key: K, value: ManagedTickerSettings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));
  const loadLatest = async () => {
    if (
      dirtyRef.current &&
      !(await confirmDialog({
        message: 'Discard your ticker draft and load the latest saved settings?',
        variant: 'danger',
      }))
    )
      return;
    await load();
  };
  const save = async () => {
    if (revision === null || loadError || contrastError) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const snapshot = await tickerManagementService.save(scope, scopeId, settings, revision);
      setSettings(snapshot.settings);
      setSavedSettings(snapshot.settings);
      setRevision(snapshot.revision);
      setRemoteUpdate(false);
      /*
        The composers are NOT cleared here, and that is the fix.

        This button saves SETTINGS; a composed message is sent with Add
        Message. Clearing the drafts here threw away text the operator had
        typed and then said "Ticker settings saved", so the work was gone and
        the confirmation said otherwise. `dirty` counts a non-empty draft as
        unsaved work and the footer warns about it on unload, so the panel
        already knew the text mattered before it discarded it.
      */
      const unsent = Boolean(messageDraft.trim()) || Boolean(serviceDraft.trim());
      dirtyRef.current = unsent;
      toast.success(
        unsent
          ? 'Ticker settings saved. Your unsent message is still in the composer.'
          : 'Ticker settings saved.'
      );
    } catch (error) {
      if (isManagementContentConflict(error)) setRemoteUpdate(true);
      toast.error(error instanceof Error ? error.message : 'Could not save ticker settings.');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // The pill reports what players see NOW - the saved state - never the draft.
  const onAir = savedSettings?.enabled ?? null;
  const pill = onAir === null ? (loadError ? 'Locked' : 'Loading') : onAir ? 'On Air' : 'Off Air';
  const pillInk: ConsoleInk =
    onAir === null ? (loadError ? 'red' : 'muted') : onAir ? 'green' : 'muted';

  return (
    <SpadeConsole
      family="shark"
      className={styles.panel}
      eyebrow="Broadcast Control"
      title="Ticker Management"
      titleId="ticker-management-title"
      /* The club or union name alone: with the suffix the shark's narrow
         subtitle zone fitted a long name down to nine pixels. The heading
         below the head says what the rail is. */
      subtitle={scopeName || 'Live Message Rail'}
      pill={pill}
      pillInk={pillInk}
      aria-labelledby="ticker-management-title"
      aria-busy={loading || saving}
      plates={{
        primary: {
          label: saving ? 'Saving…' : 'Save Ticker',
          type: 'button',
          onClick: () => void save(),
          disabled: loading || saving || revision === null || !dirty || Boolean(contrastError),
          ink: 'white',
        },
      }}
    >
      <div className={styles.monitor}>
        <span className={`${styles.sectionLabel} sc-ink--blue`}>On-Air Preview</span>
        <div
          className={styles.preview}
          role="img"
          aria-label="Ticker Preview: Live Alert, Tournament Starting Soon, Custom Messages, Overlay Alerts"
          style={{
            background: settings.backgroundColor,
            color: settings.textColor,
            borderColor: settings.accentColor,
            fontFamily: settings.fontFamily === 'System' ? 'system-ui' : settings.fontFamily,
          }}
        >
          <strong style={{ color: settings.accentColor }}>LIVE ALERT</strong>
          <div>
            <span style={{ animationDuration: `${settings.speedSeconds}s` }}>
              Your Ticker Preview · Tournament Starting Soon · Custom Messages · Overlay Alerts
            </span>
          </div>
        </div>
      </div>

      <div className={styles.heading}>
        <div>
          <h3 className="sc-ink--silver">Control The Live Message Rail</h3>
          <p className="sc-copy">
            Choose What Earns The Top Strip, Then Tune Its Pace And Visual Treatment.
          </p>
        </div>
        <label className={`${styles.master} sc-check${settings.enabled ? ' sc-check--on' : ''}`}>
          <input
            type="checkbox"
            className="sc-check__box"
            aria-label="Ticker Enabled"
            checked={settings.enabled}
            onChange={(e) => update('enabled', e.target.checked)}
            disabled={loading || saving || revision === null || Boolean(loadError)}
          />
          <span className={settings.enabled ? 'sc-ink--green' : 'sc-ink--muted'}>
            {settings.enabled ? 'Ticker On' : 'Ticker Off'}
          </span>
        </label>
      </div>
      {loadError && (
        <div className={styles.safetyNotice} role="alert">
          <strong>Ticker Editing Is Locked</strong>
          <span>{loadError} No Defaults Will Be Written Over The Saved Configuration.</span>
          <button type="button" onClick={() => void load()} disabled={loading}>
            Try Again
          </button>
        </div>
      )}
      {remoteUpdate && (
        <div className={styles.safetyNotice} role="status" aria-live="polite">
          <strong>Newer Settings Are Available</strong>
          <span>
            Your Local Draft Is Still Intact. Reload Only When You Are Ready To Discard It.
          </span>
          <button type="button" onClick={() => void loadLatest()} disabled={loading || saving}>
            Load Latest
          </button>
        </div>
      )}
      <fieldset
        className={styles.editor}
        aria-label="Ticker Settings"
        disabled={loading || saving || revision === null || Boolean(loadError)}
      >
        <span className={`${styles.sectionLabel} sc-ink--blue`}>Message Sources</span>
        <div className={styles.sourceGrid}>
          {SOURCE_OPTIONS.map((source) => (
            <label
              key={source.key}
              className={`${styles.source} sc-check${
                settings.sources[source.key] ? ' sc-check--on' : ''
              }`}
            >
              <input
                type="checkbox"
                className="sc-check__box"
                aria-label={source.label}
                checked={settings.sources[source.key]}
                onChange={(e) =>
                  update('sources', { ...settings.sources, [source.key]: e.target.checked })
                }
              />
              <span>
                <strong>{source.label}</strong>
                <small>{source.detail}</small>
              </span>
            </label>
          ))}
        </div>
        <span className={`${styles.sectionLabel} sc-ink--blue`}>Pace And Treatment</span>
        <div className={styles.customizer}>
          <label className={styles.speed}>
            Scroll Speed <span>{settings.speedSeconds} Seconds</span>
            <input
              type="range"
              aria-label="Scroll Speed"
              min="8"
              max="60"
              value={settings.speedSeconds}
              aria-valuetext={`${settings.speedSeconds} Seconds`}
              onChange={(e) => update('speedSeconds', Number(e.target.value))}
            />
          </label>
          <label>
            Background Color
            <input
              type="color"
              value={settings.backgroundColor}
              onChange={(e) => update('backgroundColor', e.target.value)}
            />
          </label>
          <label>
            Text Color
            <input
              type="color"
              value={settings.textColor}
              onChange={(e) => update('textColor', e.target.value)}
            />
          </label>
          <label>
            Accent Color
            <input
              type="color"
              value={settings.accentColor}
              onChange={(e) => update('accentColor', e.target.value)}
            />
          </label>
          <label>
            Font
            <select
              value={settings.fontFamily}
              onChange={(e) =>
                update('fontFamily', e.target.value as ManagedTickerSettings['fontFamily'])
              }
            >
              <option>Rajdhani</option>
              <option>Inter</option>
              <option>Roboto Condensed</option>
              <option>System</option>
            </select>
          </label>
        </div>
        <div className={styles.messages}>
          <h3>Custom Message Rotation</h3>
          <div className={styles.messageComposer}>
            <input
              id="ticker-custom-message"
              aria-label="New Custom Ticker Message"
              value={messageDraft}
              maxLength={160}
              placeholder="Write A Concise Message Players Can Act On"
              onChange={(e) => setMessageDraft(e.target.value)}
              aria-describedby="ticker-custom-message-count"
            />
            <button
              type="button"
              onClick={() => {
                const message = messageDraft.replace(/\s+/g, ' ').trim();
                if (!message) return;
                update('customMessages', [...settings.customMessages, message].slice(-10));
                setMessageDraft('');
              }}
            >
              Add Message
            </button>
          </div>
          <small id="ticker-custom-message-count" className={styles.characterCount}>
            {messageDraft.length}/160 Characters · {settings.customMessages.length}/10 Messages
          </small>
          {settings.customMessages.length === 0 ? (
            <p>No Custom Messages Yet.</p>
          ) : (
            <ul>
              {settings.customMessages.map((message, index) => (
                <li key={`${message}-${index}`}>
                  <span>{message}</span>
                  <button
                    type="button"
                    className={styles.remove}
                    onClick={() =>
                      update(
                        'customMessages',
                        settings.customMessages.filter((_, itemIndex) => itemIndex !== index)
                      )
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <h3>Maintenance &amp; Service Rotation</h3>
          <p>Service Notices Stay Separate From Promotional Copy And Display Only When Enabled.</p>
          <div className={styles.messageComposer}>
            <input
              id="ticker-service-message"
              aria-label="New Maintenance And Service Notice"
              value={serviceDraft}
              maxLength={160}
              placeholder="Example: Scheduled Maintenance Begins Tonight At 2 AM"
              onChange={(e) => setServiceDraft(e.target.value)}
              aria-describedby="ticker-service-message-count"
            />
            <button
              type="button"
              onClick={() => {
                const message = serviceDraft.replace(/\s+/g, ' ').trim();
                if (!message) return;
                update('serviceMessages', [...settings.serviceMessages, message].slice(-5));
                setServiceDraft('');
              }}
            >
              Add Service Notice
            </button>
          </div>
          <small id="ticker-service-message-count" className={styles.characterCount}>
            {serviceDraft.length}/160 Characters · {settings.serviceMessages.length}/5 Notices
          </small>
          {settings.serviceMessages.length === 0 ? (
            <p>No Service Notices Are Scheduled.</p>
          ) : (
            <ul>
              {settings.serviceMessages.map((message, index) => (
                <li key={`${message}-${index}`}>
                  <span>{message}</span>
                  <button
                    type="button"
                    className={styles.remove}
                    onClick={() =>
                      update(
                        'serviceMessages',
                        settings.serviceMessages.filter((_, itemIndex) => itemIndex !== index)
                      )
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </fieldset>
      <p
        className={`${styles.status} ${contrastError ? 'sc-ink--red' : 'sc-ink--muted'}`}
        role="status"
        aria-live="polite"
      >
        {loading
          ? 'Loading Current Ticker…'
          : contrastError
            ? contrastError
            : dirty
              ? 'Unsaved Ticker Changes Are Staged Locally.'
              : 'All Ticker Changes Are Saved.'}
      </p>
    </SpadeConsole>
  );
}
