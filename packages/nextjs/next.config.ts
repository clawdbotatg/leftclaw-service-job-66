import type { NextConfig } from "next";

// NOTE: this build targets Vercel (dynamic API routes under /app/api/*).
// The legacy static-export path (NEXT_PUBLIC_IPFS_BUILD=true) has been removed
// because the mint flow requires server-side secrets (RELAYER_PRIVATE_KEY,
// CV_SPEND_SECRET, BGIPFS_TOKEN) that cannot run in a static export.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  devIndicators: false,
  typescript: {
    ignoreBuildErrors: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  eslint: {
    ignoreDuringBuilds: process.env.NEXT_PUBLIC_IGNORE_BUILD_ERROR === "true",
  },
  webpack: config => {
    config.resolve.fallback = { fs: false, net: false, tls: false };
    config.externals.push("pino-pretty", "lokijs", "encoding");
    return config;
  },
};

module.exports = nextConfig;
