import React from 'react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';

const modules = {
  toolbar: [
    [{ header: [1, 2, 3, false] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ color: [] }, { background: [] }],
    [{ size: ['small', false, 'large', 'huge'] }],
    [{ list: 'ordered' }, { list: 'bullet' }],
    [{ align: [] }],
    ['link', 'image'],
    ['clean']
  ],
  clipboard: { matchVisual: false }
};

const formats = [
  'header', 'bold', 'italic', 'underline', 'strike',
  'color', 'background', 'size',
  'list', 'bullet', 'align',
  'link', 'image'
];

export default function RichTextEditor({ value, onChange, placeholder }) {
  return (
    <div className="rich-editor-wrap">
      <ReactQuill
        theme="snow"
        value={value || ''}
        onChange={onChange}
        modules={modules}
        formats={formats}
        placeholder={placeholder || 'Matn kiriting...'}
      />
    </div>
  );
}
