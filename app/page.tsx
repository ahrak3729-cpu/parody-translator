"use client";

import { useMemo, useRef, useState } from "react";

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

    // 단락이 너무 길면 강제로 잘라 넣기
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

/* =========================
   History (flat list)
========================= */
type HistoryItem = {
  id: string;
  createdAt: number;
  // 표시/정리용(나중에 히스토리에서 수정 가능)
  seriesTitle: string; // "패러디소설 제목" 역할
  episodeNo: number; // 1부터 저장
  subtitle: string; // 선택
  // 내용
  sourceText: string;
  translatedText: string;
  // 출처(선택)
  url?: string;
};

const STORAGE_KEY = "parody_translator_history_v3";

function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadHistory(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // 최소 방어
    return parsed.filter((x) => x && typeof x === "object" && typeof x.id === "string");
  } catch {
    return [];
  }
}

function saveHistory(items: HistoryItem[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

function formatDate(ts: number) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

export default function Page() {
  /* =========================
     URL 중심
  ========================= */
  const [url, setUrl] = useState("");
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);

  /* =========================
     텍스트(수동) 모드: 접어두기
  ========================= */
  const [manualOpen, setManualOpen] = useState(false);

  /* =========================
     메타(선택): 히스토리에서 수정 가능
  ========================= */
  const [seriesTitle, setSeriesTitle] = useState("패러디소설");
  const [episodeNo, setEpisodeNo] = useState(1);
  const [subtitle, setSubtitle] = useState("");

  /* =========================
     원문 / 결과
  ========================= */
  const [source, setSource] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<Progress>(null);

  const abortRef = useRef<AbortController | null>(null);

  /* =========================
     History UI
  ========================= */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    if (typeof window === "undefined") return [];
    const items = loadHistory();
    // 최신이 위로 오도록 정렬
    return items.sort((a, b) => b.createdAt - a.createdAt);
  });

  const percent =
    progress && progress.total
      ? Math.floor((progress.current / progress.total) * 100)
      : 0;

  const headerPreview = useMemo(() => {
    const epLine = subtitle.trim()
      ? `제 ${episodeNo}화 · ${subtitle.trim()}`
      : `제 ${episodeNo}화`;
    return { title: seriesTitle.trim() || "패러디소설", epLine };
  }, [seriesTitle, episodeNo, subtitle]);

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

  function buildViewerText(body: string) {
    const title = headerPreview.title;
    const epLine = headerPreview.epLine;

    // “제목+회차/부제목”과 본문 사이를 넉넉하게 띄움
    return `${title}\n${epLine}\n\n\n${body.trim()}`;
  }

  function autoSaveToHistory(params: {
    sourceText: string;
    translatedText: string;
    url?: string;
    seriesTitle: string;
    episodeNo: number;
    subtitle: string;
  }) {
    const item: HistoryItem = {
      id: uid(),
      createdAt: Date.now(),
      seriesTitle: params.seriesTitle.trim() || "패러디소설",
      episodeNo: Math.max(1, Math.floor(params.episodeNo || 1)),
      subtitle: params.subtitle.trim(),
      sourceText: params.sourceText,
      translatedText: params.translatedText,
      url: params.url?.trim() || undefined,
    };

    const next = [item, ...history].sort((a, b) => b.createdAt - a.createdAt);
    setHistory(next);
    try {
      saveHistory(next);
    } catch {
      // ignore
    }
  }

  function loadHistoryItem(it: HistoryItem) {
    setSeriesTitle(it.seriesTitle);
    setEpisodeNo(it.episodeNo);
    setSubtitle(it.subtitle || "");
    setSource(it.sourceText);
    setResult(it.translatedText);
    setError("");
    setProgress(null);
    setHistoryOpen(false);
  }

  function deleteHistoryItem(id: string) {
    const ok = confirm("이 항목을 삭제할까요?");
    if (!ok) return;
    const next = history.filter((h) => h.id !== id);
    setHistory(next);
    try {
      saveHistory(next);
    } catch {}
  }

  function renameHistoryItem(id: string) {
    const it = history.find((h) => h.id === id);
    if (!it) return;

    const nextTitle = prompt("히스토리 이름(작품명)을 수정해줘:", it.seriesTitle);
    if (nextTitle === null) return;

    const nextEpisode = prompt("회차 번호(숫자) 수정:", String(it.episodeNo));
    if (nextEpisode === null) return;

    const nextSub = prompt("부제목(없으면 비워도 됨) 수정:", it.subtitle || "");
    if (nextSub === null) return;

    const ep = Math.max(1, Math.floor(Number(nextEpisode) || 1));

    const next = history.map((h) =>
      h.id === id
        ? { ...h, seriesTitle: nextTitle.trim() || h.seriesTitle, episodeNo: ep, subtitle: (nextSub || "").trim() }
        : h
    );

    setHistory(next);
    try {
      saveHistory(next);
    } catch {}
  }

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      alert("복사되었습니다.");
    } catch {
      alert("복사 실패(브라우저 권한 확인)");
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  /* =========================
     번역 실행
  ========================= */
  async function runTranslation(text: string, sourceUrl?: string) {
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
      if (chunks.length > 80) {
        throw new Error(`너무 길어서 자동 처리 부담이 큽니다. (분할 ${chunks.length}조각)`);
      }

      setProgress({ current: 0, total: chunks.length });

      let out = "";
      for (let i = 0; i < chunks.length; i++) {
        setProgress({ current: i, total: chunks.length });
        const t = await translateChunk(chunks[i], controller.signal);
        out += (out ? "\n\n" : "") + t.trim();
        // 진행 중에도 화면에 보여주고 싶으면 아래 줄을 살려도 됨
        // setResult(buildViewerText(out));
      }

      const finalText = buildViewerText(out);
      setResult(finalText);
      setProgress({ current: chunks.length, total: chunks.length });

      // ✅ 자동저장(히스토리)
      autoSaveToHistory({
        sourceText: text.trim(),
        translatedText: finalText,
        url: sourceUrl,
        seriesTitle: headerPreview.title,
        episodeNo,
        subtitle,
      });
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

      // title이 있으면 작품명 후보로 저장(입력칸은 없지만 메타에 반영)
      if (data?.title) setSeriesTitle(String(data.title));

      const text = String(data?.text ?? "");
      setSource(text);

      // URL 불러오면 바로 번역까지
      await runTranslation(text, u);
    } catch (e: any) {
      setError(e?.message || "본문 불러오기 실패");
    } finally {
      setIsFetchingUrl(false);
    }
  }

  /* =========================
     UI
========================= */
  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: 24 }}>
      {/* 상단바 + 히스토리 버튼 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 900, margin: 0 }}>Parody Translator</h1>
          <div style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>
            자동 저장: 🗂 히스토리에 시간순으로 쌓임
          </div>
        </div>

        <button
          onClick={() => setHistoryOpen(true)}
          style={{
            height: 40,
            padding: "0 14px",
            borderRadius: 10,
            border: "1px solid #ddd",
            cursor: "pointer",
            fontWeight: 900,
            background: "#fff",
          }}
          title="히스토리"
        >
          🗂 히스토리
        </button>
      </div>

      {/* URL 입력 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="URL 붙여넣기"
          style={{ flex: 1, padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
        />
        <button
          onClick={fetchFromUrl}
          disabled={isFetchingUrl || !url.trim()}
          style={{
            height: 40,
            padding: "0 12px",
            borderRadius: 10,
            border: "1px solid #ddd",
            cursor: isFetchingUrl || !url.trim() ? "not-allowed" : "pointer",
            fontWeight: 900,
            background: "#fff",
            opacity: isFetchingUrl || !url.trim() ? 0.6 : 1,
          }}
        >
          {isFetchingUrl ? "불러오는 중…" : "본문 불러오기"}
        </button>
      </div>

      {/* 메타데이터는 접어두기(선택) */}
      <details style={{ marginBottom: 12 }}>
        <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.85 }}>
          메타데이터(선택) — 작품명/회차/부제목
        </summary>
        <div style={{ display: "grid", gap: 8, marginTop: 10 }}>
          <input
            value={seriesTitle}
            onChange={(e) => setSeriesTitle(e.target.value)}
            placeholder="작품명(히스토리 표시용)"
            style={{ width: "100%", padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={String(episodeNo)}
              onChange={(e) => setEpisodeNo(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
              placeholder="회차(숫자)"
              inputMode="numeric"
              style={{ width: 160, padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
            />
            <input
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
              placeholder="부제목(선택)"
              style={{ flex: 1, padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
            />
          </div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            출력 헤더 미리보기: <b>{headerPreview.title}</b> / <b>{headerPreview.epLine}</b>
          </div>
        </div>
      </details>

      {/* 텍스트 번역(접어두기) */}
      <details open={manualOpen} onToggle={(e) => setManualOpen((e.target as HTMLDetailsElement).open)} style={{ marginBottom: 12 }}>
        <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.85 }}>
          텍스트 직접 번역 (필요할 때만 펼치기)
        </summary>

        <div style={{ marginTop: 10 }}>
          <textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="또는 원문을 직접 붙여넣기"
            style={{
              width: "100%",
              minHeight: 160,
              padding: 12,
              borderRadius: 10,
              border: "1px solid #ddd",
              whiteSpace: "pre-wrap",
            }}
          />

          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
            <button
              onClick={() => runTranslation(source)}
              disabled={isLoading || !source.trim()}
              style={{
                height: 40,
                padding: "0 12px",
                borderRadius: 10,
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
                onClick={handleCancel}
                style={{
                  height: 40,
                  padding: "0 12px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  cursor: "pointer",
                  fontWeight: 900,
                  background: "#fff",
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

      {error && <div style={{ color: "#c00", marginTop: 8, fontWeight: 700 }}>{error}</div>}

      {/* 결과: “제목+회차+본문”이 한 공간에 보이도록 Viewer 스타일 */}
      <div style={{ marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
          <div style={{ fontWeight: 900, opacity: 0.85 }}>번역 결과</div>
          <button
            onClick={() => handleCopy(result)}
            disabled={!result.trim()}
            style={{
              height: 36,
              padding: "0 12px",
              borderRadius: 10,
              border: "1px solid #ddd",
              cursor: !result.trim() ? "not-allowed" : "pointer",
              fontWeight: 900,
              background: "#fff",
              opacity: !result.trim() ? 0.6 : 1,
            }}
            title="복사"
          >
            📋 복사
          </button>
        </div>

        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: 14,
            padding: 16,
            background: "#fff",
            minHeight: 240,
            whiteSpace: "pre-wrap",
            lineHeight: 1.7,
          }}
        >
          {!result.trim() ? (
            <div style={{ opacity: 0.55 }}>번역 결과가 여기에 표시됩니다.</div>
          ) : (
            <>
              {/* 제목 라인: 크게/두껍게 */}
              <div style={{ fontSize: 28, fontWeight: 900, marginBottom: 10 }}>
                {headerPreview.title}
              </div>

              {/* 회차 + 부제목: 주석처럼 */}
              <div style={{ fontSize: 14, opacity: 0.7, marginBottom: 28 }}>
                {headerPreview.epLine}
              </div>

              {/* 본문 */}
              <div style={{ fontSize: 16 }}>
                {result
                  // viewer용으로 buildViewerText에서 넣은 헤더(2줄 + 공백)를 제거하고 본문만 보여주기
                  .replace(/^.*\n.*\n\n\n/, "")}
              </div>
            </>
          )}
        </div>
      </div>

      {/* =========================
          History Modal
         ========================= */}
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
              width: "min(920px, 100%)",
              maxHeight: "85vh",
              overflow: "auto",
              background: "#fff",
              borderRadius: 14,
              border: "1px solid #ddd",
              padding: 14,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 900 }}>히스토리</div>
                <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>
                  번역 완료 시 자동 저장됩니다. (작품명/회차/부제목은 “수정”으로 변경 가능)
                </div>
              </div>

              <button
                onClick={() => setHistoryOpen(false)}
                style={{ height: 36, padding: "0 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900, background: "#fff" }}
              >
                닫기
              </button>
            </div>

            {history.length === 0 ? (
              <div style={{ opacity: 0.65, padding: 10 }}>(저장된 항목이 아직 없어요)</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {history.map((it) => {
                  const label = it.subtitle
                    ? `${it.seriesTitle} · ${it.episodeNo}화 · ${it.subtitle}`
                    : `${it.seriesTitle} · ${it.episodeNo}화`;

                  return (
                    <div
                      key={it.id}
                      style={{
                        border: "1px solid #eee",
                        borderRadius: 12,
                        padding: 12,
                        background: "#fff",
                        display: "flex",
                        gap: 10,
                        alignItems: "center",
                      }}
                    >
                      <button
                        onClick={() => loadHistoryItem(it)}
                        style={{
                          flex: 1,
                          border: "none",
                          background: "transparent",
                          cursor: "pointer",
                          textAlign: "left",
                        }}
                        title="불러오기"
                      >
                        <div style={{ fontWeight: 900 }}>{label}</div>
                        <div style={{ fontSize: 12, opacity: 0.65, marginTop: 4 }}>
                          {formatDate(it.createdAt)}
                          {it.url ? ` · URL 저장됨` : ""}
                        </div>
                      </button>

                      <button
                        onClick={() => handleCopy(it.translatedText)}
                        style={{
                          width: 46,
                          height: 34,
                          borderRadius: 10,
                          border: "1px solid #ddd",
                          cursor: "pointer",
                          fontWeight: 900,
                          background: "#fff",
                        }}
                        title="번역본 복사"
                      >
                        📋
                      </button>

                      <button
                        onClick={() => renameHistoryItem(it.id)}
                        style={{
                          width: 56,
                          height: 34,
                          borderRadius: 10,
                          border: "1px solid #ddd",
                          cursor: "pointer",
                          fontWeight: 900,
                          background: "#fff",
                        }}
                        title="이름/회차/부제목 수정"
                      >
                        수정
                      </button>

                      <button
                        onClick={() => deleteHistoryItem(it.id)}
                        style={{
                          width: 44,
                          height: 34,
                          borderRadius: 10,
                          border: "1px solid #ddd",
                          cursor: "pointer",
                          fontWeight: 900,
                          background: "#fff",
                        }}
                        title="삭제"
                      >
                        🗑
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
