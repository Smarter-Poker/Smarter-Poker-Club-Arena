import React, { useState } from 'react';
import './CommentInput.css';

interface CommentInputProps {
  onSubmit: (text: string) => void;
  placeholder?: string;
  avatar?: string;
}

export const CommentInput: React.FC<CommentInputProps> = ({
  onSubmit,
  placeholder = 'Write a comment...',
  avatar,
}) => {
  const [text, setText] = useState('');

  const handleSubmit = () => {
    if (!text.trim()) return;
    onSubmit(text.trim());
    setText('');
  };

  return (
    <div className="comment-input">
      {avatar && (
        <div className="input-avatar">
          <img loading="lazy" decoding="async" src={avatar} alt="" />
        </div>
      )}
      <div className="input-field-wrapper">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={placeholder}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
        />
        <button className="send-btn" onClick={handleSubmit} disabled={!text.trim()}>
          ➤
        </button>
      </div>
    </div>
  );
};

export default CommentInput;
