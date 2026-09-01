import { useEffect, useState } from 'react';
import {
  DEFAULT_TICKER_SETTINGS,
  tickerManagementService,
  type ManagedTickerSettings,
  type TickerSource,
} from '../../services/TickerManagementService';
import { useToast } from '../common/Toast';
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
}: {
  scope: 'club' | 'union';
  scopeId: string;
}) {
  const toast = useToast();
  const [settings, setSettings] = useState<ManagedTickerSettings>(DEFAULT_TICKER_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [messageDraft, setMessageDraft] = useState('');
  const [serviceDraft, setServiceDraft] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    tickerManagementService
      .get(scope === 'club' ? scopeId : null, scope === 'union' ? scopeId : null)
      .then((value) => {
        if (alive) setSettings(value);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [scope, scopeId]);

  const update = <K extends keyof ManagedTickerSettings>(key: K, value: ManagedTickerSettings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));
  const save = async () => {
    setSaving(true);
    try {
      await tickerManagementService.save(scope, scopeId, settings);
      toast.success('Ticker settings saved.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not save ticker settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="ticker-management-title">
      <div className={styles.heading}>
        <div>
          <span>Ticker Management</span>
          <h2 id="ticker-management-title">Control The Live Message Rail</h2>
          <p>Choose What Earns The Top Strip, Then Tune Its Pace And Visual Treatment.</p>
        </div>
        <label className={styles.master}>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) => update('enabled', e.target.checked)}
            disabled={loading}
          />
          <span>{settings.enabled ? 'Ticker On' : 'Ticker Off'}</span>
        </label>
      </div>
      <div
        className={styles.preview}
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
          <label key={source.key} className={settings.sources[source.key] ? styles.sourceOn : ''}>
            <input
              type="checkbox"
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
            min="8"
            max="60"
            value={settings.speedSeconds}
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
            value={messageDraft}
            maxLength={160}
            placeholder="Write A Concise Message Players Can Act On"
            onChange={(e) => setMessageDraft(e.target.value)}
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
        {settings.customMessages.length === 0 ? (
          <p>No Custom Messages Yet.</p>
        ) : (
          <ul>
            {settings.customMessages.map((message, index) => (
              <li key={`${message}-${index}`}>
                <span>{message}</span>
                <button
                  type="button"
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
            value={serviceDraft}
            maxLength={160}
            placeholder="Example: Scheduled Maintenance Begins Tonight At 2 AM"
            onChange={(e) => setServiceDraft(e.target.value)}
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
        {settings.serviceMessages.length === 0 ? (
          <p>No Service Notices Are Scheduled.</p>
        ) : (
          <ul>
            {settings.serviceMessages.map((message, index) => (
              <li key={`${message}-${index}`}>
                <span>{message}</span>
                <button
                  type="button"
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
      <div className={styles.footer}>
        <span>
          {loading
            ? 'Loading Current Ticker…'
            : 'Changes Publish To Club And Table Pages After Saving.'}
        </span>
        <button type="button" onClick={() => void save()} disabled={loading || saving}>
          {saving ? 'Saving…' : 'Save Ticker'}
        </button>
      </div>
    </section>
  );
}
