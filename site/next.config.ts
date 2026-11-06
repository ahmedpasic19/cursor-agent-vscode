import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The extension's lockfile sits one level up; pin the root to this folder.
  turbopack: { root: __dirname },
};

export default nextConfig;
