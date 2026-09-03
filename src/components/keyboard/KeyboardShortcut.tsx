import React from 'react';
import './KeyboardShortcut.css';

interface KeyboardShortcutProps {
  keys: string[];
  description?: string;
}

export const KeyboardShortcut: React.FC<KeyboardShortcutProps> = ({ keys, description }) => {
  return (
    <div className="keyboard-shortcut">
      <div className="keys">
        {keys.map((key, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="plus">+</span>}
            <kbd>{key}</kbd>
          </React.Fragment>
        ))}
      </div>
      {description && <span className="description">{description}</span>}
    </div>
  );
};

export default KeyboardShortcut;
