/**
 * Unit tests for pure functions in the podman service.
 *
 * These tests don't require podman to be running - they test pure functions
 * that have deterministic outputs based on their inputs.
 *
 * For tests that interact with real podman, see podman.integration.test.ts
 */

import { describe, it, expect } from 'vitest';

import { isErrorExitCode, describeExitCode } from './podman';

describe('podman service - pure functions', () => {
  describe('isErrorExitCode', () => {
    it('should return false for null exit code', () => {
      expect(isErrorExitCode(null)).toBe(false);
    });

    it('should return false for exit code 0', () => {
      expect(isErrorExitCode(0)).toBe(false);
    });

    it('should return true for non-zero exit codes', () => {
      expect(isErrorExitCode(1)).toBe(true);
      expect(isErrorExitCode(137)).toBe(true);
      expect(isErrorExitCode(139)).toBe(true);
      expect(isErrorExitCode(-1)).toBe(true);
    });
  });

  describe('describeExitCode', () => {
    it('should describe null exit code', () => {
      expect(describeExitCode(null)).toBe('unknown exit code');
    });

    it('should describe success', () => {
      expect(describeExitCode(0)).toBe('success');
    });

    it('should describe SIGKILL (OOM)', () => {
      expect(describeExitCode(137)).toBe('killed (SIGKILL) - possibly out of memory');
    });

    it('should describe SIGSEGV', () => {
      expect(describeExitCode(139)).toBe('segmentation fault (SIGSEGV)');
    });

    it('should describe SIGTERM', () => {
      expect(describeExitCode(143)).toBe('terminated (SIGTERM)');
    });

    it('should describe SIGINT', () => {
      expect(describeExitCode(130)).toBe('interrupted (SIGINT)');
    });

    it('should describe other signals', () => {
      expect(describeExitCode(129)).toBe('killed by signal 1');
    });

    it('should describe regular error codes', () => {
      expect(describeExitCode(1)).toBe('error code 1');
      expect(describeExitCode(127)).toBe('error code 127');
    });
  });
});
