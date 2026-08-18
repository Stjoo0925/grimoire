import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // GitHub 아바타 (로그인 사용자 표시용)
    remotePatterns: [
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
    ],
  },
};

export default nextConfig;
