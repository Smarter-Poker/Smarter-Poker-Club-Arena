import React, { useState, useEffect } from 'react';
import './SoundSettings.css';

interface SoundSettingsProps {
  onChange?: (settings: SoundConfig) => void;
}

interface SoundConfig {
  masterVolume: number;
  effectsVolume: number;
  musicVolume: number;
  voiceVolume: number;
  enableSounds: boolean;
  enableActionSounds: boolean;
  enableChatSounds: boolean;
  enableTurnAlert: boolean;
  enableWinSound: boolean;
}

const SOUND_STORAGE_KEY = 'sp_sound_settings';

export const SoundSettings: React.FC<SoundSettingsProps> = ({ onChange }) => {
  const [config, setConfig] = useState<SoundConfig>({
    masterVolume: 80,
    effectsVolume: 100,
    musicVolume: 50,
    voiceVolume: 70,
    enableSounds: true,
    enableActionSounds: true,
    enableChatSounds: true,
    enableTurnAlert: true,
    enableWinSound: true,
  });
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(SOUND_STORAGE_KEY);
      if (stored) setConfig(JSON.parse(stored));
    } catch {
      /* ignore corrupt data */
    }
    setTimeout(() => setMounted(true), 50);
  }, []);

  const updateConfig = (key: keyof SoundConfig, value: number | boolean) => {
    const newConfig = { ...config, [key]: value };
    setConfig(newConfig);
    localStorage.setItem(SOUND_STORAGE_KEY, JSON.stringify(newConfig));
    onChange?.(newConfig);
  };

  const playTestSound = () => {
    // Play a test sound
    const audio = new Audio('/sounds/chip-stack.mp3');
    audio.volume = config.masterVolume / 100;
    audio.play().catch((e) => console.warn('[SoundSettings] Failed to play test sound:', e));
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
            <span>Effects</span>
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

        <div className="slider-group">
          <label>
            <span>Music</span>
            <span className="volume-value">{config.musicVolume}%</span>
          </label>
          <input
            type="range"
            min="0"
            max="100"
            value={config.musicVolume}
            onChange={(e) => updateConfig('musicVolume', parseInt(e.target.value))}
            disabled={!config.enableSounds}
          />
        </div>

        <div className="slider-group">
          <label>
            <span>Voice</span>
            <span className="volume-value">{config.voiceVolume}%</span>
          </label>
          <input
            type="range"
            min="0"
            max="100"
            value={config.voiceVolume}
            onChange={(e) => updateConfig('voiceVolume', parseInt(e.target.value))}
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
      </div>

      <button className="test-sound-btn" onClick={playTestSound} disabled={!config.enableSounds}>
        Test Sound
      </button>
    </div>
  );
};

export default SoundSettings;
