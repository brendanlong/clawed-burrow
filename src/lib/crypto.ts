import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const MIN_KEY_LENGTH = 32;

/**
 * Get the encryption key from environment
 * Reads directly from process.env to support dynamic env changes in tests
 */
function getEncryptionKey(): string | undefined {
  return process.env.ENCRYPTION_KEY;
}

/**
 * Check if encryption is properly configured
 */
export function isEncryptionConfigured(): boolean {
  const key = getEncryptionKey();
  return !!key && key.length >= MIN_KEY_LENGTH;
}

/**
 * Derive a 32-byte key from the ENCRYPTION_KEY env var
 * Uses SHA-256 to ensure consistent key length regardless of input
 */
function deriveKey(): Buffer {
  const key = getEncryptionKey();
  if (!key) {
    throw new Error('ENCRYPTION_KEY is not configured');
  }
  return createHash('sha256').update(key).digest();
}

/**
 * Encrypt a plaintext string using AES-256-GCM
 * @returns Encrypted string in format: base64(iv):base64(tag):base64(ciphertext)
 */
export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const tag = cipher.getAuthTag();

  return `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypt a ciphertext string encrypted with encrypt()
 * @param ciphertext String in format: base64(iv):base64(tag):base64(ciphertext)
 * @returns Decrypted plaintext
 */
export function decrypt(ciphertext: string): string {
  const key = deriveKey();
  const parts = ciphertext.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format: expected iv:tag:encrypted');
  }

  const [ivB64, tagB64, encrypted] = parts;

  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');

  if (iv.length !== IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${IV_LENGTH}, got ${iv.length}`);
  }

  if (tag.length !== TAG_LENGTH) {
    throw new Error(`Invalid tag length: expected ${TAG_LENGTH}, got ${tag.length}`);
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}
