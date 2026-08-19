import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "build/**",
      // 유닛 테스트 트랜스파일 산출물 (npm run test)
      ".test-out/**",
      // MCP 서버 트랜스파일 산출물 (npm run mcp:build)
      "dist-mcp/**",
      // CLI 그래프 재빌드 트랜스파일 산출물 (npm run graph:rebuild)
      ".rebuild-out/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
