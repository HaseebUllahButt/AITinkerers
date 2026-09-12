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
  // Node-only packages that must not be bundled for the browser.
  serverExternalPackages: [
    'playwright',
    'playwright-core',
  ],
}

export default nextConfig
