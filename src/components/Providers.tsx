'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { trpc, createTRPCClient } from '@/lib/trpc';
import { AuthProvider } from '@/lib/auth-context';
import { WorkingProvider } from '@/lib/working-context';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() => createTRPCClient());

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <WorkingProvider>{children}</WorkingProvider>
        </AuthProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
