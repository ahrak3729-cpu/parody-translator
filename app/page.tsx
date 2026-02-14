"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

/* =========================
   유틸
========================= */
type TypographySettings = {
  fontPreset: "serif" | "sans" | "mono";
  fontSize: number; // px
  lineHeight: number; // unitless
  paragraphGap: number; // px
};

type BackgroundSettings = {
  hue: number; // 0-360
  sat: number; // 0-100
  light: number; // 0-100
  hue2: number;
  sat2: number;
  light2: number;

  textureUrl: string; // optional
  textureOpacity: number; // 0-100
};

type AppSettings = {
  typography: TypographySettings;
  background: BackgroundSettings;
};

const SETTINGS_KEY = "parody_translator_settings_v2";

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

function fontStack(preset: TypographySettings["fontPreset"]) {
  if (preset === "serif") return `"Nanum Myeongjo","Noto Serif KR","Apple SD Gothic Neo",serif`;
  if (preset === "mono") return `"JetBrains Mono","D2Coding","Menlo",monospace`;
  return `"Pretendard","Apple SD Gothic Neo","Noto Sans KR",system-ui,sans-serif`;
}

function defaultSettings(): AppSettings {
  // A안 기본: 고급 오래된 종이(살짝 따뜻한 톤)
  return {
    typography: {
      fontPreset: "serif",
      fontSize: 16,
      lineHeight: 1.7,
      paragraphGap: 14,
    },
    background: {
      hue: 44,
      sat: 20,
      light: 96,
      hue2: 48,
      sat2: 16,
      light2: 92,
      textureUrl: "",
      textureOpacity: 22,
    },
  };
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings();
    const p = JSON.parse(raw);
    const d = defaultSettings();

    const typography: TypographySettings = {
      fontPreset: (p?.typography?.fontPreset as any) ?? d.typography.fontPreset,
      fontSize: clamp(Number(p?.typography?.fontSize ?? d.typography.fontSize), 12, 28),
      lineHeight: clamp(Number(p?.typography?.lineHeight ?? d.typography.lineHeight), 1.2, 2.4),
      paragraphGap: clamp(Number(p?.typography?.paragraphGap ?? d.typography.paragraphGap), 0, 40),
    };

    const background: BackgroundSettings = {
      hue: clamp(Number(p?.background?.hue ?? d.background.hue), 0, 360),
      sat: clamp(Number(p?.background?.sat ?? d.background.sat), 0, 100),
      light: clamp(Number(p?.background?.light ?? d.background.light), 0, 100),
      hue2: clamp(Number(p?.background?.hue2 ?? d.background.hue2), 0, 360),
      sat2: clamp(Number(p?.background?.sat2 ?? d.background.sat2), 0, 100),
      light2: clamp(Number(p?.background?.light2 ?? d.background.light2), 0, 100),
      textureUrl: String(p?.background?.textureUrl ?? d.background.textureUrl),
      textureOpacity: clamp(Number(p?.background?.textureOpacity ?? d.background.textureOpacity), 0, 100),
    };

    return { typography, background };
  } catch {
    return defaultSettings();
  }
}

function saveSettings(s: AppSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function SliderRow(props: {
  label: string;
  valueText: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "140px 1fr 70px",
        gap: 10,
        alignItems: "center",
        marginTop: 10,
      }}
    >
      <div style={{ fontWeight: 900, opacity: 0.85 }}>{props.label}</div>
      <div>{props.children}</div>
      <div style={{ fontWeight: 800, opacity: 0.65, textAlign: "right" }}>{props.valueText}</div>
    </div>
  );
}

/* =========================
   메인
========================= */
export default function Page() {
  // 히스토리 버튼(지금은 UI만 유지 — 네 프로젝트에서 기존 히스토리 모달이 있으면 여기에 연결하면 됨)
  const [historyOpen, setHistoryOpen] = useState(false);

  // 원문/결과
  const [source, setSource] = useState("");
  const [result, setResult] = useState("");

  // 상태
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const abortRef = useRef<AbortController | null>(null);

  // 설정(저장형)
  const [settings, setSettings] = useState<AppSettings>(() => {
    if (typeof window === "undefined") return defaultSettings();
    return loadSettings();
  });
  const [draft, setDraft] = useState<AppSettings>(settings);
  const [dirty, setDirty] = useState(false);

  // 초기 드래프트 동기화
  useEffect(() => {
    setDraft(settings);
    setDirty(false);
  }, [settings]);

  // dirty 판단
  useEffect(() => {
    setDirty(JSON.stringify(settings) !== JSON.stringify(draft));
  }, [settings, draft]);

  function onSave() {
    setSettings(draft);
    saveSettings(draft);
    setDirty(false);
  }

  function onReset() {
    setDraft(defaultSettings());
    setDirty(true);
  }

  // ✅ 페이지 전체 배경 스타일(저장된 settings 기준)
  const pageStyle = useMemo(() => {
    const bg = settings.background;
    const base = `hsl(${bg.hue} ${bg.sat}% ${bg.light}%)`;
    const accent = `hsl(${bg.hue2} ${bg.sat2}% ${bg.light2}%)`;

    const gradient = `radial-gradient(1200px 800px at 20% 10%, ${accent}, transparent 60%),
                      radial-gradient(1000px 600px at 90% 30%, ${accent}, transparent 65%),
                      linear-gradient(180deg, ${base}, ${base})`;

    const hasTex = !!bg.textureUrl.trim();
    const tex = hasTex ? `url("${bg.textureUrl.trim()}")` : "";

    return {
      minHeight: "100vh",
      backgroundColor: base,
      backgroundImage: hasTex ? `${tex}, ${gradient}` : gradient,
      backgroundSize: hasTex ? `auto, cover` : "cover",
      backgroundRepeat: hasTex ? `repeat, no-repeat` : "no-repeat",
      backgroundBlendMode: hasTex ? `multiply, normal` : "normal",
    } as React.CSSProperties;
  }, [settings]);

  // 결과 텍스트 스타일(저장된 settings 기준)
  const resultTextStyle = useMemo(() => {
    const ty = settings.typography;
    return {
      fontFamily: fontStack(ty.fontPreset),
      fontSize: ty.fontSize,
      lineHeight: ty.lineHeight,
      whiteSpace: "pre-wrap",
    } as React.CSSProperties;
  }, [settings]);

  // ✅ 서식/배경 편집에서 보여줄 "미리보기"는 draft 기준
  const previewBoxStyle = useMemo(() => {
    const bg = draft.background;
    const base = `hsl(${bg.hue} ${bg.sat}% ${bg.light}%)`;
    const accent = `hsl(${bg.hue2} ${bg.sat2}% ${bg.light2}%)`;

    const gradient = `radial-gradient(800px 520px at 25% 15%, ${accent}, transparent 60%),
                      radial-gradient(700px 460px at 80% 35%, ${accent}, transparent 65%),
                      linear-gradient(180deg, ${base}, ${base})`;

    const hasTex = !!bg.textureUrl.trim();
    return {
      position: "relative" as const,
      border: "1px solid rgba(0,0,0,0.12)",
      borderRadius: 14,
      padding: 14,
      backgroundColor: base,
      backgroundImage: hasTex ? `url("${bg.textureUrl.trim()}"), ${gradient}` : gradient,
      backgroundRepeat: hasTex ? "repeat, no-repeat" : "no-repeat",
      backgroundSize: hasTex ? "auto, cover" : "cover",
      backgroundBlendMode: hasTex ? "multiply, normal" : "normal",
      overflow: "hidden" as const,
    };
  }, [draft]);

  const previewTextStyle = useMemo(() => {
    const ty = draft.typography;
    return {
      fontFamily: fontStack(ty.fontPreset),
      fontSize: ty.fontSize,
      lineHeight: ty.lineHeight,
      whiteSpace: "pre-wrap" as const,
    };
  }, [draft]);

  async function translate() {
    const text = source.trim();
    if (!text) return;

    setIsLoading(true);
    setError("");
    setResult("");

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });

      const data = await res.json().catch(() => null);

      if (!res.ok) {
        throw new Error(data?.error || data?.message || "번역 실패");
      }

      setResult(String(data?.translated ?? ""));
    } catch (e: any) {
      if (e?.name === "AbortError") setError("번역이 취소되었습니다.");
      else setError(e?.message || "번역 오류");
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  }

  function cancel() {
    abortRef.current?.abort();
  }

  return (
    <div style={pageStyle}>
      {/* textureOpacity는 페이지 전체에는 직접 곱하기 어렵기 때문에 overlay로만 적용 */}
      {settings.background.textureUrl.trim() && (
        <div
          aria-hidden
          style={{
            position: "fixed",
            inset: 0,
            pointerEvents: "none",
            backgroundImage: `url("${settings.background.textureUrl.trim()}")`,
            backgroundRepeat: "repeat",
            opacity: clamp(settings.background.textureOpacity, 0, 100) / 100,
            mixBlendMode: "multiply",
            zIndex: 0,
          }}
        />
      )}

      <main style={{ maxWidth: 860, margin: "0 auto", padding: 24, position: "relative", zIndex: 1 }}>
        {/* 헤더 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <div>
            <h1 style={{ fontSize: 36, fontWeight: 900, margin: 0 }}>Parody Translator</h1>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button
              onClick={() => setHistoryOpen(true)}
              style={{
                width: 44,
                height: 40,
                borderRadius: 12,
                border: "1px solid #ddd",
                cursor: "pointer",
                fontWeight: 900,
                background: "rgba(255,255,255,0.92)",
                fontSize: 18,
              }}
              title="히스토리"
              aria-label="히스토리"
            >
              ☰
            </button>
          </div>
        </div>

        {/* 원문 입력 */}
        <div
          style={{
            border: "1px solid rgba(0,0,0,0.12)",
            borderRadius: 14,
            padding: 14,
            background: "rgba(255,255,255,0.92)",
            boxShadow: "0 16px 34px rgba(0,0,0,0.06)",
          }}
        >
          <textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="원문 붙여넣기"
            style={{
              width: "100%",
              minHeight: 240,
              padding: 12,
              borderRadius: 12,
              border: "1px solid #ddd",
              background: "#fff",
              resize: "vertical",
              whiteSpace: "pre-wrap",
            }}
          />

          <div style={{ display: "flex", gap: 10, marginTop: 12, alignItems: "center" }}>
            <button
              onClick={translate}
              disabled={isLoading || !source.trim()}
              style={{
                height: 40,
                padding: "0 14px",
                borderRadius: 12,
                border: "1px solid #ddd",
                cursor: isLoading || !source.trim() ? "not-allowed" : "pointer",
                fontWeight: 900,
                background: "#fff",
                opacity: isLoading || !source.trim() ? 0.6 : 1,
              }}
            >
              {isLoading ? "번역 중…" : "번역하기"}
            </button>

            {isLoading && (
              <button
                onClick={cancel}
                style={{
                  height: 40,
                  padding: "0 14px",
                  borderRadius: 12,
                  border: "1px solid #ddd",
                  cursor: "pointer",
                  fontWeight: 900,
                  background: "#fff",
                }}
              >
                취소
              </button>
            )}
          </div>

          {error && <div style={{ marginTop: 10, color: "#c00", fontWeight: 800, whiteSpace: "pre-wrap" }}>{error}</div>}
        </div>

        {/* 서식 편집 */}
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 10 }}>서식 편집</div>

          {/* ✅ 미리보기(편집바 위쪽 고정) */}
          <div style={previewBoxStyle}>
            <div style={{ position: "relative" }}>
              <div style={previewTextStyle}>
                {"미리보기입니다. 웹소설 / 패러디 소설을 읽는 느낌을 확인해보세요.\n\n(글자 크기 / 줄 간격 / 문단 간격 / 폰트 / 배경이 모두 반영됩니다.)"}
              </div>
            </div>
          </div>

          <div
            style={{
              marginTop: 12,
              border: "1px solid rgba(0,0,0,0.12)",
              borderRadius: 14,
              padding: 14,
              background: "rgba(255,255,255,0.92)",
              boxShadow: "0 16px 34px rgba(0,0,0,0.06)",
            }}
          >
            <div style={{ fontWeight: 900, marginBottom: 10 }}>폰트</div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[
                { key: "serif", label: "명조" },
                { key: "sans", label: "프리텐다드" },
                { key: "mono", label: "모노" },
              ].map((x) => {
                const active = draft.typography.fontPreset === (x.key as any);
                return (
                  <button
                    key={x.key}
                    onClick={() =>
                      setDraft((s) => ({
                        ...s,
                        typography: { ...s.typography, fontPreset: x.key as any },
                      }))
                    }
                    style={{
                      height: 34,
                      padding: "0 12px",
                      borderRadius: 10,
                      border: "1px solid #ddd",
                      background: active ? "#111" : "#fff",
                      color: active ? "#fff" : "#111",
                      cursor: "pointer",
                      fontWeight: 900,
                    }}
                  >
                    {x.label}
                  </button>
                );
              })}
            </div>

            {/* ✅ “이름 옆에 슬라이더” 느낌: 레이블/슬라이더/값 한 줄 */}
            <SliderRow label="글자 크기" valueText={`${draft.typography.fontSize}px`}>
              <input
                type="range"
                min={12}
                max={28}
                value={draft.typography.fontSize}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    typography: { ...s.typography, fontSize: Number(e.target.value) },
                  }))
                }
                style={{ width: "100%" }}
              />
            </SliderRow>

            <SliderRow label="줄 간격" valueText={`${draft.typography.lineHeight.toFixed(1)}`}>
              <input
                type="range"
                min={12}
                max={24}
                value={Math.round(draft.typography.lineHeight * 10)}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    typography: { ...s.typography, lineHeight: Number(e.target.value) / 10 },
                  }))
                }
                style={{ width: "100%" }}
              />
            </SliderRow>

            <SliderRow label="문단 간격" valueText={`${draft.typography.paragraphGap}px`}>
              <input
                type="range"
                min={0}
                max={40}
                value={draft.typography.paragraphGap}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    typography: { ...s.typography, paragraphGap: Number(e.target.value) },
                  }))
                }
                style={{ width: "100%" }}
              />
            </SliderRow>

            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button
                onClick={onSave}
                disabled={!dirty}
                style={{
                  height: 40,
                  padding: "0 14px",
                  borderRadius: 12,
                  border: "1px solid #ddd",
                  cursor: dirty ? "pointer" : "not-allowed",
                  fontWeight: 900,
                  background: dirty ? "#111" : "#eee",
                  color: dirty ? "#fff" : "#777",
                  opacity: dirty ? 1 : 0.9,
                }}
              >
                서식 저장
              </button>

              <button
                onClick={onReset}
                style={{
                  height: 40,
                  padding: "0 14px",
                  borderRadius: 12,
                  border: "1px solid #ddd",
                  cursor: "pointer",
                  fontWeight: 900,
                  background: "#fff",
                }}
              >
                기본값
              </button>
            </div>
          </div>
        </div>

        {/* 배경 편집 */}
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 10 }}>배경 편집</div>

          <div
            style={{
              border: "1px solid rgba(0,0,0,0.12)",
              borderRadius: 14,
              padding: 14,
              background: "rgba(255,255,255,0.92)",
              boxShadow: "0 16px 34px rgba(0,0,0,0.06)",
            }}
          >
            <div style={{ fontWeight: 900, opacity: 0.85 }}>페이지 배경 톤(HSL)</div>

            <SliderRow label="Hue" valueText={`${draft.background.hue}`}>
              <input
                type="range"
                min={0}
                max={360}
                value={draft.background.hue}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    background: { ...s.background, hue: Number(e.target.value) },
                  }))
                }
                style={{ width: "100%" }}
              />
            </SliderRow>

            <SliderRow label="Saturation" valueText={`${draft.background.sat}%`}>
              <input
                type="range"
                min={0}
                max={100}
                value={draft.background.sat}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    background: { ...s.background, sat: Number(e.target.value) },
                  }))
                }
                style={{ width: "100%" }}
              />
            </SliderRow>

            <SliderRow label="Lightness" valueText={`${draft.background.light}%`}>
              <input
                type="range"
                min={0}
                max={100}
                value={draft.background.light}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    background: { ...s.background, light: Number(e.target.value) },
                  }))
                }
                style={{ width: "100%" }}
              />
            </SliderRow>

            <div style={{ height: 10 }} />

            <div style={{ fontWeight: 900, opacity: 0.85 }}>포인트 톤(HSL)</div>

            <SliderRow label="Hue" valueText={`${draft.background.hue2}`}>
              <input
                type="range"
                min={0}
                max={360}
                value={draft.background.hue2}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    background: { ...s.background, hue2: Number(e.target.value) },
                  }))
                }
                style={{ width: "100%" }}
              />
            </SliderRow>

            <SliderRow label="Saturation" valueText={`${draft.background.sat2}%`}>
              <input
                type="range"
                min={0}
                max={100}
                value={draft.background.sat2}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    background: { ...s.background, sat2: Number(e.target.value) },
                  }))
                }
                style={{ width: "100%" }}
              />
            </SliderRow>

            <SliderRow label="Lightness" valueText={`${draft.background.light2}%`}>
              <input
                type="range"
                min={0}
                max={100}
                value={draft.background.light2}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    background: { ...s.background, light2: Number(e.target.value) },
                  }))
                }
                style={{ width: "100%" }}
              />
            </SliderRow>

            <div style={{ height: 12 }} />

            <div style={{ fontWeight: 900, opacity: 0.85, marginBottom: 8 }}>종이 질감(옵션)</div>

            <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 10, alignItems: "center" }}>
              <div style={{ fontWeight: 900, opacity: 0.85 }}>질감 URL</div>
              <input
                value={draft.background.textureUrl}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    background: { ...s.background, textureUrl: e.target.value },
                  }))
                }
                placeholder="https://... (비우면 질감 없음)"
                style={{
                  width: "100%",
                  padding: 10,
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  background: "#fff",
                }}
              />
            </div>

            <SliderRow label="질감 강도" valueText={`${draft.background.textureOpacity}%`}>
              <input
                type="range"
                min={0}
                max={100}
                value={draft.background.textureOpacity}
                onChange={(e) =>
                  setDraft((s) => ({
                    ...s,
                    background: { ...s.background, textureOpacity: Number(e.target.value) },
                  }))
                }
                style={{ width: "100%" }}
              />
            </SliderRow>

            <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
              <button
                onClick={onSave}
                disabled={!dirty}
                style={{
                  height: 40,
                  padding: "0 14px",
                  borderRadius: 12,
                  border: "1px solid #ddd",
                  cursor: dirty ? "pointer" : "not-allowed",
                  fontWeight: 900,
                  background: dirty ? "#111" : "#eee",
                  color: dirty ? "#fff" : "#777",
                  opacity: dirty ? 1 : 0.9,
                }}
              >
                배경 저장
              </button>

              <button
                onClick={onReset}
                style={{
                  height: 40,
                  padding: "0 14px",
                  borderRadius: 12,
                  border: "1px solid #ddd",
                  cursor: "pointer",
                  fontWeight: 900,
                  background: "#fff",
                }}
              >
                기본값
              </button>
            </div>
          </div>
        </div>

        {/* 번역 결과 */}
        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 10 }}>번역 결과</div>

          <div
            style={{
              border: "1px solid rgba(0,0,0,0.12)",
              borderRadius: 14,
              padding: 16,
              background: "rgba(255,255,255,0.92)",
              boxShadow: "0 16px 34px rgba(0,0,0,0.06)",
              minHeight: 160,
            }}
          >
            {!result.trim() ? (
              <div style={{ opacity: 0.55 }}>번역 결과가 여기에 표시됩니다.</div>
            ) : (
              <div style={resultTextStyle}>
                {result.split("\n\n").map((p, idx) => (
                  <div key={idx} style={{ marginBottom: idx === result.split("\n\n").length - 1 ? 0 : settings.typography.paragraphGap }}>
                    {p}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* 히스토리 모달: 지금은 placeholder (기능이 원래 있던 버전이면, 기존 코드 붙이면 됨) */}
        {historyOpen && (
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
              zIndex: 9999,
            }}
            onClick={() => setHistoryOpen(false)}
          >
            <div
              style={{
                width: "min(680px, 100%)",
                background: "#fff",
                borderRadius: 14,
                border: "1px solid #ddd",
                padding: 14,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                <div style={{ fontSize: 18, fontWeight: 900 }}>히스토리</div>
                <button
                  onClick={() => setHistoryOpen(false)}
                  style={{
                    height: 36,
                    padding: "0 12px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    cursor: "pointer",
                    fontWeight: 900,
                    background: "#fff",
                  }}
                >
                  닫기
                </button>
              </div>

              <div style={{ marginTop: 10, opacity: 0.7, lineHeight: 1.6 }}>
                지금 파일은 “사라진 것들 복구”를 최우선으로 해서,
                <br />
                히스토리/폴더/이동/삭제 기능은 다음 단계에서 다시 붙일 수 있도록
                <b> UI 자리만 유지</b>해둔 상태야.
                <br />
                (네 프로젝트에 기존 히스토리 코드가 있으면 그대로 여기로 다시 합치면 돼.)
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
