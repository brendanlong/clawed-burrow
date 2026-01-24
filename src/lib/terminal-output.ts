import AnsiToHtml from 'ansi-to-html';
import DOMPurify from 'dompurify';

// Singleton converter instance with sensible defaults
const converter = new AnsiToHtml({
  fg: 'var(--terminal-fg)',
  bg: 'var(--terminal-bg)',
  newline: true,
  escapeXML: true, // Security: escape HTML in the output
  colors: {
    // Standard ANSI colors - using CSS variables for theme support
    0: 'var(--ansi-black)',
    1: 'var(--ansi-red)',
    2: 'var(--ansi-green)',
    3: 'var(--ansi-yellow)',
    4: 'var(--ansi-blue)',
    5: 'var(--ansi-magenta)',
    6: 'var(--ansi-cyan)',
    7: 'var(--ansi-white)',
    // Bright colors
    8: 'var(--ansi-bright-black)',
    9: 'var(--ansi-bright-red)',
    10: 'var(--ansi-bright-green)',
    11: 'var(--ansi-bright-yellow)',
    12: 'var(--ansi-bright-blue)',
    13: 'var(--ansi-bright-magenta)',
    14: 'var(--ansi-bright-cyan)',
    15: 'var(--ansi-bright-white)',
  },
});

/**
 * Simulates terminal behavior for carriage returns.
 * When a line contains \r, only the content after the last \r is kept
 * (simulating how a terminal overwrites the line).
 *
 * This handles progress bars like tqdm which output:
 *   "  0%|          | 0/25\r  4%|▍         | 1/25\r..."
 * and converts to just the final progress state.
 */
function processCarriageReturns(text: string): string {
  // Split by newlines, preserving them
  const lines = text.split('\n');

  const processedLines = lines.map((line) => {
    // If line contains \r, split and keep only the last segment
    // (simulating terminal overwrite behavior)
    if (line.includes('\r')) {
      const segments = line.split('\r');
      // Get the last non-empty segment
      for (let i = segments.length - 1; i >= 0; i--) {
        if (segments[i].trim() !== '') {
          return segments[i];
        }
      }
      return segments[segments.length - 1];
    }
    return line;
  });

  // Remove consecutive duplicate lines (collapsed progress states)
  const deduped: string[] = [];
  for (const line of processedLines) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== line) {
      deduped.push(line);
    }
  }

  return deduped.join('\n');
}

/**
 * Strip all ANSI escape codes from text.
 * Useful when you want plain text without colors.
 */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Process terminal output for display:
 * 1. Handle carriage returns (progress bars)
 * 2. Convert ANSI color codes to HTML spans
 * 3. Sanitize HTML to prevent XSS attacks
 *
 * Returns sanitized HTML string that can be rendered with dangerouslySetInnerHTML.
 */
export function processTerminalOutput(text: string): string {
  // First, simulate terminal carriage return behavior
  const processed = processCarriageReturns(text);

  // Then convert ANSI codes to HTML
  const html = converter.toHtml(processed);

  // Sanitize the output to prevent XSS (defense in depth)
  return DOMPurify.sanitize(html);
}

/**
 * Check if text contains ANSI escape codes.
 */
export function hasAnsiCodes(text: string): boolean {
  return /\x1b\[[0-9;]*m/.test(text);
}

/**
 * Check if text appears to be terminal output that would benefit from processing.
 * Returns true if it has ANSI codes or carriage returns.
 */
export function isTerminalOutput(text: string): boolean {
  return hasAnsiCodes(text) || text.includes('\r');
}
