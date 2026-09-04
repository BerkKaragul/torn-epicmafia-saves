import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Decorative GIFs never change under a given name — let the browser keep
        // them for a year so they're only ever downloaded once per device.
        // (Rename the file if you ever need to bust this.)
        source: "/decor/:file*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default nextConfig;
