"use client";

import { useMemo, useRef, useState } from "react";

function chunkTextByParagraphs(input: string, maxChars = 4500): string[] {
  const text = input.replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  // 문단 기준: 빈 줄로 분리
  const paras = text.split(/\n{2,}/g);

  const chunks: string[] = [];
  let buf = "";

  const pushBuf = () => {
    const t = buf.trim();
    if (t) chunks.push(t);
    buf = "";
  };

  for (const p of paras) {
    const para = p.trim();
    if (!para) continue;

    // 문단 하나가 너무 길면, 줄 단위로 다시 쪼갬
    if (para.length > maxChars) {
      pushBuf();

      const lines = para.split("\n");
      let sub = "";

      const pushSub = () => {
        const t = sub.trim();
        if (t) chunks.push(t);
        sub = "";
      };

      for (const line of lines) {
        const l = line.trim();
        if (!l) continue;

        // 한 줄도 maxChars를 넘으면 강제로 잘라냄
        if (l.length > maxChars) {
          pushSub();
          for (let i = 0; i < l.length; i += maxChars) {
            chunks.push(l.slice(i, i + maxChars));
          }
          continue;
        }

        if (!sub) sub = l;
        else if (sub.length + 1 + l.length <= maxChars) sub += "\n" + l;
        else {
          pushSub();
          sub = l;
        }
      }
      pushSub();
      continue;
    }

    if (!buf) buf = para;
    else if (buf.length + 2 + para.length <= maxChars) buf += "\n\n" + para;
    else {
      pushBuf();
      buf = para;
    }
  }

  pushBuf();
  return chunks;
}

export default function Page() {
  const [source, setSource] = useState("");
  const [result, setResult] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const [progress, setProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const chunksPreview = useMemo(() => {
    const chunks = chunkTextByParagraphs(source, 4500);
    const totalChars = source.replace(/\r\n/g, "\n").trim().length;
    return { chunksCount: chunks.length, totalChars };
  }, [source]);

  async function translateOneChunk(text: string, signal: AbortSignal) {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error || "번역 중 오류가 발생했어요.");
    }

    return String(data?.translated ?? "");
  }

  async function handleTranslate() {
    const trimmed = source.trim();
    if (!trimmed) return;

    setIsLoading(true);
    setResult("");
    setError("");

    // 기존 작업 취소
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const chunks = chunkTextByParagraphs(trimmed, 4500);

      // 폭주 방지: 너무 많은 조각이면 중단 (원하면 숫자 조절)
      if (chunks.length > 60) {
        throw new Error(
          `회차가 너무 길어서 (${chunks.length}조각) 자동 처리 부담이 큽니다. 한 번에 넣는 분량을 줄여 주세요.`
        );
      }

      setProgress({ current: 0, total: chunks.length });

      let out = "";
      for (let i = 0; i < chunks.length; i++) {
        setProgress({ current: i, total: chunks.length });

        const translated = await translateOneChunk(chunks[i], controller.signal);

        if (!out) out = translated.trimEnd();
        else out += "\n\n" + translated.trimEnd();

        // 중간중간 결과 미리 표시
        setResult(out);
      }

      setProgress({ current: chunks.length, total: chunks.length });
      setResult(out);
    } catch (e: any) {
      if (e?.name === "AbortError") {
        setError("번역이 취소되었습니다.");
      } else {
        setError(e?.message || "알 수 없는 오류");
      }
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  const percent =
    progress && progress.total > 0
      ? Math.floor((progress.current / progress.total) * 100)
      : 0;

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 8 }}>
        Parody Translator
      </h1>

      <p style={{ opacity: 0.7, marginBottom: 12 }}>
        길면 자동으로 나눠서 순차 번역합니다. (문단 기준 분할)
      </p>

      <div style={{ display: "flex", gap: 12, marginBottom: 12, opacity: 0.75 }}>
        <div>예상 분할: {chunksPreview.chunksCount}조각</div>
        <div>글자수: {chunksPreview.totalChars.toLocaleString()}자</div>
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        <textarea
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="여기에 원문을 붙여넣기…"
          style={{
            width: "100%",
            minHeight: 180,
            padding: 12,
            fontSize: 14,
            borderRadius: 10,
            border: "1px solid #ddd",
            outline: "none",
          }}
        />

        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            onClick={handleTranslate}
            disabled={isLoading}
            style={{
              height: 44,
              padding: "0 14px",
              borderRadius: 10,
              border: "1px solid #ddd",
              cursor: isLoading ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            {isLoading ? "번역 중..." : "번역하기"}
          </button>

          {isLoading && (
            <button
              onClick={handleCancel}
              style={{
                height: 44,
                padding: "0 14px",
                borderRadius: 10,
                border: "1px solid #ddd",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              취소
            </button>
          )}

          {progress && (
            <div style={{ fontSize: 14, opacity: 0.8 }}>
              진행률: {percent}% ({progress.current}/{progress.total})
            </div>
          )}
        </div>

        {error && <div style={{ color: "#c00", fontSize: 14 }}>{error}</div>}

        <textarea
          value={result}
          readOnly
          placeholder="번역 결과가 여기 표시됩니다…"
          style={{
            width: "100%",
            minHeight: 220,
            padding: 12,
            fontSize: 14,
            borderRadius: 10,
            border: "1px solid #ddd",
            outline: "none",
            background: "#fafafa",
          }}
        />
      </div>
    </main>
  );
}
