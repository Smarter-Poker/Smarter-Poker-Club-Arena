/**
 * The create-table form controls - Toggle, Slider, NumberField.
 *
 * Moved out of TableConfigPage.tsx on 2026-09-04 (Operation Table Stakes,
 * Slice 1) so the New Cash Game flow and the tournament form draw the same
 * switch, the same slider and the same number row. Markup is unchanged: the
 * isolated conventional switch with a visible On / Off status
 * (tests/unit/createTableHelpAndSwitches.test.tsx) and the whole-number entry
 * row (Dan 2026-08-20: anything a player pays is never a decimal).
 */

import React from 'react';
import { HelpPopover } from '../common/HelpPopover';
// The switch, slider and number-row styles live beside the page that first
// drew them. Imported here so the classes resolve on every route that renders
// these controls (tests/unit/classNamesResolve.test.ts).
import '../../pages/TableConfigPage.css';

export const Toggle = ({
  label,
  value,
  onChange,
  tooltip,
  disabled = false,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  tooltip?: string;
  /** Locked by a rule (Free Buy): rendered, readable, not changeable. */
  disabled?: boolean;
}) => (
  <div className={`config-toggle${disabled ? ' is-locked' : ''}`}>
    <span className="toggle-label">
      {label}
      {tooltip && <HelpPopover label={label}>{tooltip}</HelpPopover>}
    </span>
    <label className="table-config-switch">
      <input
        className="table-config-switch__input"
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="table-config-switch__track" aria-hidden="true">
        <span className="table-config-switch__thumb" />
      </span>
      <span className={`table-config-switch__status ${value ? 'is-on' : 'is-off'}`}>
        {value ? 'On' : 'Off'}
      </span>
    </label>
  </div>
);

export const Slider = ({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix = '',
  tooltip,
  format,
  disabled = false,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  tooltip?: string;
  /** Render the value yourself - used to show "Schedule" for the -1 sentinel. */
  format?: (v: number) => string;
  disabled?: boolean;
}) => (
  <div className={`config-slider${disabled ? ' is-locked' : ''}`}>
    <div className="slider-header">
      <span className="slider-label">
        {label}: {format ? format(value) : `${value}${suffix}`}
        {tooltip && <HelpPopover label={label}>{tooltip}</HelpPopover>}
      </span>
    </div>
    <div className="slider-track-container">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider-input"
      />
    </div>
  </div>
);

/**
 * Whole-number entry row (2026-08-22). Used wherever a "Custom ..." toggle
 * switches a slider to free numeric entry - buy-in, rebuy cost, add-on cost,
 * GTD amount, early-bird chips, total days. Whole numbers only: anything a
 * player pays must never be a decimal (Dan 2026-08-20), so the field rounds
 * on input rather than letting a fraction sit in state.
 */
export const NumberField = ({
  label,
  value,
  onChange,
  min = 0,
  max,
  tooltip,
  disabled = false,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  tooltip?: string;
  /** Locked by a rule (Free Buy): rendered, readable, not changeable. */
  disabled?: boolean;
}) => (
  <div className={`config-toggle${disabled ? ' is-locked' : ''}`}>
    <span className="toggle-label">
      {label}
      {tooltip && <HelpPopover label={label}>{tooltip}</HelpPopover>}
    </span>
    <input
      type="number"
      className="config-datetime"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      value={value}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => {
        let v = Math.round(Number(e.target.value) || 0);
        if (v < min) v = min;
        if (max !== undefined && v > max) v = max;
        onChange(v);
      }}
      style={{ width: 110, textAlign: 'right' }}
    />
  </div>
);
