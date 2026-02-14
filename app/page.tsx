"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/* =========================
   자동 분할 (긴 글 대응)
========================= */
function chunkText(input: string, maxChars = 4500): string[] {
  const text = input.replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  const paras = text.split(/\n{2,}/g);
  const chunks: string[] = [];
  let buf = "";

  const push = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = "";
  };

  for (const p0 of paras) {
    const p = p0.trim();
    if (!p) continue;

    if (p.length > maxChars) {
      push();
      for (let i = 0; i < p.length; i += maxChars) {
        chunks.push(p.slice(i, i + maxChars));
      }
      continue;
    }

    if (!buf) buf = p;
    else if (buf.length + p.length + 2 <= maxChars) buf += "\n\n" + p;
    else {
      push();
      buf = p;
    }
  }
  push();
  return chunks;
}

type Progress = { current: number; total: number } | null;

type AppSettings = {
  fontSize: number;
  lineHeight: number;
  viewerPadding: number;
  viewerRadius: number;

  appBgH: number;
  appBgS: number;
  appBgL: number;

  cardBgH: number;
  cardBgS: number;
  cardBgL: number;

  textH: number;
  textS: number;
  textL: number;

  bgPatternUrl: string;
  bgPatternOpacity: number;
  bgPatternSize: number;
  bgPatternBlend: number;

  pixivCookie: string;
};

const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 16,
  lineHeight: 1.7,
  viewerPadding: 16,
  viewerRadius: 14,

  appBgH: 40,
  appBgS: 25,
  appBgL: 94,

  cardBgH: 40,
  cardBgS: 22,
  cardBgL: 98,

  textH: 28,
  textS: 35,
  textL: 16,

  bgPatternUrl: "",
  bgPatternOpacity: 0.18,
  bgPatternSize: 900,
  bgPatternBlend: 0.35,

  pixivCookie: "",
};

const SETTINGS_KEY = "parody_translator_settings_v2";
const CURRENT_KEY = "parody_translator_current_v2"; // ✅ 키 버전업(캐시 꼬임 방지)

function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function hsl(h: number, s: number, l: number) {
  const hh = Math.max(0, Math.min(360, Math.round(h)));
  const ss = Math.max(0, Math.min(100, Math.round(s)));
  const ll = Math.max(0, Math.min(100, Math.round(l)));
  return `hsl(${hh} ${ss}% ${ll}%)`;
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...(parsed || {}) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: AppSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

async function safeReadJson(res: Response) {
  const contentType = res.headers.get("content-type") || "";
  const raw = await res.text();

  if (!raw.trim()) return { __raw: "", __notJson: true, __contentType: contentType };

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      return { __raw: raw, __notJson: true, __contentType: contentType };
    }
  }

  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw, __notJson: true, __contentType: contentType };
  }
}

function LabeledSlider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ minWidth: 140, fontWeight: 900, opacity: 0.85, whiteSpace: "nowrap" }}>
          {props.label}{" "}
          <span style={{ fontWeight: 900, opacity: 0.6 }}>
            ({props.value}
            {props.suffix || ""})
          </span>
        </div>

        <input
          type="range"
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          value={props.value}
          onChange={(e) => props.onChange(Number(e.target.value))}
          style={{ flex: 1 }}
        />
      </div>
    </div>
  );
}

export default function Page() {
  /* =========================
     Settings
  ========================= */
  const [settings, setSettings] = useState<AppSettings>(() => {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    return loadSettings();
  });
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ✅ 설정 즉시 저장
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      saveSettings(settings);
    } catch {}
  }, [settings]);

  /* =========================
     Current UI state (persist)
  ========================= */
  const [hydrated, setHydrated] = useState(false); // ✅ 복원 완료 전엔 저장하지 않게

  /* =========================
     URL / 텍스트
  ========================= */
  const [url, setUrl] = useState("");
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);
  const [manualOpen, setManualOpen] = useState(true);

  /* =========================
     메타
  ========================= */
  const [seriesTitle, setSeriesTitle] = useState("패러디소설");
  const [episodeNo, setEpisodeNo] = useState(1);
  const [subtitle, setSubtitle] = useState("");

  /* =========================
     원문 / 결과
  ========================= */
  const [source, setSource] = useState("");
  const [resultBody, setResultBody] = useState("");
  const [showHeader, setShowHeader] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<Progress>(null);
  const abortRef = useRef<AbortController | null>(null);

  // ✅ 최초 1회: localStorage에서 복원
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(CURRENT_KEY);
      if (raw) {
        const p = JSON.parse(raw);

        if (typeof p?.url === "string") setUrl(p.url);
        if (typeof p?.manualOpen === "boolean") setManualOpen(p.manualOpen);

        if (typeof p?.seriesTitle === "string") setSeriesTitle(p.seriesTitle);
        if (typeof p?.episodeNo === "number") setEpisodeNo(p.episodeNo);
        if (typeof p?.subtitle === "string") setSubtitle(p.subtitle);

        if (typeof p?.source === "string") setSource(p.source);
        if (typeof p?.resultBody === "string") setResultBody(p.resultBody);
        if (typeof p?.showHeader === "boolean") setShowHeader(p.showHeader);
      }
    } catch {}
    setHydrated(true);
  }, []);

  // ✅ 복원 이후에만 저장 (새로고침 시 덮어쓰기 방지)
  useEffect(() => {
    if (!hydrated) return;
    try {
      const payload = {
        url,
        manualOpen,
        seriesTitle,
        episodeNo,
        subtitle,
        source,
        resultBody,
        showHeader,
      };
      localStorage.setItem(CURRENT_KEY, JSON.stringify(payload));
    } catch {}
  }, [hydrated, url, manualOpen, seriesTitle, episodeNo, subtitle, source, resultBody, showHeader]);

  const headerPreview = useMemo(() => {
    const title = (seriesTitle || "패러디소설").trim() || "패러디소설";
    const epLine = subtitle.trim() ? `제 ${episodeNo}화 · ${subtitle.trim()}` : `제 ${episodeNo}화`;
    return { title, epLine };
  }, [seriesTitle, episodeNo, subtitle]);

  const percent = progress && progress.total ? Math.floor((progress.current / progress.total) * 100) : 0;

  /* =========================
     번역 API
  ========================= */
  async function translateChunk(text: string, signal: AbortSignal) {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    const data = await safeReadJson(res);

    if (!res.ok) {
      const msg = (data && ((data as any).error || (data as any).message)) || "번역 실패";
      throw new Error(String(msg));
    }
    return String((data as any)?.translated ?? "");
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  async function runTranslation(text: string, opts?: { mode: "manual" | "url"; sourceUrl?: string }) {
    if (!text.trim()) return;

    const mode = opts?.mode ?? "manual";

    setIsLoading(true);
    setError("");
    setResultBody("");
    setProgress(null);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const chunks = chunkText(text, 4500);
      if (chunks.length > 80) throw new Error(`너무 길어서 자동 처리 부담이 큽니다. (분할 ${chunks.length}조각)`);

      setProgress({ current: 0, total: chunks.length });

      let out = "";
      for (let i = 0; i < chunks.length; i++) {
        setProgress({ current: i, total: chunks.length });
        const t = await translateChunk(chunks[i], controller.signal);
        out += (out ? "\n\n" : "") + t.trim();
      }

      setResultBody(out);
      setProgress({ current: chunks.length, total: chunks.length });

      const nextShowHeader = mode === "url";
      setShowHeader(nextShowHeader);
    } catch (e: any) {
      if (e?.name === "AbortError") setError("번역이 취소되었습니다.");
      else setError(e?.message || "번역 오류");
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  }

  async function fetchFromUrl() {
    const u = url.trim();
    if (!u) return;

    setIsFetchingUrl(true);
    setError("");

    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: u,
          cookie: settings.pixivCookie?.trim() || "",
        }),
      });

      const data: any = await safeReadJson(res);

      if (!res.ok) {
        const msg = data?.error || data?.message || "본문 불러오기 실패";
        throw new Error(String(msg));
      }

      if (data?.__notJson) {
        throw new Error("본문을 JSON으로 받지 못했어요. (차단/권한 문제 가능)");
      }

      const text = String(data?.text ?? "");
      if (!text.trim()) throw new Error("본문을 가져왔지만 내용이 비어있어요.");

      setSource(text);
      await runTranslation(text, { mode: "url", sourceUrl: u });
    } catch (e: any) {
      setError(e?.message || "본문 불러오기 실패");
    } finally {
      setIsFetchingUrl(false);
    }
  }

  /* =========================
     현재 설정 기반 배경 스타일
  ========================= */
  const appBg = hsl(settings.appBgH, settings.appBgS, settings.appBgL);
  const cardBg = hsl(settings.cardBgH, settings.cardBgS, settings.cardBgL);
  const textColor = hsl(settings.textH, settings.textS, settings.textL);

  const cardShellStyle: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.18)",
    borderRadius: settings.viewerRadius,
    background: cardBg,
    padding: 14,
  };

  // ✅ 텍스트 입력(textarea) 플랫
  const flatTextareaStyle: React.CSSProperties = {
    width: "100%",
    height: 220,
    overflowY: "auto",
    resize: "none",
    border: "none",
    outline: "none",
    background: "transparent",
    padding: 0,
    margin: 0,
    whiteSpace: "pre-wrap",
    fontFamily: "inherit",
    fontSize: 15,
    lineHeight: 1.6,
    color: textColor,
  };

  // ✅ URL 입력도 동일하게 “플랫 input”
  const flatUrlInputStyle: React.CSSProperties = {
    width: "100%",
    border: "none",
    outline: "none",
    background: "transparent",
    padding: 0,
    margin: 0,
    fontSize: 15,
    color: textColor,
  };

  return (
    <div style={{ minHeight: "100vh", background: appBg, color: textColor, position: "relative" }}>
      {/* 배경 패턴 */}
      {!!settings.bgPatternUrl.trim() && (
        <>
          <div
            style={{
              pointerEvents: "none",
              position: "fixed",
              inset: 0,
              backgroundImage: `url(${settings.bgPatternUrl.trim()})`,
              backgroundRepeat: "repeat",
              backgroundSize: `${settings.bgPatternSize}px ${settings.bgPatternSize}px`,
              opacity: settings.bgPatternOpacity,
              mixBlendMode: "multiply",
            }}
          />
          <div
            style={{
              pointerEvents: "none",
              position: "fixed",
              inset: 0,
              background: `linear-gradient(0deg, rgba(0,0,0,${settings.bgPatternBlend * 0.06}) 0%, rgba(0,0,0,0) 70%)`,
            }}
          />
        </>
      )}

      <main style={{ maxWidth: 860, margin: "0 auto", padding: 24, paddingBottom: 86, position: "relative" }}>
        {/* 상단바 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 900, margin: 0, color: textColor }}>Parody Translator</h1>
            <div style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>자동 저장: ☰ 목록에 시간순으로 쌓임</div>
          </div>

          <button
            onClick={() => setSettingsOpen(true)}
            style={{
              width: 44,
              height: 40,
              borderRadius: 12,
              border: "1px solid rgba(0,0,0,0.18)",
              cursor: "pointer",
              fontWeight: 900,
              background: "#fff",
              fontSize: 18,
              color: "#111",
            }}
            title="설정"
            aria-label="설정"
          >
            ⚙
          </button>
        </div>

        {/* ✅ URL 입력: 텍스트 입력칸과 같은 “플랫 카드” */}
        <div style={{ ...cardShellStyle, marginBottom: 12 }}>
          <div style={{ fontWeight: 900, opacity: 0.85, marginBottom: 10 }}>URL 붙여넣기</div>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {/* 카드 1겹 + input은 플랫 */}
            <div style={{ flex: 1 }}>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="URL을 붙여넣어줘" style={flatUrlInputStyle} />
              <div style={{ height: 1, background: "rgba(0,0,0,0.18)", marginTop: 10 }} />
            </div>

            <button
              onClick={fetchFromUrl}
              disabled={isFetchingUrl || !url.trim()}
              style={{
                height: 40,
                padding: "0 14px",
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.18)",
                cursor: isFetchingUrl || !url.trim() ? "not-allowed" : "pointer",
                fontWeight: 900,
                background: "rgba(255,255,255,0.8)",
                opacity: isFetchingUrl || !url.trim() ? 0.6 : 1,
                whiteSpace: "nowrap",
              }}
            >
              {isFetchingUrl ? "불러오는 중…" : "본문 불러오기"}
            </button>
          </div>
        </div>

        {/* 텍스트 직접 번역 */}
        <details open={manualOpen} onToggle={(e) => setManualOpen((e.target as HTMLDetailsElement).open)} style={{ marginBottom: 12 }}>
          <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.85 }}>텍스트 직접 번역</summary>

          <div style={{ marginTop: 10, ...cardShellStyle }}>
            <textarea value={source} onChange={(e) => setSource(e.target.value)} placeholder="원문을 직접 붙여넣기" style={flatTextareaStyle} />

            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
              <button
                onClick={() => runTranslation(source, { mode: "manual" })}
                disabled={isLoading || !source.trim()}
                style={{
                  height: 40,
                  padding: "0 12px",
                  borderRadius: 12,
                  border: "1px solid rgba(0,0,0,0.18)",
                  cursor: isLoading || !source.trim() ? "not-allowed" : "pointer",
                  fontWeight: 900,
                  background: "rgba(255,255,255,0.8)",
                  opacity: isLoading || !source.trim() ? 0.6 : 1,
                }}
              >
                {isLoading ? "번역 중…" : "번역하기"}
              </button>

              {isLoading && (
                <button
                  onClick={handleCancel}
                  style={{
                    height: 40,
                    padding: "0 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(0,0,0,0.18)",
                    cursor: "pointer",
                    fontWeight: 900,
                    background: "rgba(255,255,255,0.8)",
                  }}
                >
                  취소
                </button>
              )}

              {progress && (
                <span style={{ fontSize: 13, opacity: 0.75 }}>
                  진행 {percent}% ({progress.current}/{progress.total})
                </span>
              )}
            </div>
          </div>
        </details>

        {error && <div style={{ color: "#c00", marginTop: 8, fontWeight: 700, whiteSpace: "pre-wrap" }}>{error}</div>}

        {/* 결과 Viewer */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 900, opacity: 0.85, marginBottom: 8 }}>번역 결과</div>

          <div
            style={{
              border: "1px solid rgba(0,0,0,0.18)",
              borderRadius: settings.viewerRadius,
              padding: settings.viewerPadding,
              background: cardBg,
              minHeight: 240,
              whiteSpace: "pre-wrap",
              lineHeight: settings.lineHeight,
              fontSize: settings.fontSize,
              color: textColor,
            }}
          >
            {!resultBody.trim() ? (
              <div style={{ opacity: 0.55 }}>번역 결과가 여기에 표시됩니다.</div>
            ) : (
              <>
                {showHeader && (
                  <>
                    <div style={{ fontSize: 28, fontWeight: 900, marginBottom: 10 }}>{headerPreview.title}</div>
                    <div style={{ fontSize: 14, opacity: 0.7, marginBottom: 28 }}>{headerPreview.epLine}</div>
                  </>
                )}
                <div>{resultBody}</div>
              </>
            )}
          </div>
        </div>

        {/* Settings Modal */}
        {settingsOpen && (
          <div
            role="dialog"
            aria-modal="true"
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.35)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
              zIndex: 10010,
            }}
            onClick={() => setSettingsOpen(false)}
          >
            <div
              style={{
                width: "min(920px, 100%)",
                maxHeight: "85vh",
                overflow: "auto",
                background: "#fff",
                borderRadius: 14,
                border: "1px solid rgba(0,0,0,0.18)",
                padding: 14,
                color: "#111",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 900 }}>설정</div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>바꾸는 즉시 저장돼. (새로고침해도 유지)</div>
                </div>

                <button
                  onClick={() => setSettingsOpen(false)}
                  style={{
                    height: 36,
                    padding: "0 12px",
                    borderRadius: 10,
                    border: "1px solid rgba(0,0,0,0.18)",
                    cursor: "pointer",
                    fontWeight: 900,
                    background: "#fff",
                  }}
                >
                  닫기
                </button>
              </div>

              <details open style={{ marginTop: 10 }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>서식 편집</summary>

                <div style={{ marginTop: 10 }}>
                  <LabeledSlider label="글자 크기" value={settings.fontSize} min={12} max={30} onChange={(v) => setSettings((s) => ({ ...s, fontSize: v }))} suffix="px" />
                  <LabeledSlider label="줄간격" value={settings.lineHeight} min={1.2} max={2.4} step={0.05} onChange={(v) => setSettings((s) => ({ ...s, lineHeight: v }))} />
                  <LabeledSlider label="결과 여백" value={settings.viewerPadding} min={8} max={42} onChange={(v) => setSettings((s) => ({ ...s, viewerPadding: v }))} suffix="px" />
                  <LabeledSlider label="모서리 둥글기" value={settings.viewerRadius} min={6} max={28} onChange={(v) => setSettings((s) => ({ ...s, viewerRadius: v }))} suffix="px" />
                </div>
              </details>

              <details style={{ marginTop: 14 }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>배경 편집</summary>
                <div style={{ marginTop: 10 }}>
                  <LabeledSlider label="페이지 Hue" value={settings.appBgH} min={0} max={360} onChange={(v) => setSettings((s) => ({ ...s, appBgH: v }))} />
                  <LabeledSlider label="페이지 Sat" value={settings.appBgS} min={0} max={100} onChange={(v) => setSettings((s) => ({ ...s, appBgS: v }))} />
                  <LabeledSlider label="페이지 Light" value={settings.appBgL} min={0} max={100} onChange={(v) => setSettings((s) => ({ ...s, appBgL: v }))} />

                  <div style={{ fontWeight: 900, opacity: 0.85, marginTop: 14 }}>카드 배경</div>
                  <LabeledSlider label="카드 Hue" value={settings.cardBgH} min={0} max={360} onChange={(v) => setSettings((s) => ({ ...s, cardBgH: v }))} />
                  <LabeledSlider label="카드 Sat" value={settings.cardBgS} min={0} max={100} onChange={(v) => setSettings((s) => ({ ...s, cardBgS: v }))} />
                  <LabeledSlider label="카드 Light" value={settings.cardBgL} min={0} max={100} onChange={(v) => setSettings((s) => ({ ...s, cardBgL: v }))} />

                  <div style={{ fontWeight: 900, opacity: 0.85, marginTop: 14 }}>글자 색</div>
                  <LabeledSlider label="Text Hue" value={settings.textH} min={0} max={360} onChange={(v) => setSettings((s) => ({ ...s, textH: v }))} />
                  <LabeledSlider label="Text Sat" value={settings.textS} min={0} max={100} onChange={(v) => setSettings((s) => ({ ...s, textS: v }))} />
                  <LabeledSlider label="Text Light" value={settings.textL} min={0} max={100} onChange={(v) => setSettings((s) => ({ ...s, textL: v }))} />

                  <div style={{ fontWeight: 900, opacity: 0.85, marginTop: 14 }}>배경 무늬 URL</div>
                  <input
                    value={settings.bgPatternUrl}
                    onChange={(e) => setSettings((s) => ({ ...s, bgPatternUrl: e.target.value }))}
                    placeholder="패턴 이미지 URL"
                    style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid rgba(0,0,0,0.18)", marginTop: 8 }}
                  />
                </div>
              </details>

              <details style={{ marginTop: 14 }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>Pixiv 쿠키</summary>
                <textarea
                  value={settings.pixivCookie}
                  onChange={(e) => setSettings((s) => ({ ...s, pixivCookie: e.target.value }))}
                  placeholder="예) PHPSESSID=...; device_token=...; ..."
                  style={{
                    width: "100%",
                    minHeight: 90,
                    padding: 12,
                    borderRadius: 10,
                    border: "1px solid rgba(0,0,0,0.18)",
                    fontFamily: "monospace",
                    fontSize: 12,
                    whiteSpace: "pre-wrap",
                    marginTop: 10,
                  }}
                />
              </details>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
