import simpleGit from 'simple-git';
import { mkdir, rm, access } from 'fs/promises';
import { join } from 'path';
import { env } from '@/lib/env';

const REPOS_DIR = join(env.DATA_DIR, 'repos');
const WORKTREES_DIR = join(env.DATA_DIR, 'worktrees');

export interface CloneResult {
  repoPath: string;
}

export interface WorktreeResult {
  worktreePath: string;
}

function getRepoPath(repoFullName: string): string {
  return join(REPOS_DIR, repoFullName.replace('/', '_'));
}

function getWorktreePath(sessionId: string): string {
  return join(WORKTREES_DIR, sessionId);
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // Directory might already exist
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function cloneOrFetchRepo(
  repoFullName: string,
  githubToken?: string
): Promise<CloneResult> {
  await ensureDir(REPOS_DIR);

  const repoPath = getRepoPath(repoFullName);
  const repoUrl = githubToken
    ? `https://${githubToken}@github.com/${repoFullName}.git`
    : `https://github.com/${repoFullName}.git`;

  if (await pathExists(repoPath)) {
    // Repo exists, fetch latest
    const git = simpleGit(repoPath);
    await git.fetch(['--all', '--prune']);
    return { repoPath };
  }

  // Clone fresh
  const git = simpleGit();
  await git.clone(repoUrl, repoPath, ['--bare']);

  return { repoPath };
}

export async function createWorktree(
  repoFullName: string,
  branch: string,
  sessionId: string
): Promise<WorktreeResult> {
  await ensureDir(WORKTREES_DIR);

  const repoPath = getRepoPath(repoFullName);
  const worktreePath = getWorktreePath(sessionId);

  const git = simpleGit(repoPath);

  // Create worktree for the branch
  await git.raw(['worktree', 'add', worktreePath, branch]);

  return { worktreePath };
}

export async function removeWorktree(sessionId: string): Promise<void> {
  const worktreePath = getWorktreePath(sessionId);

  if (!(await pathExists(worktreePath))) {
    return;
  }

  // Find the parent repo by checking worktree list
  // Since we use bare repos, we need to find which repo owns this worktree
  const reposDir = REPOS_DIR;
  const { readdir } = await import('fs/promises');
  const repos = await readdir(reposDir);

  for (const repo of repos) {
    const repoPath = join(reposDir, repo);
    try {
      const git = simpleGit(repoPath);
      await git.raw(['worktree', 'remove', worktreePath, '--force']);
      return;
    } catch {
      // Not the right repo, continue
    }
  }

  // Fallback: just delete the directory
  await rm(worktreePath, { recursive: true, force: true });
}

export async function getDefaultBranch(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath);

  try {
    // Try to get the HEAD reference
    const result = await git.raw(['symbolic-ref', '--short', 'HEAD']);
    return result.trim();
  } catch {
    // Fallback to main or master
    const branches = await git.branch();
    if (branches.all.includes('main')) return 'main';
    if (branches.all.includes('master')) return 'master';
    return branches.all[0] || 'main';
  }
}

export async function listBranches(repoPath: string): Promise<string[]> {
  const git = simpleGit(repoPath);
  const branches = await git.branch(['-a']);

  // Filter and clean branch names
  return branches.all
    .map((b) => b.replace(/^remotes\/origin\//, ''))
    .filter((b) => !b.includes('HEAD'))
    .filter((v, i, a) => a.indexOf(v) === i); // Unique
}

export function buildWorktreePath(sessionId: string): string {
  return getWorktreePath(sessionId);
}
