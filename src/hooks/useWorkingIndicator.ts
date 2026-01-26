'use client';

import { useEffect } from 'react';

/**
 * Hook for managing working state indicators.
 * Updates the page title and favicon when Claude is working.
 *
 * @param sessionName - The name of the current session (optional)
 * @param isWorking - Whether Claude is currently working
 */
export function useWorkingIndicator(sessionName: string | undefined, isWorking: boolean) {
  // Dynamic page title based on Claude running state
  useEffect(() => {
    if (!sessionName) return;
    const baseTitle = `${sessionName} - Clawed Abode`;
    document.title = isWorking ? `Working - ${baseTitle}` : baseTitle;

    return () => {
      document.title = 'Clawed Abode';
    };
  }, [sessionName, isWorking]);

  // Dynamic favicon based on Claude running state
  useEffect(() => {
    const faviconPath = isWorking ? '/favicon-working.svg' : '/favicon.svg';
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/svg+xml';
      document.head.appendChild(link);
    }
    link.href = faviconPath;

    return () => {
      const linkEl = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
      if (linkEl) {
        linkEl.href = '/favicon.svg';
      }
    };
  }, [isWorking]);
}

/**
 * Hook that just returns the working state without side effects.
 * Useful for components that need to display working state visually
 * without managing the document title/favicon.
 *
 * @param isWorking - Whether Claude is currently working
 * @returns Object with the current working state
 */
export function useWorkingState(isWorking: boolean) {
  return { isWorking };
}
