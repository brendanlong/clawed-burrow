'use client';

import Image from 'next/image';
import { cn } from '@/lib/utils';
import { useTheme } from '@/lib/theme-context';

interface LogoProps {
  /** Whether to show the animated (working) version */
  isWorking?: boolean;
  /** Size of the logo in pixels (defaults to 24) */
  size?: number;
  /** Additional CSS classes */
  className?: string;
}

function getLogoSrc(isWorking: boolean, isDark: boolean): string {
  if (isWorking) {
    return isDark ? '/favicon-working-dark.svg' : '/favicon-working.svg';
  }
  return isDark ? '/favicon-dark.svg' : '/favicon.svg';
}

/**
 * Logo component that displays the Clawed Abode logo.
 * Shows an animated version when isWorking is true.
 * Uses the dark variant in dark mode.
 */
export function Logo({ isWorking = false, size = 24, className }: LogoProps) {
  const { theme } = useTheme();
  const src = getLogoSrc(isWorking, theme === 'dark');

  return (
    <Image
      src={src}
      alt={isWorking ? 'Clawed Abode logo (working)' : 'Clawed Abode logo'}
      width={size}
      height={size}
      className={cn('flex-shrink-0', className)}
      priority
    />
  );
}
