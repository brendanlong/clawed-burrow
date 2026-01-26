'use client';

import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface WorkingContextValue {
  /** Whether Claude is currently working */
  isWorking: boolean;
  /** Set the working state */
  setWorking: (isWorking: boolean) => void;
}

const WorkingContext = createContext<WorkingContextValue | null>(null);

interface WorkingProviderProps {
  children: ReactNode;
}

/**
 * Provider for the global working state.
 * Used to share whether Claude is currently working across components.
 */
export function WorkingProvider({ children }: WorkingProviderProps) {
  const [isWorking, setIsWorking] = useState(false);

  const setWorking = useCallback((working: boolean) => {
    setIsWorking(working);
  }, []);

  return (
    <WorkingContext.Provider value={{ isWorking, setWorking }}>{children}</WorkingContext.Provider>
  );
}

/**
 * Hook to access the working state context.
 * Returns { isWorking: false, setWorking: no-op } if used outside provider.
 */
export function useWorkingContext(): WorkingContextValue {
  const context = useContext(WorkingContext);
  if (!context) {
    // Return a default value instead of throwing, so the Header can be used
    // on pages without the WorkingProvider
    return { isWorking: false, setWorking: () => {} };
  }
  return context;
}
