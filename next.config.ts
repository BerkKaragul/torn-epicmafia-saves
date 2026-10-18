import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Widgets older than 1.11.0 poll /api/widget; 1.11.0+ read the feed straight
  // from Supabase. The old route was a Vercel function call per poll, so it is
  // gone: old installs get a static file (served by the CDN, no function) whose
  // min_version makes them show "Update required" and stop sounding the siren.
  //
  // /feed is the widget's fallback road to its feed, for members whose network
  // blocks the backend's own hostname (a Romanian ISP blocks sslip.io). It's
  // an external rewrite, proxied by Vercel's edge — no function call — and
  // only the blocked few use it.
  async rewrites() {
    const backend = process.env.NEXT_PUBLIC_SUPABASE_URL;
    return [
      { source: "/api/widget", destination: "/widget-retired.json" },
      ...(backend ? [{ source: "/feed", destination: `${backend}/rest/v1/rpc/widget_feed` }] : []),
    ];
  },
};

export default nextConfig;
