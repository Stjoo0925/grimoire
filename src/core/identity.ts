/**
 * "나"의 작성자 이메일 — `author: "me"` 필터에 쓴다.
 *
 * `GRIMOIRE_ME`(쉼표 구분)가 있으면 그것, 없으면 전역 git 설정의 user.email.
 * 회사·개인 메일을 섞어 쓰면 GRIMOIRE_ME에 모두 적는다.
 */
import os from "node:os";

import type { Env } from "./config";
import { configuredEmail } from "./git";

export async function myEmails(env: Env = process.env): Promise<string[]> {
  const configured = env.GRIMOIRE_ME?.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (configured && configured.length > 0) return configured;
  const email = await configuredEmail(os.homedir());
  return email ? [email] : [];
}

/** 도구 인자 author → 이메일 목록. "me"는 내 이메일, 그 외는 그대로, 비면 전체(undefined). */
export function resolveAuthors(author: string | undefined, me: string[]): string[] | undefined {
  const value = author?.trim().toLowerCase();
  if (!value || value === "all" || value === "any") return undefined;
  if (value === "me") return me;
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}
