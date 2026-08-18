import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  // Docker 이미지용 — 실행에 필요한 파일만 .next/standalone에 모은다.
  output: "standalone",
  images: {
    // GitHub 아바타 (로그인 사용자 표시용)
    remotePatterns: [
      { protocol: "https", hostname: "avatars.githubusercontent.com" },
    ],
  },
};

export default withNextIntl(nextConfig);
