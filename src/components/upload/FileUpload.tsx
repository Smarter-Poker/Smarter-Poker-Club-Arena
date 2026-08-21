import React, { useRef } from 'react';
import './FileUpload.css';

interface FileUploadProps {
  onFileSelect: (files: FileList) => void;
  accept?: string;
  multiple?: boolean;
  maxSize?: number;
}

export const FileUpload: React.FC<FileUploadProps> = ({
  onFileSelect,
  accept = '*',
  multiple = false,
  maxSize,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClick = () => inputRef.current?.click();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    if (maxSize) {
      const validFiles = Array.from(files).filter((f) => f.size <= maxSize);
      if (validFiles.length !== files.length) {
        console.warn('Some files exceeded max size');
      }
    }

    onFileSelect(files);
  };

  return (
    <div className="file-upload" onClick={handleClick}>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleChange}
        hidden
      />
      <div className="upload-icon">▣</div>
      <div className="upload-text">
        <span className="upload-primary">Click To Upload</span>
        <span className="upload-hint">Or Drag And Drop</span>
      </div>
    </div>
  );
};

export default FileUpload;
