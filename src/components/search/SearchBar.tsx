import React, { useState } from 'react';
import './SearchBar.css';

interface SearchBarProps {
  placeholder?: string;
  value?: string;
  onSearch?: (query: string) => void;
  onChange?: (value: string) => void;
  onFocus?: () => void;
  autoFocus?: boolean;
}

export const SearchBar: React.FC<SearchBarProps> = ({
  placeholder = 'Search...',
  value = '',
  onSearch,
  onChange,
  onFocus,
  autoFocus = false,
}) => {
  const [inputValue, setInputValue] = useState(value);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    onChange?.(newValue);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch?.(inputValue);
  };

  const handleClear = () => {
    setInputValue('');
    onChange?.('');
  };

  return (
    <form className="search-bar" onSubmit={handleSubmit}>
      <span className="search-icon">⌕</span>
      <input
        type="text"
        className="search-input"
        placeholder={placeholder}
        value={inputValue}
        onChange={handleChange}
        onFocus={onFocus}
        autoFocus={autoFocus}
      />
      {inputValue && (
        <button type="button" className="clear-btn" onClick={handleClear}>
          ×
        </button>
      )}
    </form>
  );
};

export default SearchBar;
