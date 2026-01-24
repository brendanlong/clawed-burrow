'use client';

import Link from 'next/link';
import { AuthGuard } from '@/components/AuthGuard';
import { Header } from '@/components/Header';
import { SessionListContainer } from '@/components/SessionListContainer';
import { Button } from '@/components/ui/button';

export default function HomePage() {
  return (
    <AuthGuard>
      <div className="min-h-screen bg-background">
        <Header />

        <main className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
          <div className="px-4 py-6 sm:px-0">
            <div className="flex justify-between items-center mb-6">
              <h1 className="text-2xl font-bold">Sessions</h1>
              <Button asChild>
                <Link href="/new">New Session</Link>
              </Button>
            </div>

            <SessionListContainer />
          </div>
        </main>
      </div>
    </AuthGuard>
  );
}
