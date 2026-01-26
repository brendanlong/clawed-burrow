'use client';

import type { ReactNode } from 'react';
import { createContext, useContext, useState, useEffect, useCallback } from 'react';

type Theme = 'light' | 'dark';
type ThemePreference = 'auto' | 'light' | 'dark';

interface ThemeContextType {
  theme: Theme;
  themePreference: ThemePreference;
  setThemePreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_KEY = 'theme_preference';

function getSystemTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (theme === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themePreference, setThemePreferenceState] = useState<ThemePreference>('auto');
  const [theme, setTheme] = useState<Theme>('light');
  const [isInitialized, setIsInitialized] = useState(false);

  // Initialize from localStorage
  useEffect(() => {
    // Using queueMicrotask to avoid synchronous setState in effect (React 19 lint rule)
    queueMicrotask(() => {
      const stored = localStorage.getItem(THEME_KEY) as ThemePreference | null;
      const preference = stored || 'auto';
      setThemePreferenceState(preference);

      const resolvedTheme = preference === 'auto' ? getSystemTheme() : preference;
      setTheme(resolvedTheme);
      applyTheme(resolvedTheme);
      setIsInitialized(true);
    });
  }, []);

  // Listen for system theme changes when in auto mode
  useEffect(() => {
    if (!isInitialized) return;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      if (themePreference === 'auto') {
        const newTheme = e.matches ? 'dark' : 'light';
        setTheme(newTheme);
        applyTheme(newTheme);
      }
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [themePreference, isInitialized]);

  const setThemePreference = useCallback((preference: ThemePreference) => {
    setThemePreferenceState(preference);
    localStorage.setItem(THEME_KEY, preference);

    const resolvedTheme = preference === 'auto' ? getSystemTheme() : preference;
    setTheme(resolvedTheme);
    applyTheme(resolvedTheme);
  }, []);

  return (
    <ThemeContext.Provider
      value={{
        theme,
        themePreference,
        setThemePreference,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return context;
}
