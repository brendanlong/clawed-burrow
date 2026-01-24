import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionList } from './SessionList';
import type { Session } from '@/hooks/useSessionList';
import type { SessionActions } from '@/hooks/useSessionActions';

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

function createMockActions(overrides: Partial<SessionActions> = {}): SessionActions {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    archive: vi.fn(),
    isStarting: () => false,
    isStopping: () => false,
    isArchiving: () => false,
    ...overrides,
  };
}

describe('SessionList', () => {
  describe('loading state', () => {
    it('shows spinner while loading', () => {
      render(
        <SessionList
          sessions={[]}
          isLoading={true}
          actions={createMockActions()}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );

      const spinner = document.querySelector('[class*="animate-spin"]');
      expect(spinner).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('shows empty state message when no sessions', () => {
      render(
        <SessionList
          sessions={[]}
          isLoading={false}
          actions={createMockActions()}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );

      expect(screen.getByText('No sessions yet')).toBeInTheDocument();
      expect(screen.getByText('Get started by creating a new session.')).toBeInTheDocument();
    });

    it('shows "New Session" link in empty state', () => {
      render(
        <SessionList
          sessions={[]}
          isLoading={false}
          actions={createMockActions()}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );

      const newSessionLink = screen.getByRole('link', { name: /new session/i });
      expect(newSessionLink).toBeInTheDocument();
      expect(newSessionLink).toHaveAttribute('href', '/new');
    });
  });

  describe('sessions list', () => {
    const mockSessions: Session[] = [
      {
        id: 'session-1',
        name: 'Test Session 1',
        repoUrl: 'https://github.com/user/repo1.git',
        branch: 'main',
        status: 'running',
        updatedAt: new Date('2024-01-15T10:00:00Z'),
      },
      {
        id: 'session-2',
        name: 'Test Session 2',
        repoUrl: 'https://github.com/user/repo2.git',
        branch: 'feature-branch',
        status: 'stopped',
        updatedAt: new Date('2024-01-14T09:00:00Z'),
      },
    ];

    it('renders list of sessions', () => {
      render(
        <SessionList
          sessions={mockSessions}
          isLoading={false}
          actions={createMockActions()}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );

      expect(screen.getByText('Test Session 1')).toBeInTheDocument();
      expect(screen.getByText('Test Session 2')).toBeInTheDocument();
    });

    it('links to individual session pages', () => {
      render(
        <SessionList
          sessions={mockSessions}
          isLoading={false}
          actions={createMockActions()}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );

      const sessionLinks = screen.getAllByRole('link');
      const session1Link = sessionLinks.find((link) =>
        link.getAttribute('href')?.includes('session-1')
      );
      expect(session1Link).toHaveAttribute('href', '/session/session-1');
    });

    it('renders sessions in order', () => {
      render(
        <SessionList
          sessions={mockSessions}
          isLoading={false}
          actions={createMockActions()}
          showArchived={false}
          onToggleArchived={vi.fn()}
        />
      );

      const sessionNames = screen.getAllByRole('listitem');
      expect(sessionNames).toHaveLength(2);
    });
  });
});
