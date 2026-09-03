import React from 'react';
import './ReactionBar.css';

interface Reaction {
  emoji: string;
  count: number;
  selected: boolean;
}

interface ReactionBarProps {
  reactions: Reaction[];
  onToggle: (emoji: string) => void;
  onAddClick?: () => void;
}

export const ReactionBar: React.FC<ReactionBarProps> = ({ reactions, onToggle, onAddClick }) => {
  return (
    <div className="reaction-bar">
      {reactions.map((r) => (
        <button
          key={r.emoji}
          className={`reaction ${r.selected ? 'selected' : ''}`}
          onClick={() => onToggle(r.emoji)}
        >
          <span className="reaction-emoji">{r.emoji}</span>
          <span className="reaction-count">{r.count}</span>
        </button>
      ))}
      {onAddClick && (
        <button className="reaction add" onClick={onAddClick}>
          +
        </button>
      )}
    </div>
  );
};

export default ReactionBar;
