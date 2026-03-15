import React from 'react';
import './ImageUpload.css';

interface ImageUploadProps {
  value?: string;
  onChange: (file: File | null) => void;
  placeholder?: string;
}

export const ImageUpload: React.FC<ImageUploadProps> = ({
  value,
  onChange,
  placeholder = 'Upload Image',
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    onChange(file);
  };

  return (
    <label className="image-upload">
      <input type="file" accept="image/*" onChange={handleChange} hidden />
      {value ? (
        <img loading="lazy" decoding="async" src={value} alt="Preview" className="image-preview" />
      ) : (
        <div className="image-placeholder">
          <span className="placeholder-icon">+</span>
          <span className="placeholder-text">{placeholder}</span>
        </div>
      )}
      {value && (
        <button
          className="remove-btn"
          onClick={(e) => {
            e.preventDefault();
            onChange(null);
          }}
        >
          ×
        </button>
      )}
    </label>
  );
};

export default ImageUpload;
