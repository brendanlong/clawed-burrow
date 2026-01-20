'use client';

import { useMemo } from 'react';
import { marked, Renderer } from 'marked';

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
      return typeof result === 'string' ? result : '';
    } catch {
      // Fallback to plain text if parsing fails
      return content;
    }
  }, [content]);

  return (
    <div className={`markdown-content ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
  );
}
