'use client';

import Image from 'next/image';
import { cn } from '@/lib/utils';

interface LogoProps {
  /** Whether to show the animated (working) version */
  isWorking?: boolean;
  /** Size of the logo in pixels (defaults to 24) */
  size?: number;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Logo component that displays the Clawed Abode logo.
 * Shows an animated version when isWorking is true.
 */
export function Logo({ isWorking = false, size = 24, className }: LogoProps) {
  return (
    <Image
      src={isWorking ? '/favicon-working.svg' : '/favicon.svg'}
      alt={isWorking ? 'Clawed Abode logo (working)' : 'Clawed Abode logo'}
      width={size}
      height={size}
      className={cn('flex-shrink-0', className)}
      priority
    />
  );
}
