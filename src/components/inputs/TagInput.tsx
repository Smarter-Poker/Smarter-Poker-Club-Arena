import React, { useState } from 'react';
import './TagInput.css';

interface TagInputProps {
  label?: string;
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  maxTags?: number;
  suggestions?: string[];
}

export const TagInput: React.FC<TagInputProps> = ({
  label,
  tags,
  onChange,
  placeholder = 'Add tag...',
  maxTags = 10,
  suggestions = [],
}) => {
  const [input, setInput] = useState('');

  const addTag = (tag: string) => {
    const trimmed = tag.trim();
    if (trimmed && !tags.includes(trimmed) && tags.length < maxTags) {
      onChange([...tags, trimmed]);
    }
    setInput('');
  };

  const removeTag = (index: number) => {
    onChange(tags.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag(input);
    } else if (e.key === 'Backspace' && !input && tags.length) {
      removeTag(tags.length - 1);
    }
  };

  const filteredSuggestions = suggestions.filter(
    (s) => s.toLowerCase().includes(input.toLowerCase()) && !tags.includes(s)
  );

  return (
    <div className="tag-input-wrapper">
      {label && <label className="tag-label">{label}</label>}

      <div className="tag-container">
        {tags.map((tag, i) => (
          <span key={i} className="tag">
            {tag}
            <button onClick={() => removeTag(i)} aria-label="Remove Tag">
              ×
            </button>
          </span>
        ))}
        {tags.length < maxTags && (
          <input
            type="text"
            className="tag-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={tags.length === 0 ? placeholder : ''}
          />
        )}
      </div>

      {input && filteredSuggestions.length > 0 && (
        <div className="tag-suggestions">
          {filteredSuggestions.slice(0, 5).map((s) => (
            <button key={s} onClick={() => addTag(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default TagInput;
