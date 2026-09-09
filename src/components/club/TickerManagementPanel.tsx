/**
 * TICKER MANAGEMENT - on the spade console (#ClubArenaConsole)
 *
 * WHAT WAS DELETED. A clip-path panel with a chamfered corner, a two-layer
 * gradient with a repeating scan line and two shadows; a bordered master
 * toggle box; an amber bordered safety notice with its own button box; eight
 * bordered 82px source tiles in a four-column grid, one of them a gradient
 * with an inset rail; five bordered control wells; a bordered composer input
 * with a filled blue button; one bordered box per saved message with a red
 * outlined Remove; and a filled Save button.
 *
 * It is now Dan's approved spade master: TICKER MANAGEMENT is the eyebrow,
 * CONTROL THE LIVE MESSAGE RAIL is engraved in the header well, every setting
 * is a ROW on the black glass (label in the master's lit blue on the left, its
 * value in engraved silver on the right, an engraved rule between), both
 * composers are GROOVES cut in the glass, and every action is a lit word. The
 * foot is the flat closing cap: SAVE TICKER is one action, and the foot never
 * paints a plate with nothing on it.
 *
 * NOTHING IN THE LOGIC MOVED. The load epoch that ignores a late response from
 * the previous scope, the dirty computation that counts an unsent draft, the
 * beforeunload warning, the compare-and-swap revision, the confirmDialog before
 * discarding a draft, the realtime subscription's savingRef guard, the
 * contrast validation and the deliberate refusal to clear the composers on
 * save are all exactly as they were. Every aria-label, id and aria-describedby
 * is unchanged: tests/unit/tableManagementContentPanels.safety.test.tsx finds
 * these controls by their accessible names.
 *
 * WHAT IS STILL DRAWN, and why. The eight source checkboxes, the five colour
 * and font controls and the scroll-speed range are controls the master paints
 * nowhere, which is the one exception the standard makes. The ticker PREVIEW
 * keeps its own border and its own colours because those are the operator's
 * data - it is a picture of the rail players will see, not our chrome. The
 * scroll-speed range stays horizontal: Dan's vertical-slider ruling is about
 * the felt, where a side-to-side drag is the table-switch gesture, and there
 * is no such gesture on an operator settings page.
 */

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
import { SpadeConsole } from '../console/SpadeConsole';
import styles from './TickerManagementPanel.module.css';

const SOURCE_OPTIONS: Array<{ key: TickerSource; label: string; detail: string }> = [
  {
    key: 'overlays',
    label: 'Overlay Alerts',
    detail: 'Promote real late-registration overlays players can still enter.',
  },
  {
    key: 'starting_soon',
    label: 'Tournament Starting Soon',
    detail: 'Countdown scheduled MTTs during their final five minutes.',
  },
  {
    key: 'custom_messages',
    label: 'Custom Messages',
    detail: 'Rotate operator-written messages with live game notices.',
  },
  {
    key: 'registration_closing',
    label: 'Registration Closing',
    detail: 'Call out late-registration doors before they close.',
  },
  {
    key: 'guarantees',
    label: 'Guaranteed Events',
    detail: 'Feature upcoming guaranteed tournaments.',
  },
  {
    key: 'table_openings',
    label: 'New Table Openings',
    detail: 'Tell players when fresh cash tables become available.',
  },
  {
    key: 'maintenance',
    label: 'Maintenance & Service',
    detail: 'Reserve the ticker for planned service notices.',
  },
  {
    key: 'winner_results',
    label: 'Winners & Results',
    detail: 'Celebrate recently completed events and results.',
  },
];

export default function TickerManagementPanel({
  scope,
  scopeId,
  onDirtyChange,
}: {
  scope: 'club' | 'union';
  scopeId: string;
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
      setLoadError(
        error instanceof Error ? error.message : 'Could not load the authoritative ticker settings.'
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

  return (
    <SpadeConsole
      as="section"
      className={styles.panel}
      eyebrow="Ticker Management"
      title="Control The Live Message Rail"
      titleId="ticker-management-title"
      pill={scope === 'union' ? 'Union' : 'Club'}
      foot="foot"
      aria-labelledby="ticker-management-title"
      aria-busy={loading || saving}
    >
      <p className="sc-copy">
        Choose What Earns The Top Strip, Then Tune Its Pace And Visual Treatment.
      </p>

      <label className={styles.master}>
        <input
          type="checkbox"
          aria-label="Ticker Enabled"
          checked={settings.enabled}
          onChange={(e) => update('enabled', e.target.checked)}
          disabled={loading || saving || revision === null || Boolean(loadError)}
        />
        <span className={`${styles.masterWord} sc-label sc-ink--blue`}>
          {settings.enabled ? 'Ticker On' : 'Ticker Off'}
        </span>
      </label>

      {loadError && (
        <div className={styles.safetyNotice} role="alert">
          <strong className="sc-ink--red">Ticker Editing Is Locked</strong>
          <span className={styles.safetyDetail}>
            {loadError} No Defaults Will Be Written Over The Saved Configuration.
          </span>
          <button
            type="button"
            className={styles.word}
            onClick={() => void load()}
            disabled={loading}
          >
            Try Again
          </button>
        </div>
      )}
      {remoteUpdate && (
        <div className={styles.safetyNotice} role="status" aria-live="polite">
          <strong className="sc-ink--gold">Newer Settings Are Available</strong>
          <span className={styles.safetyDetail}>
            Your Local Draft Is Still Intact. Reload Only When You Are Ready To Discard It.
          </span>
          <button
            type="button"
            className={styles.word}
            onClick={() => void loadLatest()}
            disabled={loading || saving}
          >
            Load Latest
          </button>
        </div>
      )}
      <fieldset
        className={styles.editor}
        aria-label="Ticker Settings"
        disabled={loading || saving || revision === null || Boolean(loadError)}
      >
        {/* The preview keeps the operator's OWN colours and its own rule: it is
            a picture of the rail players will see, not this panel's chrome. */}
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
        <div className={styles.sourceGrid}>
          {SOURCE_OPTIONS.map((source) => (
            <label
              key={source.key}
              className={`${styles.source} ${settings.sources[source.key] ? styles.sourceOn : ''}`}
            >
              <input
                type="checkbox"
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
        <div className={styles.customizer}>
          <label>
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
              className={styles.word}
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
                    className={`${styles.word} ${styles.wordRed}`}
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
              className={styles.word}
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
                    className={`${styles.word} ${styles.wordRed}`}
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
      {/* ONE action, so it is a lit word above the flat closing cap. */}
      <div className={styles.footer}>
        <span role="status" aria-live="polite">
          {loading
            ? 'Loading Current Ticker…'
            : contrastError
              ? contrastError
              : dirty
                ? 'Unsaved Ticker Changes Are Staged Locally.'
                : 'All Ticker Changes Are Saved.'}
        </span>
        <button
          type="button"
          className={`${styles.word} ${styles.wordSave}`}
          onClick={() => void save()}
          disabled={loading || saving || revision === null || !dirty || Boolean(contrastError)}
        >
          {saving ? 'Saving…' : 'Save Ticker'}
        </button>
      </div>
    </SpadeConsole>
  );
}
