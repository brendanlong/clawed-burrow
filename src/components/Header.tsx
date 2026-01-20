'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

export function Header() {
  const { isAuthenticated, logout } = useAuth();

  return (
    <header className="bg-background border-b">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <Link href="/" className="flex items-center space-x-2">
            <span className="text-xl font-bold">
              Claude Code
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="text-xs align-super cursor-help ml-0.5">*</span>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p className="max-w-xs text-sm">
                      This is an unofficial community project and is not affiliated with, endorsed
                      by, or supported by Anthropic.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>{' '}
              Local Web
            </span>
          </Link>

          {isAuthenticated && (
            <Button variant="ghost" size="sm" onClick={logout}>
              Sign out
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
