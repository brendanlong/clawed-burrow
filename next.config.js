/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Allow server actions for streaming
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
    // Mark native modules as external
    serverComponentsExternalPackages: ['dockerode', 'ssh2', 'simple-git'],
  },
  webpack: (config, { isServer }) => {
    if (isServer) {
      // Don't bundle native modules on the server
      config.externals = config.externals || [];
      config.externals.push({
        dockerode: 'commonjs dockerode',
        ssh2: 'commonjs ssh2',
        'simple-git': 'commonjs simple-git',
      });
    }
    return config;
  },
};

module.exports = nextConfig;
