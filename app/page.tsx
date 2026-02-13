"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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

type Progress = { current: number; total: number } | null;

export default function Page() {
  /* =========================
     기본 정보
  ========================= */
  const [novelTitle, setNovelTitle] = useState("패러디 소설 제목");
  const [episodeIndex, setEpisodeIndex] = useState(0);
  const [subtitle, setSubtitle] = useState("");

  /* =========================
     원문 / 결과
  ========================= */
  const [source, setSource] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<Progress>(null);

  /* =========================
     URL 불러오기
  ========================= */
  const [url, setUrl] = useState("");
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);

  const abortRef = useRef<AbortController | null>(null);

  /* =========================
     번역 API (기존 translate API 사용)
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

  function buildHeader() {
    const epLine = subtitle.trim()
      ? `제 ${episodeIndex + 1}화 · ${subtitle.trim()}`
      : `제 ${episodeIndex + 1}화`;

    return `${novelTitle}\n\n${epLine}\n\n\n`;
  }

  async function runTranslation(text: string) {
    if (!text.trim()) return;

    setIsLoading(true);
    setError("");
    setResult("");
    setProgress(null);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const chunks = chunkText(text, 4500);
      setProgress({ current: 0, total: chunks.length });

      let out = "";
      for (let i = 0; i < chunks.length; i++) {
        setProgress({ current: i, total: chunks.length });
        const t = await translateChunk(chunks[i], controller.signal);
        out += (out ? "\n\n" : "") + t.trim();
      }

      const finalText = buildHeader() + out;
      setResult(finalText);
      setProgress({ current: chunks.length, total: chunks.length });
    } catch (e: any) {
      if (e?.name === "AbortError") setError("번역이 취소되었습니다.");
      else setError(e?.message || "번역 오류");
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  }

  /* =========================
     URL → 본문 불러오기
  ========================= */
  async function fetchFromUrl() {
    const u = url.trim();
    if (!u) return;

    setIsFetchingUrl(true);
    setError("");

    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: u }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "본문 불러오기 실패");

      if (data?.title) setNovelTitle(String(data.title));
      const text = String(data?.text ?? "");
      setSource(text);

      await runTranslation(text);
    } catch (e: any) {
      setError(e?.message || "본문 불러오기 실패");
    } finally {
      setIsFetchingUrl(false);
    }
  }

  const percent =
    progress && progress.total
      ? Math.floor((progress.current / progress.total) * 100)
      : 0;

  /* =========================
     UI
  ========================= */
  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 26, fontWeight: 900, marginBottom: 12 }}>
        Parody Translator
      </h1>

      {/* 소설 정보 */}
      <input
        value={novelTitle}
        onChange={(e) => setNovelTitle(e.target.value)}
        placeholder="패러디 소설 제목"
        style={{ width: "100%", padding: 10, marginBottom: 8 }}
      />

      <input
        value={subtitle}
        onChange={(e) => setSubtitle(e.target.value)}
        placeholder="부제목 (선택)"
        style={{ width: "100%", padding: 10, marginBottom: 12 }}
      />

      {/* URL 입력 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="URL 붙여넣기"
          style={{ flex: 1, padding: 10 }}
        />
        <button
          onClick={fetchFromUrl}
          disabled={isFetchingUrl || !url.trim()}
        >
          {isFetchingUrl ? "불러오는 중…" : "본문 불러오기"}
        </button>
      </div>

      {/* 원문 */}
      <textarea
        value={source}
        onChange={(e) => setSource(e.target.value)}
        placeholder="또는 원문을 직접 붙여넣기"
        style={{ width: "100%", minHeight: 160, padding: 12 }}
      />

      {/* 번역 */}
      <div style={{ marginTop: 10 }}>
        <button onClick={() => runTranslation(source)} disabled={isLoading}>
          {isLoading ? "번역 중…" : "번역하기"}
        </button>
        {progress && (
          <span style={{ marginLeft: 12 }}>
            {percent}% ({progress.current}/{progress.total})
          </span>
        )}
      </div>

      {error && <div style={{ color: "red", marginTop: 8 }}>{error}</div>}

      {/* 결과 */}
      <textarea
        value={result}
        readOnly
        placeholder="번역 결과"
        style={{
          width: "100%",
          minHeight: 280,
          padding: 12,
          marginTop: 16,
          whiteSpace: "pre-wrap",
        }}
      />
    </main>
  );
}
