import React, { useState, useEffect } from 'react';
import { masterBus } from '../../core/MasterBus';
import { soundService } from '../../services/SoundService';
import './SoundSettings.css';

interface SoundSettingsProps {
  onChange?: (settings: SoundConfig) => void;
}

export interface SoundConfig {
  masterVolume: number;
  effectsVolume: number;
  enableSounds: boolean;
  enableVibrations: boolean;
  enableActionSounds: boolean;
  enableChatSounds: boolean;
  enableTurnAlert: boolean;
  enableWinSound: boolean;
  enableEventSounds: boolean;
}

const SOUND_STORAGE_KEY = 'sp_sound_settings';

/** Read current sound config from localStorage (used by SoundService integration) */
export function getSoundConfig(): SoundConfig {
  try {
    const stored = localStorage.getItem(SOUND_STORAGE_KEY);
    if (stored) return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
  } catch {
    /* ignore corrupt data */
  }
  return DEFAULT_CONFIG;
}

const DEFAULT_CONFIG: SoundConfig = {
  masterVolume: 80,
  effectsVolume: 100,
  enableSounds: true,
  enableVibrations: true,
  enableActionSounds: true,
  enableChatSounds: true,
  enableTurnAlert: true,
  enableWinSound: true,
  enableEventSounds: true,
};

export const SoundSettings: React.FC<SoundSettingsProps> = ({ onChange }) => {
  const [config, setConfig] = useState<SoundConfig>(DEFAULT_CONFIG);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setConfig(getSoundConfig());
    setTimeout(() => setMounted(true), 50);
  }, []);

  // Sync config to SoundService whenever it changes
  useEffect(() => {
    soundService.setEnabled(config.enableSounds);
    soundService.setMasterVolume(config.masterVolume / 100);
    soundService.setEffectsVolume(config.effectsVolume / 100);
    // Sync vibration preference
    try {
      localStorage.setItem('vibrationsEnabled', String(config.enableVibrations));
    } catch {
      /* ignore */
    }
  }, [config]);

  const updateConfig = (key: keyof SoundConfig, value: number | boolean) => {
    const newConfig = { ...config, [key]: value };
    setConfig(newConfig);
    try {
      localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify(newConfig));
    } catch {
      /* storage full — non-critical */
    }
    masterBus.emit('SETTINGS_UPDATED', {
      settings: newConfig as unknown as Record<string, unknown>,
    });
    onChange?.(newConfig);
  };

  const playTestSound = () => {
    // Use procedural Web Audio API sound (no external MP3 needed)
    soundService.playChips();
  };

  return (
    <div
      className="sound-settings"
      style={{
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(8px)',
        transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
        transitionDelay: '0.1s',
      }}
    >
      <div className="sound-master-toggle">
        <label className="toggle-label">
          <span>Enable All Sounds</span>
          <input
            type="checkbox"
            checked={config.enableSounds}
            onChange={(e) => updateConfig('enableSounds', e.target.checked)}
          />
          <span className="toggle-slider"></span>
        </label>
      </div>

      <div className={`sound-sliders ${!config.enableSounds ? 'disabled' : ''}`}>
        <div className="slider-group">
          <label>
            <span>Master Volume</span>
            <span className="volume-value">{config.masterVolume}%</span>
          </label>
          <input
            type="range"
            min="0"
            max="100"
            value={config.masterVolume}
            onChange={(e) => updateConfig('masterVolume', parseInt(e.target.value))}
            disabled={!config.enableSounds}
          />
        </div>

        <div className="slider-group">
          <label>
            <span>Effects Volume</span>
            <span className="volume-value">{config.effectsVolume}%</span>
          </label>
          <input
            type="range"
            min="0"
            max="100"
            value={config.effectsVolume}
            onChange={(e) => updateConfig('effectsVolume', parseInt(e.target.value))}
            disabled={!config.enableSounds}
          />
        </div>
      </div>

      <div className="sound-toggles">
        <h4>Sound Events</h4>

        <label className="toggle-row">
          <span>Action Sounds (fold, bet, raise)</span>
          <input
            type="checkbox"
            checked={config.enableActionSounds}
            onChange={(e) => updateConfig('enableActionSounds', e.target.checked)}
            disabled={!config.enableSounds}
          />
          <span className="toggle-slider small"></span>
        </label>

        <label className="toggle-row">
          <span>Chat Message Sounds</span>
          <input
            type="checkbox"
            checked={config.enableChatSounds}
            onChange={(e) => updateConfig('enableChatSounds', e.target.checked)}
            disabled={!config.enableSounds}
          />
          <span className="toggle-slider small"></span>
        </label>

        <label className="toggle-row">
          <span>Turn Alert</span>
          <input
            type="checkbox"
            checked={config.enableTurnAlert}
            onChange={(e) => updateConfig('enableTurnAlert', e.target.checked)}
            disabled={!config.enableSounds}
          />
          <span className="toggle-slider small"></span>
        </label>

        <label className="toggle-row">
          <span>Win Celebration Sound</span>
          <input
            type="checkbox"
            checked={config.enableWinSound}
            onChange={(e) => updateConfig('enableWinSound', e.target.checked)}
            disabled={!config.enableSounds}
          />
          <span className="toggle-slider small"></span>
        </label>

        <label className="toggle-row">
          <span>Event Sounds (bomb pot, jackpot, bounty)</span>
          <input
            type="checkbox"
            checked={config.enableEventSounds}
            onChange={(e) => updateConfig('enableEventSounds', e.target.checked)}
            disabled={!config.enableSounds}
          />
          <span className="toggle-slider small"></span>
        </label>

        <label className="toggle-row">
          <span>Vibration Feedback</span>
          <input
            type="checkbox"
            checked={config.enableVibrations}
            onChange={(e) => updateConfig('enableVibrations', e.target.checked)}
            disabled={!config.enableSounds}
          />
          <span className="toggle-slider small"></span>
        </label>
      </div>

      <button className="test-sound-btn" onClick={playTestSound} disabled={!config.enableSounds}>
        Test Sound
      </button>
    </div>
  );
};

export default SoundSettings;
