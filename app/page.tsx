"use client";

import { useMemo, useRef, useState } from "react";

function chunkTextByParagraphs(input: string, maxChars = 4500): string[] {
  const text = input.replace(/\r\n/g, "\n").trim();
  if (!text) return [];

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

type Progress = { current: number; total: number } | null;

export default function Page() {
  // ✅ 임시 회차 데이터 (나중에 “URL에서 불러오기/저장/목차”로 교체)
  const episodes = useMemo(
    () => [
      `Episode 1

The rain had been falling since dawn.

"So this is where it all started," he muttered.

Outside, the rain continued to fall, unaware that a small decision made in this forgotten alley would soon change everything.`,
      `Episode 2

The next morning, the city looked clean as if nothing had happened.

But he knew better.

"Don't follow me," she warned.

He followed anyway.`,
      `Episode 3

At night, the phone rang exactly once.

When he picked up, there was only breathing.

Then a whisper: "You opened the door."`,
    ],
    []
  );

  const [episodeIndex, setEpisodeIndex] = useState(0);
  const [source, setSource] = useState(episodes[0] ?? "");
  const [result, setResult] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<Progress>(null);

  // ✅ 회차별 번역 캐시: 재번역 방지
  const [translatedCache, setTranslatedCache] = useState<Record<number, string>>(
    {}
  );

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

  async function runTranslation(text: string, cacheKey?: number) {
    const trimmed = text.trim();
    if (!trimmed) return;

    // ✅ 캐시가 있으면 즉시 표시하고 종료
    if (cacheKey !== undefined && translatedCache[cacheKey]) {
      setResult(translatedCache[cacheKey]);
      setError("");
      setProgress(null);
      return;
    }

    setIsLoading(true);
    setResult("");
    setError("");

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const chunks = chunkTextByParagraphs(trimmed, 4500);

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

        setResult(out);
      }

      setProgress({ current: chunks.length, total: chunks.length });
      setResult(out);

      // ✅ 번역 완료 후 캐시에 저장
      if (cacheKey !== undefined) {
        setTranslatedCache((prev) => ({ ...prev, [cacheKey]: out }));
      }
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

  async function handleTranslateClick() {
    await runTranslation(source);
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(result);
      alert("번역본이 복사되었습니다.");
    } catch {
      alert("복사에 실패했습니다. 브라우저 권한을 확인해주세요.");
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  const hasPrev = episodeIndex > 0;
  const hasNext = episodeIndex < episodes.length - 1;

  const percent =
    progress && progress.total > 0
      ? Math.floor((progress.current / progress.total) * 100)
      : 0;

  function goToEpisode(nextIndex: number) {
    const nextText = episodes[nextIndex] ?? "";
    setEpisodeIndex(nextIndex);
    setSource(nextText);
    setResult("");
    setError("");
    setProgress(null);

    // ✅ 자동 번역: 다음화/이전화 눌렀을 때 바로 실행
    void runTranslation(nextText, nextIndex);
  }

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 6 }}>
        Parody Translator
      </h1>

      <div style={{ opacity: 0.75, marginBottom: 12 }}>
        <div>
          현재: {episodeIndex + 1} / {episodes.length}화
        </div>
        <div style={{ marginTop: 4 }}>
          예상 분할: {chunksPreview.chunksCount}조각 · 글자수:{" "}
          {chunksPreview.totalChars.toLocaleString()}자
        </div>
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
            onClick={handleTranslateClick}
            disabled={isLoading}
            style={{
              height: 44,
              padding: "0 14px",
              borderRadius: 10,
              border: "1px solid #ddd",
              cursor: isLoading ? "not-allowed" : "pointer",
              fontWeight: 700,
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
                fontWeight: 700,
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
            minHeight: 240,
            padding: 12,
            fontSize: 14,
            borderRadius: 10,
            border: "1px solid #ddd",
            outline: "none",
            background: "#fafafa",
            whiteSpace: "pre-wrap",
          }}
        />

        {/* ✅ 하단 네비게이션 + 복사 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 6,
          }}
        >
          <button
            onClick={() => goToEpisode(episodeIndex - 1)}
            disabled={!hasPrev || isLoading}
            style={{
              height: 42,
              padding: "0 14px",
              borderRadius: 10,
              border: "1px solid #ddd",
              cursor: !hasPrev || isLoading ? "not-allowed" : "pointer",
              fontWeight: 700,
              opacity: !hasPrev ? 0.5 : 1,
            }}
          >
            이전화
          </button>

          <button
            onClick={handleCopy}
            disabled={!result.trim()}
            title="번역본 복사"
            style={{
              height: 42,
              width: 48,
              borderRadius: 10,
              border: "1px solid #ddd",
              cursor: !result.trim() ? "not-allowed" : "pointer",
              fontWeight: 800,
              opacity: !result.trim() ? 0.5 : 1,
            }}
          >
            📋
          </button>

          <button
            onClick={() => goToEpisode(episodeIndex + 1)}
            disabled={!hasNext || isLoading}
            style={{
              height: 42,
              padding: "0 14px",
              borderRadius: 10,
              border: "1px solid #ddd",
              cursor: !hasNext || isLoading ? "not-allowed" : "pointer",
              fontWeight: 700,
              opacity: !hasNext ? 0.5 : 1,
            }}
          >
            다음화
          </button>
        </div>
      </div>
    </main>
  );
}
