import React, { useState, useEffect, useRef, useCallback } from 'react';
import { masterBus } from '../../core/MasterBus';

interface AppearanceConfig {
  theme: 'dark' | 'midnight' | 'forest';
  feltColor: 'green' | 'blue' | 'red' | 'purple' | 'black';
  cardBack: 'classic' | 'modern' | 'neon';
  compactMode: boolean;
  animationsEnabled: boolean;
}

const DEFAULT_CONFIG: AppearanceConfig = {
  theme: 'dark',
  feltColor: 'green',
  cardBack: 'classic',
  compactMode: false,
  animationsEnabled: true,
};

const FELT_COLORS: { id: AppearanceConfig['feltColor']; label: string; hex: string }[] = [
  { id: 'green', label: 'Classic Green', hex: '#1a6b3c' },
  { id: 'blue', label: 'Ocean Blue', hex: '#1a3c6b' },
  { id: 'red', label: 'Casino Red', hex: '#6b1a1a' },
  { id: 'purple', label: 'Royal Purple', hex: '#4a1a6b' },
  { id: 'black', label: 'Midnight Black', hex: '#1a1a1a' },
];

export const AppearanceSettings: React.FC = () => {
  const [config, setConfig] = useState<AppearanceConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('sp_appearance_settings');
      if (stored) setConfig(JSON.parse(stored));
    } catch {
      /* ignore corrupt data */
    }
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const update = useCallback((partial: Partial<AppearanceConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...partial };
      localStorage.setItem('sp_appearance_settings', JSON.stringify(next));
      // Emit bus event so other pages (table, etc.) can react to appearance changes
      masterBus.emit('SETTINGS_UPDATED', { settings: next as unknown as Record<string, unknown> });
      return next;
    });
    setSaved(true);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSaved(false), 1500);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <h3 style={{ margin: 0, color: '#fff', fontSize: '1.1rem' }}>Appearance Settings</h3>

      {/* Theme */}
      <div className="setting-row">
        <label>Theme</label>
        <select
          value={config.theme}
          onChange={(e) => update({ theme: e.target.value as AppearanceConfig['theme'] })}
        >
          <option value="dark">Dark</option>
          <option value="midnight">Midnight</option>
          <option value="forest">Forest</option>
        </select>
      </div>

      {/* Felt Color */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        <label style={{ color: 'var(--text-muted, #aaa)', fontSize: '0.9rem' }}>Table Felt</label>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {FELT_COLORS.map((fc) => (
            <button
              key={fc.id}
              onClick={() => update({ feltColor: fc.id })}
              title={fc.label}
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                background: fc.hex,
                border: config.feltColor === fc.id ? '2px solid #00d4ff' : '2px solid transparent',
                cursor: 'pointer',
                transition: 'border-color 0.2s',
              }}
            />
          ))}
        </div>
      </div>

      {/* Card Back */}
      <div className="setting-row">
        <label>Card Back</label>
        <select
          value={config.cardBack}
          onChange={(e) => update({ cardBack: e.target.value as AppearanceConfig['cardBack'] })}
        >
          <option value="classic">Classic</option>
          <option value="modern">Modern</option>
          <option value="neon">Neon</option>
        </select>
      </div>

      {/* Compact Mode */}
      <div className="setting-row">
        <label>Compact Mode</label>
        <label
          style={{
            position: 'relative',
            display: 'inline-block',
            width: 44,
            height: 24,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={config.compactMode}
            onChange={(e) => update({ compactMode: e.target.checked })}
            style={{ opacity: 0, width: 0, height: 0 }}
          />
          <span
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: 12,
              background: config.compactMode ? '#00d4ff' : '#444',
              transition: 'background 0.2s',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 2,
                left: config.compactMode ? 22 : 2,
                width: 20,
                height: 20,
                borderRadius: '50%',
                background: '#fff',
                transition: 'left 0.2s',
              }}
            />
          </span>
        </label>
      </div>

      {/* Animations */}
      <div className="setting-row">
        <label>Animations</label>
        <label
          style={{
            position: 'relative',
            display: 'inline-block',
            width: 44,
            height: 24,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={config.animationsEnabled}
            onChange={(e) => update({ animationsEnabled: e.target.checked })}
            style={{ opacity: 0, width: 0, height: 0 }}
          />
          <span
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: 12,
              background: config.animationsEnabled ? '#00d4ff' : '#444',
              transition: 'background 0.2s',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 2,
                left: config.animationsEnabled ? 22 : 2,
                width: 20,
                height: 20,
                borderRadius: '50%',
                background: '#fff',
                transition: 'left 0.2s',
              }}
            />
          </span>
        </label>
      </div>

      {saved && (
        <span style={{ color: '#31A24C', fontSize: '0.85rem', transition: 'opacity 0.3s' }}>
          ✓ Settings Saved
        </span>
      )}
    </div>
  );
};

export default AppearanceSettings;
