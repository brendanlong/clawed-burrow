import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';

/**
 * Environment variable for container
 */
export interface ContainerEnvVar {
  name: string;
  value: string; // Decrypted
}

/**
 * MCP server configuration for container
 */
export interface ContainerMcpServer {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>; // Decrypted env values
}

/**
 * Repo settings ready for container creation
 */
export interface ContainerRepoSettings {
  envVars: ContainerEnvVar[];
  mcpServers: ContainerMcpServer[];
}

/**
 * Get decrypted repo settings for use in container creation
 * Returns null if no settings exist for the repo
 */
export async function getRepoSettingsForContainer(
  repoFullName: string
): Promise<ContainerRepoSettings | null> {
  const settings = await prisma.repoSettings.findUnique({
    where: { repoFullName },
    include: { envVars: true, mcpServers: true },
  });

  if (!settings) {
    return null;
  }

  // Decrypt env var values
  const envVars: ContainerEnvVar[] = settings.envVars.map((ev) => ({
    name: ev.name,
    value: ev.isSecret ? decrypt(ev.value) : ev.value,
  }));

  // Parse and decrypt MCP server configs
  const mcpServers: ContainerMcpServer[] = settings.mcpServers.map((mcp) => {
    const envJson = mcp.env
      ? (JSON.parse(mcp.env) as Record<string, { value: string; isSecret: boolean }>)
      : {};

    // Decrypt secret env values
    const env = Object.fromEntries(
      Object.entries(envJson).map(([key, { value, isSecret }]) => [
        key,
        isSecret ? decrypt(value) : value,
      ])
    );

    return {
      name: mcp.name,
      command: mcp.command,
      args: mcp.args ? (JSON.parse(mcp.args) as string[]) : undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
    };
  });

  return { envVars, mcpServers };
}
