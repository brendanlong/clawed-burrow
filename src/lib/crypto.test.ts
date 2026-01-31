import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, isEncryptionConfigured } from './crypto';

describe('crypto', () => {
  // Use explicit key for all tests - no mocking needed
  const TEST_KEY = 'test-encryption-key-that-is-at-least-32-chars-long';

  describe('with valid key', () => {
    it('should encrypt and decrypt a simple string', () => {
      const plaintext = 'Hello, World!';

      const encrypted = encrypt(plaintext, TEST_KEY);
      const decrypted = decrypt(encrypted, TEST_KEY);

      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt an empty string', () => {
      const plaintext = '';

      const encrypted = encrypt(plaintext, TEST_KEY);
      const decrypted = decrypt(encrypted, TEST_KEY);

      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt unicode characters', () => {
      const plaintext = '你好世界 🌍 مرحبا';

      const encrypted = encrypt(plaintext, TEST_KEY);
      const decrypted = decrypt(encrypted, TEST_KEY);

      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt a long string', () => {
      const plaintext = 'a'.repeat(10000);

      const encrypted = encrypt(plaintext, TEST_KEY);
      const decrypted = decrypt(encrypted, TEST_KEY);

      expect(decrypted).toBe(plaintext);
    });

    it('should encrypt and decrypt JSON content', () => {
      const obj = { apiKey: 'sk-secret-123', nested: { value: true } };
      const plaintext = JSON.stringify(obj);

      const encrypted = encrypt(plaintext, TEST_KEY);
      const decrypted = decrypt(encrypted, TEST_KEY);

      expect(JSON.parse(decrypted)).toEqual(obj);
    });

    it('should produce different ciphertext for same plaintext (random IV)', () => {
      const plaintext = 'same input';

      const encrypted1 = encrypt(plaintext, TEST_KEY);
      const encrypted2 = encrypt(plaintext, TEST_KEY);

      expect(encrypted1).not.toBe(encrypted2);
    });

    it('should produce ciphertext in expected format (iv:tag:data)', () => {
      const encrypted = encrypt('test', TEST_KEY);

      const parts = encrypted.split(':');
      expect(parts).toHaveLength(3);

      // Each part should be valid base64
      parts.forEach((part) => {
        expect(() => Buffer.from(part, 'base64')).not.toThrow();
      });
    });

    it('should fail to decrypt with invalid format', () => {
      expect(() => decrypt('invalid', TEST_KEY)).toThrow('Invalid ciphertext format');
      expect(() => decrypt('a:b', TEST_KEY)).toThrow('Invalid ciphertext format');
      expect(() => decrypt('a:b:c:d', TEST_KEY)).toThrow('Invalid ciphertext format');
    });

    it('should fail to decrypt with tampered ciphertext', () => {
      const encrypted = encrypt('secret data', TEST_KEY);

      // Tamper with the encrypted data
      const parts = encrypted.split(':');
      parts[2] = Buffer.from('tampered').toString('base64');
      const tampered = parts.join(':');

      expect(() => decrypt(tampered, TEST_KEY)).toThrow();
    });

    it('should fail to decrypt with tampered tag', () => {
      const encrypted = encrypt('secret data', TEST_KEY);

      // Tamper with the auth tag
      const parts = encrypted.split(':');
      const tag = Buffer.from(parts[1], 'base64');
      tag[0] = tag[0] ^ 0xff; // Flip bits
      parts[1] = tag.toString('base64');
      const tampered = parts.join(':');

      expect(() => decrypt(tampered, TEST_KEY)).toThrow();
    });

    it('should fail to decrypt with wrong key', () => {
      const encrypted = encrypt('secret data', TEST_KEY);
      const wrongKey = 'different-key-that-is-also-at-least-32-chars';

      expect(() => decrypt(encrypted, wrongKey)).toThrow();
    });

    it('should report encryption as configured with valid key', () => {
      expect(isEncryptionConfigured(TEST_KEY)).toBe(true);
    });
  });

  describe('isEncryptionConfigured', () => {
    it('should return false for undefined key', () => {
      expect(isEncryptionConfigured(undefined)).toBe(false);
    });

    it('should return false for short key', () => {
      expect(isEncryptionConfigured('short')).toBe(false);
    });

    it('should return false for key with exactly 31 chars', () => {
      expect(isEncryptionConfigured('a'.repeat(31))).toBe(false);
    });

    it('should return true for key with exactly 32 chars', () => {
      expect(isEncryptionConfigured('a'.repeat(32))).toBe(true);
    });
  });
});
