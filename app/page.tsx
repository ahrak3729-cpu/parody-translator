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

type HistoryItem = {
  id: string;
  createdAt: number;
  seriesTitle: string;
  episodeNo: number;
  subtitle: string;
  sourceText: string;
  translatedText: string;
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

async function safeReadJson(res: Response) {
  // JSON이 아닌 응답(HTML/빈 응답)에도 안죽게 방어
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

  // content-type이 json이 아니어도, 실제로 json일 수 있으니 한 번 더 시도
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw, __notJson: true, __contentType: contentType };
  }
}

export default function Page() {
  /* =========================
     URL 중심
  ========================= */
  const [url, setUrl] = useState("");
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);

  /* =========================
     텍스트 직접 번역: 접기/펴기
  ========================= */
  const [manualOpen, setManualOpen] = useState(false);

  /* =========================
     메타(저장은 자동, 기본값만)
     - 입력칸은 UI에서 제거함
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
     History UI + 이전/다음 네비
  ========================= */
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    if (typeof window === "undefined") return [];
    const items = loadHistory().sort((a, b) => b.createdAt - a.createdAt);
    return items;
  });
  const [currentHistoryId, setCurrentHistoryId] = useState<string | null>(null);

  const currentIndex = useMemo(() => {
    if (!currentHistoryId) return -1;
    return history.findIndex((h) => h.id === currentHistoryId);
  }, [history, currentHistoryId]);

  const canPrev = currentIndex >= 0 && currentIndex < history.length - 1; // 최신이 0, 이전은 index+1
  const canNext = currentIndex > 0; // 다음(더 최신)은 index-1

  const percent =
    progress && progress.total
      ? Math.floor((progress.current / progress.total) * 100)
      : 0;

  const headerPreview = useMemo(() => {
    const title = (seriesTitle || "패러디소설").trim() || "패러디소설";
    const epLine = subtitle.trim()
      ? `제 ${episodeNo}화 · ${subtitle.trim()}`
      : `제 ${episodeNo}화`;
    return { title, epLine };
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
    const data = await safeReadJson(res);

    if (!res.ok) {
      const msg =
        (data && (data.error || data.message)) ||
        "번역 실패";
      throw new Error(String(msg));
    }

    return String((data as any)?.translated ?? "");
  }

  function buildViewerText(body: string) {
    return `${headerPreview.title}\n${headerPreview.epLine}\n\n\n${body.trim()}`;
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
    setCurrentHistoryId(item.id);

    try {
      saveHistory(next);
    } catch {}
  }

  function loadHistoryItem(it: HistoryItem) {
    setSeriesTitle(it.seriesTitle);
    setEpisodeNo(it.episodeNo);
    setSubtitle(it.subtitle || "");
    setSource(it.sourceText);
    setResult(it.translatedText);
    setError("");
    setProgress(null);
    setCurrentHistoryId(it.id);
    setHistoryOpen(false);
  }

  function deleteHistoryItem(id: string) {
    const ok = confirm("이 항목을 삭제할까요?");
    if (!ok) return;

    const next = history.filter((h) => h.id !== id);
    setHistory(next);

    if (currentHistoryId === id) {
      setCurrentHistoryId(next[0]?.id ?? null);
      if (next[0]) loadHistoryItem(next[0]);
      else {
        setSource("");
        setResult("");
      }
    }

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

  function goPrev() {
    if (!canPrev) return;
    const it = history[currentIndex + 1];
    if (it) loadHistoryItem(it);
  }

  function goNext() {
    if (!canNext) return;
    const it = history[currentIndex - 1];
    if (it) loadHistoryItem(it);
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
      }

      const finalText = buildViewerText(out);
      setResult(finalText);
      setProgress({ current: chunks.length, total: chunks.length });

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

      const data: any = await safeReadJson(res);

      if (!res.ok) {
        const msg =
          data?.error ||
          data?.message ||
          "본문 불러오기 실패";
        throw new Error(String(msg));
      }

      // JSON이 아니었던 경우(대부분 Pixiv 차단/로그인 필요)
      if (data?.__notJson) {
        throw new Error(
          "본문을 JSON으로 받지 못했어요. Pixiv는 로그인/봇 차단 때문에 서버에서 본문 추출이 실패할 수 있어요.\n(다른 사이트로 테스트하거나, 텍스트 직접 붙여넣기로 확인해줘)"
        );
      }

      if (data?.title) setSeriesTitle(String(data.title));
      const text = String(data?.text ?? "");
      if (!text.trim()) {
        throw new Error(
          "본문을 가져왔지만 내용이 비어있어요. (Pixiv 차단/권한 문제 가능)\n텍스트 직접 붙여넣기로 먼저 확인해줘."
        );
      }

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
    <main style={{ maxWidth: 860, margin: "0 auto", padding: 24, paddingBottom: 86 }}>
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

      {/* 텍스트 직접 번역 (문구 정리: 괄호 제거) */}
      <details
        open={manualOpen}
        onToggle={(e) => setManualOpen((e.target as HTMLDetailsElement).open)}
        style={{ marginBottom: 12 }}
      >
        <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.85 }}>
          텍스트 직접 번역
        </summary>

        <div style={{ marginTop: 10 }}>
          <textarea
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="원문을 직접 붙여넣기"
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

      {error && <div style={{ color: "#c00", marginTop: 8, fontWeight: 700, whiteSpace: "pre-wrap" }}>{error}</div>}

      {/* 결과: Viewer 스타일 */}
      <div style={{ marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
          <div style={{ fontWeight: 900, opacity: 0.85 }}>번역 결과</div>
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
              <div style={{ fontSize: 28, fontWeight: 900, marginBottom: 10 }}>
                {headerPreview.title}
              </div>
              <div style={{ fontSize: 14, opacity: 0.7, marginBottom: 28 }}>
                {headerPreview.epLine}
              </div>
              <div style={{ fontSize: 16 }}>
                {result.replace(/^.*\n.*\n\n\n/, "")}
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
                  번역 완료 시 자동 저장됩니다.
                </div>
              </div>

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

      {/* =========================
          Bottom Nav: 이전 / 복사 / 다음
         ========================= */}
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          background: "rgba(255,255,255,0.96)",
          borderTop: "1px solid #ddd",
          padding: "10px 12px",
          zIndex: 9998,
        }}
      >
        <div
          style={{
            maxWidth: 860,
            margin: "0 auto",
            display: "flex",
            gap: 10,
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <button
            onClick={goPrev}
            disabled={!canPrev}
            style={{
              height: 40,
              padding: "0 14px",
              borderRadius: 12,
              border: "1px solid #ddd",
              background: "#fff",
              fontWeight: 900,
              cursor: canPrev ? "pointer" : "not-allowed",
              opacity: canPrev ? 1 : 0.5,
            }}
          >
            ◀ 이전
          </button>

          <button
            onClick={() => handleCopy(result || "")}
            disabled={!result.trim()}
            style={{
              height: 40,
              padding: "0 14px",
              borderRadius: 12,
              border: "1px solid #ddd",
              background: "#fff",
              fontWeight: 900,
              cursor: result.trim() ? "pointer" : "not-allowed",
              opacity: result.trim() ? 1 : 0.5,
            }}
          >
            📋 복사
          </button>

          <button
            onClick={goNext}
            disabled={!canNext}
            style={{
              height: 40,
              padding: "0 14px",
              borderRadius: 12,
              border: "1px solid #ddd",
              background: "#fff",
              fontWeight: 900,
              cursor: canNext ? "pointer" : "not-allowed",
              opacity: canNext ? 1 : 0.5,
            }}
          >
            다음 ▶
          </button>
        </div>
      </div>
    </main>
  );
}
