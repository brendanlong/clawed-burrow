/**
 * Integration tests for the podman service.
 *
 * These tests run against real podman and create actual containers.
 * They are careful to:
 * 1. Use a unique test prefix for all containers
 * 2. Track all containers created during tests
 * 3. Clean up all test containers after each test
 * 4. Never interact with containers not created by the tests
 *
 * Prerequisites:
 * - podman must be available and running
 * - The test uses alpine:latest as a lightweight test image
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { spawn, execSync } from 'child_process';
import { v4 as uuid } from 'uuid';

// Unique prefix for test containers to avoid conflicts
const TEST_CONTAINER_PREFIX = 'podman-integration-test-';
const TEST_VOLUME_PREFIX = 'podman-integration-test-vol-';
const TEST_IMAGE = 'alpine:latest';

// Track all resources created during tests for cleanup
const createdContainers: Set<string> = new Set();
const createdVolumes: Set<string> = new Set();

/**
 * Run a podman command and return stdout.
 */
function runPodman(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('podman', args);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`podman ${args.join(' ')} failed with code ${code}: ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Run a podman command, ignoring errors.
 */
function runPodmanIgnoreErrors(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const proc = spawn('podman', args);
    let stdout = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.on('close', () => {
      resolve(stdout.trim());
    });

    proc.on('error', () => {
      resolve('');
    });
  });
}

/**
 * Generate a unique test container name.
 */
function testContainerName(): string {
  const name = `${TEST_CONTAINER_PREFIX}${uuid().slice(0, 8)}`;
  createdContainers.add(name);
  return name;
}

/**
 * Generate a unique test volume name.
 */
function testVolumeName(): string {
  const name = `${TEST_VOLUME_PREFIX}${uuid().slice(0, 8)}`;
  createdVolumes.add(name);
  return name;
}

/**
 * Clean up a specific container (stop and remove).
 */
async function cleanupContainer(nameOrId: string): Promise<void> {
  await runPodmanIgnoreErrors(['stop', '-t', '1', nameOrId]);
  await runPodmanIgnoreErrors(['rm', '-f', nameOrId]);
}

/**
 * Clean up a specific volume.
 */
async function cleanupVolume(name: string): Promise<void> {
  await runPodmanIgnoreErrors(['volume', 'rm', '-f', name]);
}

/**
 * Clean up all test resources.
 */
async function cleanupAllTestResources(): Promise<void> {
  // Clean up containers
  for (const name of createdContainers) {
    await cleanupContainer(name);
  }
  createdContainers.clear();

  // Clean up volumes
  for (const name of createdVolumes) {
    await cleanupVolume(name);
  }
  createdVolumes.clear();

  // Also clean up any orphaned test containers (in case a test crashed)
  const psOutput = await runPodmanIgnoreErrors([
    'ps',
    '-a',
    '--filter',
    `name=^${TEST_CONTAINER_PREFIX}`,
    '--format',
    '{{.Names}}',
  ]);
  for (const name of psOutput.split('\n').filter(Boolean)) {
    await cleanupContainer(name);
  }

  // Clean up orphaned test volumes
  const volumeOutput = await runPodmanIgnoreErrors(['volume', 'ls', '--format', '{{.Name}}']);
  for (const name of volumeOutput.split('\n').filter(Boolean)) {
    if (name.startsWith(TEST_VOLUME_PREFIX)) {
      await cleanupVolume(name);
    }
  }
}

describe('podman integration tests', () => {
  beforeAll(async () => {
    // Verify podman is available
    try {
      execSync('podman --version', { stdio: 'pipe' });
    } catch {
      throw new Error('podman is not available. These tests require podman to be installed.');
    }

    // Pull the test image if not present
    await runPodmanIgnoreErrors(['pull', TEST_IMAGE]);

    // Clean up any leftover test resources from previous runs
    await cleanupAllTestResources();
  });

  afterEach(async () => {
    // Clean up after each test
    await cleanupAllTestResources();
  });

  afterAll(async () => {
    // Final cleanup
    await cleanupAllTestResources();
  });

  describe('container lifecycle', () => {
    it('should create, start, and stop a container', async () => {
      const containerName = testContainerName();

      // Create container
      const containerId = await runPodman([
        'create',
        '--name',
        containerName,
        TEST_IMAGE,
        'sleep',
        '300',
      ]);
      expect(containerId).toBeTruthy();

      // Start container
      await runPodman(['start', containerName]);

      // Verify it's running
      const inspectOutput = await runPodman([
        'inspect',
        '--format',
        '{{.State.Running}}',
        containerName,
      ]);
      expect(inspectOutput).toBe('true');

      // Stop container
      await runPodman(['stop', '-t', '1', containerName]);

      // Verify it's stopped
      const stoppedOutput = await runPodman([
        'inspect',
        '--format',
        '{{.State.Running}}',
        containerName,
      ]);
      expect(stoppedOutput).toBe('false');
    });

    it('should execute commands in a running container', async () => {
      const containerName = testContainerName();

      // Create and start container
      await runPodman(['create', '--name', containerName, TEST_IMAGE, 'sleep', '300']);
      await runPodman(['start', containerName]);

      // Execute a command
      const output = await runPodman(['exec', containerName, 'echo', 'hello world']);
      expect(output).toBe('hello world');

      // Execute another command
      const pwdOutput = await runPodman(['exec', containerName, 'pwd']);
      expect(pwdOutput).toBe('/');
    });

    it('should get container status correctly', async () => {
      const containerName = testContainerName();

      // Create container (not started)
      await runPodman(['create', '--name', containerName, TEST_IMAGE, 'sleep', '300']);

      // Check status of created but not started container
      const createdState = await runPodman([
        'inspect',
        '--format',
        '{{.State.Running}}',
        containerName,
      ]);
      expect(createdState).toBe('false');

      // Start and check running status
      await runPodman(['start', containerName]);
      const runningState = await runPodman([
        'inspect',
        '--format',
        '{{.State.Running}}',
        containerName,
      ]);
      expect(runningState).toBe('true');

      // Stop and check stopped status
      await runPodman(['stop', '-t', '1', containerName]);
      const stoppedState = await runPodman([
        'inspect',
        '--format',
        '{{.State.Running}}',
        containerName,
      ]);
      expect(stoppedState).toBe('false');
    });

    it('should return not found for non-existent container', async () => {
      const nonExistentName = `${TEST_CONTAINER_PREFIX}nonexistent-${uuid()}`;

      // This should fail
      await expect(
        runPodman(['inspect', '--format', '{{.State.Running}}', nonExistentName])
      ).rejects.toThrow();
    });
  });

  describe('container listing', () => {
    it('should list containers with correct state format', async () => {
      const containerName = testContainerName();

      // Create and start a container
      await runPodman(['create', '--name', containerName, TEST_IMAGE, 'sleep', '300']);
      await runPodman(['start', containerName]);

      // List containers with the format used by listSessionContainers
      const output = await runPodman([
        'ps',
        '-a',
        '--filter',
        `name=^${TEST_CONTAINER_PREFIX}`,
        '--format',
        '{{.ID}}\t{{.Names}}\t{{.State}}',
      ]);

      // Parse the output
      const lines = output.split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(1);

      // Find our container
      const ourLine = lines.find((line) => line.includes(containerName));
      expect(ourLine).toBeDefined();

      const [id, name, state] = ourLine!.split('\t');
      expect(id).toBeTruthy();
      expect(name).toBe(containerName);
      // State should be "running" or start with "Up " depending on podman version/socket
      expect(state === 'running' || state.toLowerCase().startsWith('up ')).toBe(true);
    });

    it('should list stopped containers correctly', async () => {
      const containerName = testContainerName();

      // Create, start, then stop a container
      await runPodman(['create', '--name', containerName, TEST_IMAGE, 'sleep', '300']);
      await runPodman(['start', containerName]);
      await runPodman(['stop', '-t', '1', containerName]);

      // List containers
      const output = await runPodman([
        'ps',
        '-a',
        '--filter',
        `name=^${TEST_CONTAINER_PREFIX}`,
        '--format',
        '{{.ID}}\t{{.Names}}\t{{.State}}',
      ]);

      // Find our container
      const ourLine = output.split('\n').find((line) => line.includes(containerName));
      expect(ourLine).toBeDefined();

      const [, , state] = ourLine!.split('\t');
      // State should NOT be "running" or start with "Up "
      expect(state !== 'running' && !state.toLowerCase().startsWith('up ')).toBe(true);
    });

    it('should only list containers matching the filter', async () => {
      const testContainer1 = testContainerName();
      const testContainer2 = testContainerName();

      // Create two test containers
      await runPodman(['create', '--name', testContainer1, TEST_IMAGE, 'sleep', '300']);
      await runPodman(['create', '--name', testContainer2, TEST_IMAGE, 'sleep', '300']);

      // List only containers with our test prefix
      const output = await runPodman([
        'ps',
        '-a',
        '--filter',
        `name=^${TEST_CONTAINER_PREFIX}`,
        '--format',
        '{{.Names}}',
      ]);

      const names = output.split('\n').filter(Boolean);

      // Should contain our test containers
      expect(names).toContain(testContainer1);
      expect(names).toContain(testContainer2);

      // Should NOT contain production containers (claude-session-*)
      for (const name of names) {
        expect(name.startsWith('claude-session-')).toBe(false);
      }
    });
  });

  describe('volume operations', () => {
    it('should create and remove volumes', async () => {
      const volumeName = testVolumeName();

      // Create volume
      await runPodman(['volume', 'create', volumeName]);

      // Verify it exists
      const inspectOutput = await runPodman(['volume', 'inspect', volumeName]);
      expect(inspectOutput).toContain(volumeName);

      // Remove volume
      await runPodman(['volume', 'rm', volumeName]);

      // Verify it's gone
      await expect(runPodman(['volume', 'inspect', volumeName])).rejects.toThrow();
    });

    it('should mount volumes in containers', async () => {
      const containerName = testContainerName();
      const volumeName = testVolumeName();

      // Create volume
      await runPodman(['volume', 'create', volumeName]);

      // Create container with volume mounted
      await runPodman([
        'create',
        '--name',
        containerName,
        '-v',
        `${volumeName}:/data`,
        TEST_IMAGE,
        'sleep',
        '300',
      ]);
      await runPodman(['start', containerName]);

      // Write a file to the volume
      await runPodman(['exec', containerName, 'sh', '-c', 'echo "test data" > /data/test.txt']);

      // Read it back
      const content = await runPodman(['exec', containerName, 'cat', '/data/test.txt']);
      expect(content).toBe('test data');
    });
  });

  describe('exec operations', () => {
    it('should run commands and capture output', async () => {
      const containerName = testContainerName();

      await runPodman(['create', '--name', containerName, TEST_IMAGE, 'sleep', '300']);
      await runPodman(['start', containerName]);

      // Test various commands
      const echoOutput = await runPodman(['exec', containerName, 'echo', 'test output']);
      expect(echoOutput).toBe('test output');

      const pwdOutput = await runPodman(['exec', containerName, 'pwd']);
      expect(pwdOutput).toBe('/');

      const lsOutput = await runPodman(['exec', containerName, 'ls', '/']);
      expect(lsOutput).toContain('bin');
      expect(lsOutput).toContain('etc');
    });

    it('should handle command failures', async () => {
      const containerName = testContainerName();

      await runPodman(['create', '--name', containerName, TEST_IMAGE, 'sleep', '300']);
      await runPodman(['start', containerName]);

      // Run a command that will fail
      await expect(runPodman(['exec', containerName, 'false'])).rejects.toThrow();

      // Run a command that doesn't exist
      await expect(
        runPodman(['exec', containerName, 'nonexistent-command-12345'])
      ).rejects.toThrow();
    });

    it('should test file existence correctly', async () => {
      const containerName = testContainerName();

      await runPodman(['create', '--name', containerName, TEST_IMAGE, 'sleep', '300']);
      await runPodman(['start', containerName]);

      // Create a test file
      await runPodman(['exec', containerName, 'touch', '/tmp/exists.txt']);

      // Test -f for existing file should succeed (exit 0)
      await expect(
        runPodman(['exec', containerName, 'test', '-f', '/tmp/exists.txt'])
      ).resolves.toBe('');

      // Test -f for non-existing file should fail (exit 1)
      await expect(
        runPodman(['exec', containerName, 'test', '-f', '/tmp/does-not-exist.txt'])
      ).rejects.toThrow();
    });
  });

  describe('process operations', () => {
    it('should find processes by pattern', async () => {
      const containerName = testContainerName();

      await runPodman(['create', '--name', containerName, TEST_IMAGE, 'sleep', '300']);
      await runPodman(['start', containerName]);

      // The container is running "sleep 300", so we should find it
      const pgrepOutput = await runPodman(['exec', containerName, 'pgrep', '-f', 'sleep']);
      expect(pgrepOutput).toBeTruthy();
      const pid = parseInt(pgrepOutput.split('\n')[0], 10);
      expect(pid).toBeGreaterThan(0);
    });

    it('should send signals to processes', async () => {
      const containerName = testContainerName();

      await runPodman(['create', '--name', containerName, TEST_IMAGE, 'sleep', '300']);
      await runPodman(['start', containerName]);

      // Start a background process we can kill
      await runPodman(['exec', '-d', containerName, 'sleep', '1000']);

      // Find the sleep 1000 process
      const pgrepOutput = await runPodman(['exec', containerName, 'pgrep', '-f', 'sleep 1000']);
      const pid = parseInt(pgrepOutput.split('\n')[0], 10);
      expect(pid).toBeGreaterThan(0);

      // Send SIGTERM
      await runPodman(['exec', containerName, 'kill', '-TERM', pid.toString()]);

      // Wait a moment for the process to die
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Process should no longer exist
      const checkOutput = await runPodmanIgnoreErrors([
        'exec',
        containerName,
        'pgrep',
        '-f',
        'sleep 1000',
      ]);
      expect(checkOutput).toBe('');
    });
  });

  describe('container logs', () => {
    it('should retrieve container logs', async () => {
      const containerName = testContainerName();

      // Create a container that outputs something
      await runPodman([
        'create',
        '--name',
        containerName,
        TEST_IMAGE,
        'sh',
        '-c',
        'echo "log line 1" && echo "log line 2" && sleep 300',
      ]);
      await runPodman(['start', containerName]);

      // Wait for output
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Get logs
      const logs = await runPodman(['logs', containerName]);
      expect(logs).toContain('log line 1');
      expect(logs).toContain('log line 2');
    });

    it('should respect --tail option', async () => {
      const containerName = testContainerName();

      // Create a container that outputs multiple lines
      await runPodman([
        'create',
        '--name',
        containerName,
        TEST_IMAGE,
        'sh',
        '-c',
        'for i in 1 2 3 4 5; do echo "line $i"; done && sleep 300',
      ]);
      await runPodman(['start', containerName]);

      // Wait for output
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Get only last 2 lines
      const logs = await runPodman(['logs', '--tail', '2', containerName]);
      const lines = logs.split('\n').filter(Boolean);
      expect(lines.length).toBeLessThanOrEqual(2);
    });
  });

  describe('container state inspection', () => {
    it('should get detailed container state', async () => {
      const containerName = testContainerName();

      await runPodman(['create', '--name', containerName, TEST_IMAGE, 'sleep', '300']);
      await runPodman(['start', containerName]);

      // Get JSON state
      const stateJson = await runPodman(['inspect', '--format', '{{json .State}}', containerName]);
      const state = JSON.parse(stateJson);

      expect(state.Running).toBe(true);
      expect(state.ExitCode).toBe(0);
      expect(state.OOMKilled).toBe(false);
    });

    it('should detect exit codes', async () => {
      const containerName = testContainerName();

      // Create a container that exits with code 42
      await runPodman(['create', '--name', containerName, TEST_IMAGE, 'sh', '-c', 'exit 42']);
      await runPodman(['start', containerName]);

      // Wait for it to exit
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Get state
      const stateJson = await runPodman(['inspect', '--format', '{{json .State}}', containerName]);
      const state = JSON.parse(stateJson);

      expect(state.Running).toBe(false);
      expect(state.ExitCode).toBe(42);
    });
  });
});
