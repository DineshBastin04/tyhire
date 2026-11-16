import type { NextConfig } from "next";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL ?? "http://localhost:8000";

const nextConfig: NextConfig = {
  // Allow the dev server's HMR/client resources to be requested from these hosts. Without
  // 127.0.0.1 here, opening the app at http://127.0.0.1:3000 (instead of localhost) makes
  // Next 16 block /_next/webpack-hmr and dev chunks as cross-origin, so the client bundle
  // never hydrates and every page hangs on "Loading…". Dev-only; ignored in production.
  allowedDevOrigins: ["localhost", "127.0.0.1"],
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
