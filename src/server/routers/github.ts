import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { TRPCError } from '@trpc/server';

const GITHUB_API = 'https://api.github.com';

interface GitHubRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  description: string | null;
  private: boolean;
  default_branch: string;
  updated_at: string;
}

interface GitHubBranch {
  name: string;
  protected: boolean;
}

async function githubFetch<T>(path: string, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`${GITHUB_API}${path}`, { headers });

  if (!response.ok) {
    if (response.status === 401) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'GitHub token is invalid or expired',
      });
    }
    if (response.status === 403) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'GitHub rate limit exceeded or access denied',
      });
    }
    if (response.status === 404) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'GitHub resource not found',
      });
    }
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `GitHub API error: ${response.status}`,
    });
  }

  return response.json();
}

function parseLinkHeader(header: string | null): { next?: string } {
  if (!header) return {};

  const links: { next?: string } = {};
  const parts = header.split(',');

  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match) {
      const [, url, rel] = match;
      if (rel === 'next') {
        // Extract page number from URL
        const pageMatch = url.match(/[?&]page=(\d+)/);
        if (pageMatch) {
          links.next = pageMatch[1];
        }
      }
    }
  }

  return links;
}

export const githubRouter = router({
  listRepos: protectedProcedure
    .input(
      z.object({
        search: z.string().optional(),
        cursor: z.string().optional(), // page number as string
        perPage: z.number().int().min(1).max(100).default(30),
      })
    )
    .query(async ({ input }) => {
      const token = process.env.GITHUB_TOKEN;

      if (!token) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'GitHub token is not configured',
        });
      }

      const page = input.cursor ? parseInt(input.cursor, 10) : 1;

      let repos: GitHubRepo[];
      let linkHeader: string | null = null;

      if (input.search) {
        // Search repositories
        const query = encodeURIComponent(`${input.search} in:name user:@me`);
        const url = `/search/repositories?q=${query}&per_page=${input.perPage}&page=${page}`;

        const headers: Record<string, string> = {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${token}`,
        };

        const response = await fetch(`${GITHUB_API}${url}`, { headers });
        linkHeader = response.headers.get('link');

        if (!response.ok) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `GitHub API error: ${response.status}`,
          });
        }

        const data = await response.json();
        repos = data.items;
      } else {
        // List user's repositories
        const url = `/user/repos?sort=updated&per_page=${input.perPage}&page=${page}`;

        const headers: Record<string, string> = {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          Authorization: `Bearer ${token}`,
        };

        const response = await fetch(`${GITHUB_API}${url}`, { headers });
        linkHeader = response.headers.get('link');

        if (!response.ok) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `GitHub API error: ${response.status}`,
          });
        }

        repos = await response.json();
      }

      const links = parseLinkHeader(linkHeader);

      return {
        repos: repos.map((r) => ({
          id: r.id,
          fullName: r.full_name,
          name: r.name,
          owner: r.owner.login,
          description: r.description,
          private: r.private,
          defaultBranch: r.default_branch,
          updatedAt: r.updated_at,
        })),
        nextCursor: links.next,
      };
    }),

  listBranches: protectedProcedure
    .input(
      z.object({
        repoFullName: z.string().regex(/^[\w-]+\/[\w.-]+$/),
      })
    )
    .query(async ({ input }) => {
      const token = process.env.GITHUB_TOKEN;

      if (!token) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'GitHub token is not configured',
        });
      }

      // Get repo info for default branch
      const repo = await githubFetch<GitHubRepo>(`/repos/${input.repoFullName}`, token);

      // Get branches
      const branches = await githubFetch<GitHubBranch[]>(
        `/repos/${input.repoFullName}/branches?per_page=100`,
        token
      );

      return {
        branches: branches.map((b) => ({
          name: b.name,
          protected: b.protected,
        })),
        defaultBranch: repo.default_branch,
      };
    }),
});
