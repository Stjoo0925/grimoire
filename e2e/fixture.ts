/**
 * e2e 공용 픽스처 — 내용이 고정된 임시 레포 두 개(shop-api, shop-web)를 한 폴더 아래 만든다.
 *
 *   shop-api: 프로젝트 시작(express) · JWT 리프레시 토큰 회전(나) · Redis 분산 락(동료)
 *   shop-web: 장바구니 화면(react, 나)
 */
import fs from "node:fs";
import path from "node:path";

import { makeRepo, tempDir } from "../tests/helpers";

export const ME = "me@example.com";

export interface Fixture {
  root: string;
  api: string;
  web: string;
}

export function makeFixture(): Fixture {
  const api = makeRepo(
    [
      {
        message: "feat: 프로젝트 시작",
        files: { "package.json": JSON.stringify({ dependencies: { express: "^4" } }) },
        date: "2023-01-10T10:00:00+09:00",
      },
      {
        message: "feat(auth): JWT 리프레시 토큰 회전\n\n만료 직전에 refresh token을 새로 발급하고 이전 토큰을 폐기한다.",
        files: { "src/auth/refresh.ts": "export function rotate() {\n  return 'rotated';\n}\n" },
        email: ME,
        date: "2023-05-02T10:00:00+09:00",
      },
      {
        message: "fix: 재고 차감 동시성 문제를 Redis 분산 락으로 해결",
        files: { "src/order/lock.ts": "export const lock = 'redlock';\n" },
        email: "teammate@example.com",
        date: "2024-02-03T10:00:00+09:00",
      },
    ],
    "shop-api",
  );
  const web = makeRepo(
    [
      {
        message: "feat: 장바구니 화면",
        files: { "package.json": JSON.stringify({ dependencies: { react: "^18" } }), "src/Cart.tsx": "export {}\n" },
        email: ME,
        date: "2024-03-01T10:00:00+09:00",
      },
    ],
    "shop-web",
  );
  // 두 레포를 한 폴더 아래로 모아 scan 대상으로 쓴다
  const root = tempDir("grimoire-e2e-");
  const apiLink = path.join(root, "shop-api");
  const webLink = path.join(root, "shop-web");
  fs.renameSync(api, apiLink);
  fs.renameSync(web, webLink);
  return { root, api: apiLink, web: webLink };
}
