import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  toError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
}));

// Import the router after mocks are set up
import { githubRouter } from './github';
import { router } from '../trpc';

// Create a test caller with proper context
const createCaller = (sessionId: string | null) => {
  const testRouter = router({
    github: githubRouter,
  });
  return testRouter.createCaller({ sessionId, rotatedToken: null });
};

// Helper to create mock Response
function createMockResponse(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(data),
    headers: {
      get: (name: string) => headers[name.toLowerCase()] || null,
    },
  };
}

describe('githubRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_TOKEN = 'test-github-token';
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('listRepos', () => {
    it('should list user repositories', async () => {
      const mockRepos = [
        {
          id: 1,
          full_name: 'owner/repo1',
          name: 'repo1',
          owner: { login: 'owner' },
          description: 'Test repo 1',
          private: false,
          default_branch: 'main',
          updated_at: '2024-01-01T00:00:00Z',
        },
        {
          id: 2,
          full_name: 'owner/repo2',
          name: 'repo2',
          owner: { login: 'owner' },
          description: null,
          private: true,
          default_branch: 'master',
          updated_at: '2024-01-02T00:00:00Z',
        },
      ];

      mockFetch.mockResolvedValue(createMockResponse(mockRepos));

      const caller = createCaller('auth-session-id');
      const result = await caller.github.listRepos({});

      expect(result.repos).toHaveLength(2);
      expect(result.repos[0]).toMatchObject({
        id: 1,
        fullName: 'owner/repo1',
        name: 'repo1',
        owner: 'owner',
        description: 'Test repo 1',
        private: false,
        defaultBranch: 'main',
      });
      expect(result.repos[1].description).toBeNull();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/user/repos'),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer test-github-token',
          }),
        })
      );
    });

    it('should search repositories', async () => {
      const mockSearchResult = {
        items: [
          {
            id: 1,
            full_name: 'owner/search-result',
            name: 'search-result',
            owner: { login: 'owner' },
            description: 'Found by search',
            private: false,
            default_branch: 'main',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ],
      };

      mockFetch.mockResolvedValue(createMockResponse(mockSearchResult));

      const caller = createCaller('auth-session-id');
      const result = await caller.github.listRepos({ search: 'test' });

      expect(result.repos).toHaveLength(1);
      expect(result.repos[0].fullName).toBe('owner/search-result');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/search/repositories'),
        expect.any(Object)
      );
    });

    it('should support pagination with cursor', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse([], 200, {
          link: '<https://api.github.com/user/repos?page=3>; rel="next"',
        })
      );

      const caller = createCaller('auth-session-id');
      const result = await caller.github.listRepos({ cursor: '2' });

      expect(result.nextCursor).toBe('3');
      expect(mockFetch).toHaveBeenCalledWith(expect.stringContaining('page=2'), expect.any(Object));
    });

    it('should throw PRECONDITION_FAILED if no GitHub token', async () => {
      delete process.env.GITHUB_TOKEN;

      const caller = createCaller('auth-session-id');

      await expect(caller.github.listRepos({})).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
        message: 'GitHub token is not configured',
      });
    });

    it('should handle GitHub API errors', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, 500));

      const caller = createCaller('auth-session-id');

      await expect(caller.github.listRepos({})).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'GitHub API error: 500',
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(caller.github.listRepos({})).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('listBranches', () => {
    it('should list branches for a repository', async () => {
      const mockRepo = {
        default_branch: 'main',
      };

      const mockBranches = [
        { name: 'main', protected: true },
        { name: 'develop', protected: false },
        { name: 'feature/test', protected: false },
      ];

      mockFetch
        .mockResolvedValueOnce(createMockResponse(mockRepo))
        .mockResolvedValueOnce(createMockResponse(mockBranches));

      const caller = createCaller('auth-session-id');
      const result = await caller.github.listBranches({
        repoFullName: 'owner/repo',
      });

      expect(result.branches).toHaveLength(3);
      expect(result.defaultBranch).toBe('main');
      expect(result.branches[0]).toMatchObject({
        name: 'main',
        protected: true,
      });
    });

    it('should throw PRECONDITION_FAILED if no GitHub token', async () => {
      delete process.env.GITHUB_TOKEN;

      const caller = createCaller('auth-session-id');

      await expect(
        caller.github.listBranches({ repoFullName: 'owner/repo' })
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });

    it('should throw NOT_FOUND for non-existent repo', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, 404));

      const caller = createCaller('auth-session-id');

      await expect(
        caller.github.listBranches({ repoFullName: 'owner/nonexistent' })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'GitHub resource not found',
      });
    });

    it('should validate repoFullName format', async () => {
      const caller = createCaller('auth-session-id');

      await expect(caller.github.listBranches({ repoFullName: 'invalid' })).rejects.toThrow();
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.github.listBranches({ repoFullName: 'owner/repo' })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('listIssues', () => {
    it('should list issues for a repository', async () => {
      const mockIssues = [
        {
          id: 1,
          number: 123,
          title: 'Bug report',
          body: 'Description of the bug',
          state: 'open',
          user: { login: 'reporter' },
          labels: [{ name: 'bug', color: 'd73a4a' }],
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
        },
        {
          id: 2,
          number: 124,
          title: 'Feature request',
          body: null,
          state: 'open',
          user: null,
          labels: [],
          created_at: '2024-01-03T00:00:00Z',
          updated_at: '2024-01-04T00:00:00Z',
        },
      ];

      mockFetch.mockResolvedValue(createMockResponse(mockIssues));

      const caller = createCaller('auth-session-id');
      const result = await caller.github.listIssues({
        repoFullName: 'owner/repo',
      });

      expect(result.issues).toHaveLength(2);
      expect(result.issues[0]).toMatchObject({
        id: 1,
        number: 123,
        title: 'Bug report',
        body: 'Description of the bug',
        state: 'open',
        author: 'reporter',
        labels: [{ name: 'bug', color: 'd73a4a' }],
      });
      expect(result.issues[1].author).toBe('unknown');
      expect(result.issues[1].body).toBeNull();
    });

    it('should filter issues by state', async () => {
      mockFetch.mockResolvedValue(createMockResponse([]));

      const caller = createCaller('auth-session-id');
      await caller.github.listIssues({
        repoFullName: 'owner/repo',
        state: 'closed',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('state=closed'),
        expect.any(Object)
      );
    });

    it('should search issues', async () => {
      const mockSearchResult = {
        items: [
          {
            id: 1,
            number: 100,
            title: 'Found issue',
            body: null,
            state: 'open',
            user: { login: 'user' },
            labels: [],
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-02T00:00:00Z',
          },
        ],
      };

      mockFetch.mockResolvedValue(createMockResponse(mockSearchResult));

      const caller = createCaller('auth-session-id');
      const result = await caller.github.listIssues({
        repoFullName: 'owner/repo',
        search: 'authentication',
      });

      expect(result.issues).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/search/issues'),
        expect.any(Object)
      );
    });

    it('should filter out pull requests', async () => {
      const mockIssues = [
        {
          id: 1,
          number: 123,
          title: 'Regular issue',
          body: null,
          state: 'open',
          user: { login: 'user' },
          labels: [],
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
        },
        {
          id: 2,
          number: 124,
          title: 'This is a PR',
          body: null,
          state: 'open',
          user: { login: 'user' },
          labels: [],
          created_at: '2024-01-01T00:00:00Z',
          updated_at: '2024-01-02T00:00:00Z',
          pull_request: { url: 'https://...' },
        },
      ];

      mockFetch.mockResolvedValue(createMockResponse(mockIssues));

      const caller = createCaller('auth-session-id');
      const result = await caller.github.listIssues({
        repoFullName: 'owner/repo',
      });

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].title).toBe('Regular issue');
    });

    it('should support pagination', async () => {
      mockFetch.mockResolvedValue(
        createMockResponse([], 200, {
          link: '<https://api.github.com/repos/owner/repo/issues?page=3>; rel="next"',
        })
      );

      const caller = createCaller('auth-session-id');
      const result = await caller.github.listIssues({
        repoFullName: 'owner/repo',
        cursor: '2',
      });

      expect(result.nextCursor).toBe('3');
    });

    it('should throw PRECONDITION_FAILED if no GitHub token', async () => {
      delete process.env.GITHUB_TOKEN;

      const caller = createCaller('auth-session-id');

      await expect(caller.github.listIssues({ repoFullName: 'owner/repo' })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(caller.github.listIssues({ repoFullName: 'owner/repo' })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('getIssue', () => {
    it('should get a specific issue', async () => {
      const mockIssue = {
        id: 1,
        number: 123,
        title: 'Test Issue',
        body: 'Issue description',
        state: 'open',
        user: { login: 'author' },
        labels: [
          { name: 'enhancement', color: 'a2eeef' },
          { name: 'help wanted', color: '008672' },
        ],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      };

      mockFetch.mockResolvedValue(createMockResponse(mockIssue));

      const caller = createCaller('auth-session-id');
      const result = await caller.github.getIssue({
        repoFullName: 'owner/repo',
        issueNumber: 123,
      });

      expect(result.issue).toMatchObject({
        id: 1,
        number: 123,
        title: 'Test Issue',
        body: 'Issue description',
        state: 'open',
        author: 'author',
        labels: [
          { name: 'enhancement', color: 'a2eeef' },
          { name: 'help wanted', color: '008672' },
        ],
      });
    });

    it('should handle issue with no body', async () => {
      const mockIssue = {
        id: 1,
        number: 123,
        title: 'No body issue',
        body: null,
        state: 'closed',
        user: { login: 'user' },
        labels: [],
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      };

      mockFetch.mockResolvedValue(createMockResponse(mockIssue));

      const caller = createCaller('auth-session-id');
      const result = await caller.github.getIssue({
        repoFullName: 'owner/repo',
        issueNumber: 123,
      });

      expect(result.issue.body).toBeNull();
    });

    it('should throw NOT_FOUND for non-existent issue', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, 404));

      const caller = createCaller('auth-session-id');

      await expect(
        caller.github.getIssue({
          repoFullName: 'owner/repo',
          issueNumber: 99999,
        })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    it('should throw UNAUTHORIZED for invalid token', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, 401));

      const caller = createCaller('auth-session-id');

      await expect(
        caller.github.getIssue({
          repoFullName: 'owner/repo',
          issueNumber: 123,
        })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'GitHub token is invalid or expired',
      });
    });

    it('should throw FORBIDDEN for rate limit or access denied', async () => {
      mockFetch.mockResolvedValue(createMockResponse({}, 403));

      const caller = createCaller('auth-session-id');

      await expect(
        caller.github.getIssue({
          repoFullName: 'owner/repo',
          issueNumber: 123,
        })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: 'GitHub rate limit exceeded or access denied',
      });
    });

    it('should throw PRECONDITION_FAILED if no GitHub token', async () => {
      delete process.env.GITHUB_TOKEN;

      const caller = createCaller('auth-session-id');

      await expect(
        caller.github.getIssue({
          repoFullName: 'owner/repo',
          issueNumber: 123,
        })
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    });

    it('should validate repoFullName format', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.github.getIssue({
          repoFullName: 'invalid',
          issueNumber: 123,
        })
      ).rejects.toThrow();
    });

    it('should validate issueNumber is positive', async () => {
      const caller = createCaller('auth-session-id');

      await expect(
        caller.github.getIssue({
          repoFullName: 'owner/repo',
          issueNumber: 0,
        })
      ).rejects.toThrow();

      await expect(
        caller.github.getIssue({
          repoFullName: 'owner/repo',
          issueNumber: -1,
        })
      ).rejects.toThrow();
    });

    it('should require authentication', async () => {
      const caller = createCaller(null);

      await expect(
        caller.github.getIssue({
          repoFullName: 'owner/repo',
          issueNumber: 123,
        })
      ).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });
});
