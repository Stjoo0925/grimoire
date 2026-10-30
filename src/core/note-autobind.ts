import type { DB } from "./db";
import { isIndexable } from "./code";
import { isRuleFile } from "./rules";
import { workingChanges } from "./impact";
import { resolveNotePaths } from "./notes";

/** 자동으로 묶는 파일 수 상한 — 이보다 많이 바뀌었으면 어느 파일 얘긴지 알 수 없어 아무것도 묶지 않는다 */
export const AUTO_BIND_MAX = 5;

export interface AutoBind {
  paths: string[];
  /** 바뀐 소스 파일이 상한을 넘어 묶지 않았다 */
  tooMany: boolean;
}

/**
 * 노트에 파일을 안 줬을 때 묶을 파일 — 작업 폴더에서 지금 바뀐(스테이징·수정·새 파일) 소스 파일.
 * 본문에 이미 경로가 있으면(본문 경로는 저장할 때 자동으로 묶인다) 건드리지 않는다. git 오류는 "없음"으로 본다.
 */
export async function autoBindPaths(db: DB, repoId: number, text: string, dir: string, signal?: AbortSignal): Promise<AutoBind> {
  if (resolveNotePaths(db, repoId, text).length > 0) return { paths: [], tooMany: false };
  let changed: string[];
  try {
    changed = (await workingChanges(dir, signal)).filter((file) => isIndexable(file, 0) || isRuleFile(file));
  } catch {
    return { paths: [], tooMany: false };
  }
  if (changed.length > AUTO_BIND_MAX) return { paths: [], tooMany: true };
  return { paths: changed, tooMany: false };
}
