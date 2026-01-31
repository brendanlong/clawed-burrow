import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('crypto', () => {
  const originalEnv = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    // Reset module cache to pick up new env vars
    vi.resetModules();
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalEnv;
    vi.resetModules();
  });

  describe('with ENCRYPTION_KEY configured', () => {
    beforeEach(() => {
      // Set a valid encryption key (32+ characters)
      process.env.ENCRYPTION_KEY = 'test-encryption-key-that-is-at-least-32-chars-long';
    });

    it('should encrypt and decrypt a simple string', async () => {
      const { encrypt, decrypt } = await import('./crypto');
      const plaintext = 'Hello, World!';

      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt an empty string', async () => {
      const { encrypt, decrypt } = await import('./crypto');
      const plaintext = '';

      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt unicode characters', async () => {
      const { encrypt, decrypt } = await import('./crypto');
      const plaintext = '你好世界 🌍 مرحبا';

      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt a long string', async () => {
      const { encrypt, decrypt } = await import('./crypto');
      const plaintext = 'a'.repeat(10000);

      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt JSON content', async () => {
      const { encrypt, decrypt } = await import('./crypto');
      const obj = { apiKey: 'sk-secret-123', nested: { value: true } };
      const plaintext = JSON.stringify(obj);

      const encrypted = encrypt(plaintext);
      const decrypted = decrypt(encrypted);

      expect(JSON.parse(decrypted)).toEqual(obj);
    });

    it('should produce different ciphertext for same plaintext (random IV)', async () => {
      const { encrypt } = await import('./crypto');
      const plaintext = 'same input';

      const encrypted1 = encrypt(plaintext);
      const encrypted2 = encrypt(plaintext);

      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should produce ciphertext in expected format (iv:tag:data)', async () => {
      const { encrypt } = await import('./crypto');
      const encrypted = encrypt('test');

      const parts = encrypted.split(':');
      expect(parts).toHaveLength(3);

      // Each part should be valid base64
      parts.forEach((part) => {
        expect(() => Buffer.from(part, 'base64')).not.toThrow();
      });
    });

    it('should fail to decrypt with invalid format', async () => {
      const { decrypt } = await import('./crypto');

      expect(() => decrypt('invalid')).toThrow('Invalid ciphertext format');
      expect(() => decrypt('a:b')).toThrow('Invalid ciphertext format');
      expect(() => decrypt('a:b:c:d')).toThrow('Invalid ciphertext format');
    });

    it('should fail to decrypt with tampered ciphertext', async () => {
      const { encrypt, decrypt } = await import('./crypto');
      const encrypted = encrypt('secret data');

      // Tamper with the encrypted data
      const parts = encrypted.split(':');
      parts[2] = Buffer.from('tampered').toString('base64');
      const tampered = parts.join(':');

      expect(() => decrypt(tampered)).toThrow();
    });

    it('should fail to decrypt with tampered tag', async () => {
      const { encrypt, decrypt } = await import('./crypto');
      const encrypted = encrypt('secret data');

      // Tamper with the auth tag
      const parts = encrypted.split(':');
      const tag = Buffer.from(parts[1], 'base64');
      tag[0] = tag[0] ^ 0xff; // Flip bits
      parts[1] = tag.toString('base64');
      const tampered = parts.join(':');

      expect(() => decrypt(tampered)).toThrow();
    });

    it('should report encryption as configured', async () => {
      const { isEncryptionConfigured } = await import('./crypto');
      expect(isEncryptionConfigured()).toBe(true);
    });
  });

  describe('without ENCRYPTION_KEY configured', () => {
    beforeEach(() => {
      delete process.env.ENCRYPTION_KEY;
    });

    it('should report encryption as not configured', async () => {
      const { isEncryptionConfigured } = await import('./crypto');
      expect(isEncryptionConfigured()).toBe(false);
    });

    it('should throw when trying to encrypt', async () => {
      const { encrypt } = await import('./crypto');
      expect(() => encrypt('test')).toThrow('ENCRYPTION_KEY is not configured');
    });

    it('should throw when trying to decrypt', async () => {
      const { decrypt } = await import('./crypto');
      // Valid format but will fail because no key
      expect(() => decrypt('aaa:bbb:ccc')).toThrow('ENCRYPTION_KEY is not configured');
    });
  });

  describe('with short ENCRYPTION_KEY', () => {
    beforeEach(() => {
      process.env.ENCRYPTION_KEY = 'short';
    });

    it('should report encryption as not configured', async () => {
      const { isEncryptionConfigured } = await import('./crypto');
      expect(isEncryptionConfigured()).toBe(false);
    });
  });
});
