import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from './theme-context';

describe('theme-context', () => {
  const mockMatchMedia = vi.fn();
  let mockMediaQueryListeners: ((e: MediaQueryListEvent) => void)[] = [];

  beforeEach(() => {
    // Reset localStorage
    localStorage.clear();

    // Reset listeners
    mockMediaQueryListeners = [];

    // Mock matchMedia
    mockMatchMedia.mockReturnValue({
      matches: false,
      addEventListener: (_: string, listener: (e: MediaQueryListEvent) => void) => {
        mockMediaQueryListeners.push(listener);
      },
      removeEventListener: (_: string, listener: (e: MediaQueryListEvent) => void) => {
        mockMediaQueryListeners = mockMediaQueryListeners.filter((l) => l !== listener);
      },
    });
    window.matchMedia = mockMatchMedia;

    // Clear dark class
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should default to auto preference', async () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });

    // Wait for microtask to complete
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.themePreference).toBe('auto');
  });

  it('should default to light theme when system prefers light', async () => {
    mockMatchMedia.mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('should default to dark theme when system prefers dark', async () => {
    mockMatchMedia.mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });

    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('should persist theme preference to localStorage', async () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      result.current.setThemePreference('dark');
    });

    expect(localStorage.getItem('theme_preference')).toBe('dark');
    expect(result.current.themePreference).toBe('dark');
    expect(result.current.theme).toBe('dark');
  });

  it('should load theme preference from localStorage', async () => {
    localStorage.setItem('theme_preference', 'dark');

    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.themePreference).toBe('dark');
    expect(result.current.theme).toBe('dark');
  });

  it('should apply dark class when dark theme is active', async () => {
    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      result.current.setThemePreference('dark');
    });

    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('should remove dark class when light theme is active', async () => {
    document.documentElement.classList.add('dark');

    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    act(() => {
      result.current.setThemePreference('light');
    });

    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('should update theme when system preference changes in auto mode', async () => {
    mockMatchMedia.mockReturnValue({
      matches: false,
      addEventListener: (_: string, listener: (e: MediaQueryListEvent) => void) => {
        mockMediaQueryListeners.push(listener);
      },
      removeEventListener: vi.fn(),
    });

    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(result.current.theme).toBe('light');

    // Simulate system theme change
    act(() => {
      mockMediaQueryListeners.forEach((listener) => {
        listener({ matches: true } as MediaQueryListEvent);
      });
    });

    expect(result.current.theme).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('should not update theme when system preference changes in manual mode', async () => {
    mockMatchMedia.mockReturnValue({
      matches: false,
      addEventListener: (_: string, listener: (e: MediaQueryListEvent) => void) => {
        mockMediaQueryListeners.push(listener);
      },
      removeEventListener: (_: string, listener: (e: MediaQueryListEvent) => void) => {
        mockMediaQueryListeners = mockMediaQueryListeners.filter((l) => l !== listener);
      },
    });

    const { result } = renderHook(() => useTheme(), {
      wrapper: ThemeProvider,
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Set to manual light mode
    act(() => {
      result.current.setThemePreference('light');
    });

    // Wait for effect to re-run and register new listener
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Simulate system theme change
    act(() => {
      mockMediaQueryListeners.forEach((listener) => {
        listener({ matches: true } as MediaQueryListEvent);
      });
    });

    // Should stay in light mode
    expect(result.current.theme).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('should throw error when useTheme is used outside ThemeProvider', () => {
    expect(() => {
      renderHook(() => useTheme());
    }).toThrow('useTheme must be used within a ThemeProvider');
  });
});
