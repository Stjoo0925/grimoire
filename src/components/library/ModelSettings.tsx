"use client";

/**
 * ③ 로컬 LLM 모델 설정 패널.
 *
 * `.env.local`을 고치지 않고도 사서 답변·그래프 추출에 쓸 Ollama 모델을 고른다.
 * 고른 값은 `data/settings.json`에 남고 env보다 우선한다 (lib/settings.ts).
 * 여기서 오가는 것은 전부 로컬 Ollama 호출이다 — 외부 API는 없다 (PLANNING.md §7).
 */
import {
  useCallback,
  useEffect,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useTranslations } from "next-intl";

import {
  getModelOptionsAction,
  pullModelAction,
  setModelAction,
} from "@/app/actions";
import type { ModelOptionsResult } from "@/lib/settings";

/** 상단에 고정으로 보여 주는 권장 모델 (하드웨어 안내 문구는 i18n) */
const PRESETS = [
  { model: "qwen2.5:7b-instruct", messageKey: "qwen7b", size: "4.7GB" },
  { model: "qwen2.5:14b-instruct", messageKey: "qwen14b", size: "9GB" },
] as const;

function formatSize(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) return null;
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

export function ModelSettings() {
  const t = useTranslations("settings");
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ModelOptionsResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pullingModel, setPullingModel] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [saving, startSaving] = useTransition();

  const refresh = useCallback(() => {
    startLoading(async () => {
      setOptions(await getModelOptionsAction());
    });
  }, []);

  useEffect(() => {
    if (open && options === null) refresh();
  }, [open, options, refresh]);

  const choose = (model: string) => {
    if (saving || pullingModel) return;
    startSaving(async () => {
      const result = await setModelAction(model);
      setNotice(result.message);
      if (result.ok) {
        setOptions((prev) =>
          prev
            ? { ...prev, current: result.current ?? prev.current, fromSettings: true }
            : prev,
        );
      }
    });
  };

  /** 내려받기는 Ollama가 끝낼 때까지 붙잡고 있다 — 그동안 pending 상태를 유지한다. */
  const download = (model: string) => {
    if (saving || pullingModel) return;
    setNotice(null);
    setPullingModel(model);
    startSaving(async () => {
      const result = await pullModelAction(model);
      setPullingModel(null);
      setNotice(result.message);
      if (result.ok) refresh();
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border border-amber-200/20 px-3 py-1.5 text-[11px] tracking-[0.15em] text-stone-500 transition hover:border-amber-200/50 hover:text-amber-100"
      >
        ⚙ {t("open")}
      </button>
    );
  }

  const installed = options?.models ?? [];
  const installedNames = new Set(installed.map((model) => model.name));
  const disabled = !options?.reachable || saving || pullingModel !== null;

  const row = (
    model: string,
    hint: string | null,
    trailing: ReactNode,
  ) => {
    const isCurrent = options?.current === model;
    return (
      <li
        key={model}
        className={`flex flex-wrap items-center justify-between gap-2 rounded border px-2.5 py-2 ${
          isCurrent
            ? "border-amber-200/40 bg-amber-950/15"
            : "border-stone-700/60"
        }`}
      >
        <div className="min-w-0 space-y-0.5">
          <p className="truncate text-[11px] text-amber-100/85">
            {model}
            {isCurrent ? (
              <span className="ml-2 text-[9px] tracking-[0.2em] text-amber-200/70">
                {t("inUse")}
              </span>
            ) : null}
          </p>
          {hint ? (
            <p className="text-[10px] leading-relaxed text-stone-500">{hint}</p>
          ) : null}
        </div>
        {trailing}
      </li>
    );
  };

  const actionButton = (label: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="shrink-0 rounded border border-amber-200/30 px-2.5 py-1 text-[10px] text-amber-100 transition hover:border-amber-200/60 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {label}
    </button>
  );

  return (
    <section className="w-full space-y-3 rounded-lg border border-amber-200/25 bg-stone-950/70 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-xs tracking-[0.25em] text-amber-100/90">
            ⚙ {t("title")}
          </h3>
          <p className="max-w-xl text-[10px] leading-relaxed text-stone-500">
            {t("subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="text-[10px] text-stone-500 transition hover:text-amber-200/70 disabled:opacity-40"
          >
            {t("refresh")}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-[10px] text-stone-500 transition hover:text-amber-200/70"
          >
            {t("close")}
          </button>
        </div>
      </header>

      {options === null ? (
        <p className="text-[11px] text-stone-500">{t("loading")}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px]">
            <span className="tracking-[0.2em] text-stone-600">
              {t("statusLabel")}
            </span>
            <span
              className={
                options.reachable ? "text-emerald-300/80" : "text-rose-300/80"
              }
            >
              {options.reachable
                ? t("statusOnline", { host: options.host })
                : t("statusOffline", { host: options.host })}
            </span>
            <span className="tracking-[0.2em] text-stone-600">
              {t("currentLabel")}
            </span>
            <span className="text-amber-100/85">
              {options.current}
              <span className="ml-1.5 text-stone-600">
                (
                {options.fromSettings
                  ? t("currentFromSettings")
                  : t("currentFromEnv")}
                )
              </span>
            </span>
          </div>

          {!options.reachable ? (
            <div className="space-y-1.5 rounded border border-rose-300/20 bg-rose-950/15 px-3 py-2">
              <p className="text-[10px] leading-relaxed text-rose-200/80">
                {t("offlineHelp")}
              </p>
              <code className="block rounded bg-stone-900/80 px-2 py-1 text-[10px] text-amber-100/80">
                {t("offlineCommand")}
              </code>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <h4 className="text-[10px] tracking-[0.2em] text-stone-500">
              {t("recommended")}
            </h4>
            <ul className="space-y-1.5">
              {PRESETS.map((preset) =>
                row(
                  preset.model,
                  installedNames.has(preset.model)
                    ? t(`presets.${preset.messageKey}`)
                    : `${t(`presets.${preset.messageKey}`)} · ${t("notInstalled")} · ${t("sizeWarning", { size: preset.size })}`,
                  installedNames.has(preset.model)
                    ? options.current === preset.model
                      ? null
                      : actionButton(t("select"), () => choose(preset.model))
                    : pullingModel === preset.model
                      ? (
                          <span className="shrink-0 text-[10px] text-amber-200/70">
                            ◌ {t("pulling")}
                          </span>
                        )
                      : actionButton(t("download"), () =>
                          download(preset.model),
                        ),
                ),
              )}
            </ul>
          </div>

          <div className="space-y-1.5">
            <h4 className="text-[10px] tracking-[0.2em] text-stone-500">
              {t("installed")}
            </h4>
            {installed.length === 0 ? (
              <p className="text-[10px] text-stone-600">
                {options.reachable ? t("installedEmpty") : t("offline")}
              </p>
            ) : (
              <ul
                role="radiogroup"
                aria-label={t("installed")}
                className="space-y-1.5"
              >
                {installed.map((model) => {
                  const size = formatSize(model.sizeBytes);
                  const isCurrent = options.current === model.name;
                  return (
                    <li key={model.name}>
                      <label
                        className={`flex cursor-pointer items-center justify-between gap-2 rounded border px-2.5 py-2 ${
                          isCurrent
                            ? "border-amber-200/40 bg-amber-950/15"
                            : "border-stone-700/60 hover:border-amber-200/30"
                        } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <input
                            type="radio"
                            name="ollama-model"
                            value={model.name}
                            checked={isCurrent}
                            disabled={disabled}
                            onChange={() => choose(model.name)}
                            className="accent-amber-200"
                          />
                          <span className="truncate text-[11px] text-amber-100/85">
                            {model.name}
                          </span>
                        </span>
                        {size ? (
                          <span className="shrink-0 text-[10px] text-stone-600">
                            {size}
                          </span>
                        ) : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {pullingModel ? (
            <p className="rounded border border-amber-200/20 bg-amber-950/10 px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-200/80">
              ◌ {t("pulling")} — {pullingModel}
            </p>
          ) : null}

          {notice ? (
            <p className="rounded border border-amber-200/20 bg-amber-950/10 px-2.5 py-1.5 text-[10px] leading-relaxed text-amber-200/80">
              {notice}
            </p>
          ) : options.message ? (
            <p className="text-[10px] leading-relaxed text-stone-500">
              {options.message}
            </p>
          ) : null}

          <p className="text-[10px] leading-relaxed text-stone-600">
            {t("applyNote")} {t("privacy")}
          </p>
        </>
      )}
    </section>
  );
}

export default ModelSettings;
