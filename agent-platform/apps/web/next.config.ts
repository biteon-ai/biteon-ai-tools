import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const api = process.env.API_INTERNAL_URL ?? "http://127.0.0.1:4000";
    return [
      { source: "/api/:path*", destination: `${api}/api/:path*` },
      { source: "/health", destination: `${api}/health` },
      { source: "/ready", destination: `${api}/ready` },
    ];
  },
};

export default nextConfig;
