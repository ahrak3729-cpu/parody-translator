"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/* =========================
   자동 분할
========================= */
function chunkText(input: string, maxChars = 4500): string[] {
  const text = input.replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  const paras = text.split(/\n{2,}/g);
  const chunks: string[] = [];
  let buf = "";

  const push = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = "";
  };

  for (const p of paras) {
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

/* =========================
   폰트 매핑
========================= */
type ViewerFont = "serif" | "pretendard" | "mono";

function fontFamilyByKey(key: ViewerFont) {
  switch (key) {
    case "serif":
      return `"Noto Serif KR", ui-serif, Georgia, "Times New Roman", serif`;
    case "pretendard":
      return `"Pretendard", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
    case "mono":
      return `"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace`;
    default:
      return `"Pretendard", sans-serif`;
  }
}

/* =========================
   서식 설정 타입
========================= */
type ViewerSettings = {
  fontSize: number;
  lineHeight: number;
  viewerFont: ViewerFont;
};

/* =========================
   기본값
========================= */
const DEFAULT_SETTINGS: ViewerSettings = {
  fontSize: 16,
  lineHeight: 1.7,
  viewerFont: "serif",
};

export default function Page() {
  /* =========================
     번역 상태
  ========================= */
  const [source, setSource] = useState("");
  const [result, setResult] = useState("");
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /* =========================
     서식 설정 (저장용 / 임시편집용)
  ========================= */
  const [settings, setSettings] = useState<ViewerSettings>(DEFAULT_SETTINGS);
  const [draft, setDraft] = useState<ViewerSettings>(DEFAULT_SETTINGS);

  const hasChanges = useMemo(() => {
    return (
      settings.fontSize !== draft.fontSize ||
      settings.lineHeight !== draft.lineHeight ||
      settings.viewerFont !== draft.viewerFont
    );
  }, [settings, draft]);

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
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || "번역 실패");
    return String(data?.translated ?? "");
  }

  async function runTranslation() {
    if (!source.trim()) return;

    setLoading(true);
    setResult("");

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const chunks = chunkText(source);
      let out = "";

      for (const c of chunks) {
        const t = await translateChunk(c, controller.signal);
        out += (out ? "\n\n" : "") + t.trim();
      }

      setResult(out);
    } catch (e: any) {
      alert(e.message || "번역 오류");
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  /* =========================
     UI
  ========================= */
  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 28, fontWeight: 900 }}>Parody Translator</h1>

      {/* 원문 입력 */}
      <textarea
        value={source}
        onChange={(e) => setSource(e.target.value)}
        placeholder="원문 붙여넣기"
        style={{
          width: "100%",
          minHeight: 160,
          marginTop: 12,
          padding: 12,
          borderRadius: 12,
          border: "1px solid #ddd",
        }}
      />

      <button
        onClick={runTranslation}
        disabled={loading}
        style={{
          marginTop: 10,
          height: 40,
          padding: "0 16px",
          borderRadius: 10,
          border: "1px solid #ddd",
          background: "#fff",
          fontWeight: 900,
          cursor: "pointer",
        }}
      >
        {loading ? "번역 중…" : "번역하기"}
      </button>

      {/* =========================
          서식 편집
         ========================= */}
      <section style={{ marginTop: 30 }}>
        <h2 style={{ fontSize: 18, fontWeight: 900 }}>서식 편집</h2>

        {/* 미리보기 */}
        <div
          style={{
            marginTop: 12,
            padding: 16,
            borderRadius: 14,
            border: "1px solid #ddd",
            background: "#fff",
            fontFamily: fontFamilyByKey(draft.viewerFont),
            fontSize: draft.fontSize,
            lineHeight: draft.lineHeight,
          }}
        >
          미리보기입니다.  
          웹소설 / 패러디 소설을 읽는 느낌을 확인해보세요.
        </div>

        {/* 폰트 */}
        <div style={{ marginTop: 14 }}>
          <b>폰트</b>
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button onClick={() => setDraft({ ...draft, viewerFont: "serif" })}>명조</button>
            <button onClick={() => setDraft({ ...draft, viewerFont: "pretendard" })}>프리텐다드</button>
            <button onClick={() => setDraft({ ...draft, viewerFont: "mono" })}>모노</button>
          </div>
        </div>

        {/* 글자 크기 */}
        <div style={{ marginTop: 14 }}>
          <b>글자 크기</b>
          <input
            type="range"
            min={14}
            max={22}
            value={draft.fontSize}
            onChange={(e) => setDraft({ ...draft, fontSize: Number(e.target.value) })}
          />
          <span> {draft.fontSize}px</span>
        </div>

        {/* 줄간격 */}
        <div style={{ marginTop: 14 }}>
          <b>줄 간격</b>
          <input
            type="range"
            min={1.4}
            max={2.2}
            step={0.1}
            value={draft.lineHeight}
            onChange={(e) => setDraft({ ...draft, lineHeight: Number(e.target.value) })}
          />
          <span> {draft.lineHeight}</span>
        </div>

        {/* 저장 */}
        <button
          disabled={!hasChanges}
          onClick={() => setSettings(draft)}
          style={{
            marginTop: 16,
            height: 40,
            padding: "0 16px",
            borderRadius: 10,
            border: "1px solid #ddd",
            background: hasChanges ? "#111" : "#eee",
            color: hasChanges ? "#fff" : "#999",
            fontWeight: 900,
            cursor: hasChanges ? "pointer" : "not-allowed",
          }}
        >
          서식 저장
        </button>
      </section>

      {/* =========================
          번역 결과
         ========================= */}
      <section style={{ marginTop: 30 }}>
        <h2 style={{ fontSize: 18, fontWeight: 900 }}>번역 결과</h2>

        <div
          style={{
            marginTop: 10,
            padding: 18,
            borderRadius: 14,
            border: "1px solid #ddd",
            background: "#fff",
            whiteSpace: "pre-wrap",
            fontFamily: fontFamilyByKey(settings.viewerFont),
            fontSize: settings.fontSize,
            lineHeight: settings.lineHeight,
          }}
        >
          {result || "번역 결과가 여기에 표시됩니다."}
        </div>
      </section>
    </main>
  );
}
