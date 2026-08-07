import type { NextConfig } from "next";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  // Proxies API/media calls to the backend server-side, so the browser only ever talks to
  // this app's own origin. Needed for tunneling (VS Code port forwarding, ngrok, etc.) —
  // without it, the browser would need the backend's URL directly and hit CORS, and any
  // tunnel-per-service setup would need two separately-forwarded, CORS-configured ports.
  async rewrites() {
    return [
      { source: "/api/v1/:path*", destination: `${BACKEND_URL}/api/v1/:path*` },
      { source: "/media/:path*", destination: `${BACKEND_URL}/media/:path*` },
    ];
  },
};

export default nextConfig;
