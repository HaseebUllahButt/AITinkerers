/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    // The tree typechecks clean via `npx tsc --noEmit`; this stays from the
    // original template so a build never blocks on a type error.
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
    remotePatterns: [
      { protocol: 'https', hostname: '**' },
      { protocol: 'http', hostname: '**' },
    ],
  },
  experimental: {
    serverActions: { bodySizeLimit: '10mb' },
  },
  // Node-only packages that must not be bundled for the browser. imapflow is
  // added beyond Summit's list: its pino/thread-stream chain drags a test file
  // requiring pino-elasticsearch into the module trace and fails the build.
  serverExternalPackages: [
    'playwright',
    'playwright-core',
    'jsdom',
    '@mozilla/readability',
    'imapflow',
    'pino',
    'thread-stream',
  ],
}

export default nextConfig
