import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Widgets older than 1.11.0 poll /api/widget; 1.11.0+ read the feed straight
  // from Supabase. The old route was a Vercel function call per poll, so it is
  // gone: old installs get a static file (served by the CDN, no function) whose
  // min_version makes them show "Update required" and stop sounding the siren.
  async rewrites() {
    return [{ source: "/api/widget", destination: "/widget-retired.json" }];
  },
};

export default nextConfig;
