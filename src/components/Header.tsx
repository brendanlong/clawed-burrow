'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';
import { Button } from '@/components/ui/button';

export function Header() {
  const { isAuthenticated, logout } = useAuth();

  return (
    <header className="bg-background border-b">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center h-16">
          <Link href="/" className="flex items-center space-x-2">
            <span className="text-xl font-bold">Claude Code Local Web</span>
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
