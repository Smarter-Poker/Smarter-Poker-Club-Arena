import React from 'react';
import './Comment.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';

interface CommentProps {
  author: {
    name: string;
    avatar?: string;
  };
  content: string;
  time: string;
  onReply?: () => void;
  onLike?: () => void;
  likes?: number;
}

export const Comment: React.FC<CommentProps> = ({
  author,
  content,
  time,
  onReply,
  onLike,
  likes = 0,
}) => {
  return (
    <div className="comment">
      <div className="comment-avatar">
        {author.avatar ? (
          <img
            loading="lazy"
            decoding="async"
            src={author.avatar}
            alt={author.name}
            onError={(e) => {
              (e.target as HTMLImageElement).src = generateDefaultAvatar();
            }}
          />
        ) : (
          <span>{author.name[0]}</span>
        )}
      </div>
      <div className="comment-body">
        <div className="comment-header">
          <span className="comment-author">{author.name}</span>
          <span className="comment-time">{time}</span>
        </div>
        <div className="comment-content">{content}</div>
        <div className="comment-actions">
          {onLike && (
            <button className="comment-action" onClick={onLike}>
              ❤ {likes > 0 && likes}
            </button>
          )}
          {onReply && (
            <button className="comment-action" onClick={onReply}>
              Reply
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default Comment;
