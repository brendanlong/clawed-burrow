'use client';

import { useMemo } from 'react';
import { marked, Renderer } from 'marked';
import DOMPurify from 'dompurify';

interface MarkdownContentProps {
  content: string;
  className?: string;
}

// Create custom renderer that opens links in new windows
const renderer = new Renderer();
renderer.link = ({ href, title, text }) => {
  const titleAttr = title ? ` title="${title}"` : '';
  return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`;
};

// Configure marked options
marked.setOptions({
  gfm: true, // GitHub Flavored Markdown
  breaks: true, // Convert \n to <br>
  renderer,
});

export function MarkdownContent({ content, className = '' }: MarkdownContentProps) {
  const html = useMemo(() => {
    try {
      const result = marked.parse(content);
      // marked.parse can return string or Promise<string>, but with sync options it returns string
      const rawHtml = typeof result === 'string' ? result : '';
      // Sanitize HTML to prevent XSS attacks
      return DOMPurify.sanitize(rawHtml);
    } catch {
      // Fallback to sanitized plain text if parsing fails
      return DOMPurify.sanitize(content);
    }
  }, [content]);

  return (
    <div className={`markdown-content ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
