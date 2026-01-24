import { randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import { z } from 'zod';

const TOKEN_LENGTH = 32; // 256 bits of entropy
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
export const TOKEN_ROTATION_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
export const ACTIVITY_UPDATE_THROTTLE_MS = 60 * 1000; // 1 minute - minimum time between activity updates

export const loginSchema = z.object({
  password: z.string().min(1, 'Password is required'),
});

export type LoginInput = z.infer<typeof loginSchema>;

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

export function generateSessionToken(): string {
  return randomBytes(TOKEN_LENGTH).toString('hex');
}

export function parseAuthHeader(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer' || !parts[1]) return null;
  return parts[1];
}
