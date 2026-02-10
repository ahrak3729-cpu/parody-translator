"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/** =========================
 *  Chunking (auto split)
 *  ========================= */
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

/** =========================
 *  History data model
 *  ========================= */
type FolderNode = {
  id: string;
  type: "folder";
  name: string;
  children: TreeNode[];
};

type ItemNode = {
  id: string;
  type: "item";
  name: string; // 표시명(예: "패러디1 · 3화")
  createdAt: number;
  novelTitle: string; // 예: "코난패러디소설"
  seriesPath: string; // 예: "코난패러디소설/패러디1"
  episodeIndex: number; // 0-based
  episodeLabel: string; // "3화" 같은 라벨
  sourceText: string; // 원문
  translatedText: string; // 번역본
};

type TreeNode = FolderNode | ItemNode;

const STORAGE_KEY = "parody_translator_history_v1";

function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadTree(): FolderNode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { id: "root", type: "folder", name: "root", children: [] };
    }
    const parsed = JSON.parse(raw);
    // 최소 검증
    if (!parsed || parsed.type !== "folder" || !Array.isArray(parsed.children)) {
      return { id: "root", type: "folder", name: "root", children: [] };
    }
    return parsed as FolderNode;
  } catch {
    return { id: "root", type: "folder", name: "root", children: [] };
  }
}

function saveTree(root: FolderNode) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(root));
}

function findNodeById(root: FolderNode, id: string): FolderNode | ItemNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    if (child.id === id) return child;
    if (child.type === "folder") {
      const found = findNodeById(child, id);
      if (found) return found;
    }
  }
  return null;
}

function updateFolderChildren(
  root: FolderNode,
  folderId: string,
  updater: (children: TreeNode[]) => TreeNode[]
): FolderNode {
  if (root.id === folderId) {
    return { ...root, children: updater(root.children) };
  }
  const newChildren = root.children.map((c) => {
    if (c.type === "folder") return updateFolderChildren(c, folderId, updater);
    return c;
  });
  return { ...root, children: newChildren };
}

function removeNode(root: FolderNode, targetId: string): FolderNode {
  const filterChildren = (children: TreeNode[]): TreeNode[] =>
    children
      .filter((c) => c.id !== targetId)
      .map((c) => (c.type === "folder" ? removeNode(c, targetId) : c));

  return { ...root, children: filterChildren(root.children) };
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

/** =========================
 *  UI
 *  ========================= */
export default function Page() {
  // ✅ 임시 회차 데이터 (나중에 URL/목차/저장으로 교체)
  const novelTitle = "코난패러디소설";
  const seriesName = "패러디1";

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

  // ✅ 회차별 번역 캐시
  const [translatedCache, setTranslatedCache] = useState<Record<number, string>>(
    {}
  );

  const abortRef = useRef<AbortController | null>(null);

  // ✅ 기록/폴더 UI 상태
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [tree, setTree] = useState<FolderNode>({ id: "root", type: "folder", name: "root", children: [] });
  const [selectedFolderId, setSelectedFolderId] = useState<string>("root"); // 저장 대상 폴더
  const [expandedFolderIds, setExpandedFolderIds] = useState<Record<string, boolean>>({ root: true });

  useEffect(() => {
    const loaded = loadTree();
    setTree(loaded);
    setSelectedFolderId("root");
    setExpandedFolderIds((prev) => ({ ...prev, root: true }));
  }, []);

  useEffect(() => {
    // tree가 바뀔 때마다 저장
    try {
      saveTree(tree);
    } catch {
      // localStorage가 막혀있으면 무시
    }
  }, [tree]);

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

    // ✅ 캐시가 있으면 즉시 표시
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

  function handleCancel() {
    abortRef.current?.abort();
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(result);
      alert("번역본이 복사되었습니다.");
    } catch {
      alert("복사에 실패했습니다. 브라우저 권한을 확인해주세요.");
    }
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

    void runTranslation(nextText, nextIndex);
  }

  /** =========================
   *  History actions
   *  ========================= */

  function toggleExpand(folderId: string) {
    setExpandedFolderIds((prev) => ({ ...prev, [folderId]: !prev[folderId] }));
  }

  function ensureSelectedFolderExists(nextTree: FolderNode) {
    const found = findNodeById(nextTree, selectedFolderId);
    if (!found || found.type !== "folder") {
      setSelectedFolderId("root");
    }
  }

  function createFolder(parentFolderId: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;

    const newFolder: FolderNode = {
      id: uid(),
      type: "folder",
      name: trimmed,
      children: [],
    };

    const nextTree = updateFolderChildren(tree, parentFolderId, (children) => [
      ...children,
      newFolder,
    ]);

    setTree(nextTree);
    setExpandedFolderIds((prev) => ({ ...prev, [parentFolderId]: true, [newFolder.id]: true }));
  }

  function saveCurrentTranslationToFolder(folderId: string) {
    const folder = findNodeById(tree, folderId);
    if (!folder || folder.type !== "folder") {
      alert("저장할 폴더를 선택해 주세요.");
      return;
    }
    if (!result.trim()) {
      alert("저장할 번역 결과가 없습니다.");
      return;
    }

    const episodeLabel = `${episodeIndex + 1}화`;
    const itemName = `${seriesName} · ${episodeLabel}`;

    const item: ItemNode = {
      id: uid(),
      type: "item",
      name: itemName,
      createdAt: Date.now(),
      novelTitle,
      seriesPath: `${novelTitle}/${seriesName}`,
      episodeIndex,
      episodeLabel,
      sourceText: source,
      translatedText: result,
    };

    const nextTree = updateFolderChildren(tree, folderId, (children) => [
      item,
      ...children, // 최신 저장이 위로
    ]);

    setTree(nextTree);
    setExpandedFolderIds((prev) => ({ ...prev, [folderId]: true }));
    alert("저장 완료!");
  }

  function loadItemToViewer(item: ItemNode) {
    setEpisodeIndex(item.episodeIndex);
    setSource(item.sourceText);
    setResult(item.translatedText);
    setError("");
    setProgress(null);

    // 캐시에도 넣어두면 회차 이동 시 즉시 표시
    setTranslatedCache((prev) => ({ ...prev, [item.episodeIndex]: item.translatedText }));
    setIsHistoryOpen(false);
  }

  function deleteNodeById(nodeId: string) {
    if (nodeId === "root") return;
    const ok = confirm("삭제할까요? (폴더면 안의 항목도 함께 삭제됩니다)");
    if (!ok) return;

    const nextTree = removeNode(tree, nodeId);
    setTree(nextTree);
    ensureSelectedFolderExists(nextTree);
  }

  function FolderTree({
    folder,
    depth,
  }: {
    folder: FolderNode;
    depth: number;
  }) {
    const isExpanded = !!expandedFolderIds[folder.id];

    return (
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 8px",
            marginLeft: depth * 12,
            borderRadius: 8,
            background:
              selectedFolderId === folder.id ? "rgba(0,0,0,0.06)" : "transparent",
          }}
        >
          <button
            onClick={() => toggleExpand(folder.id)}
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              border: "1px solid #ddd",
              cursor: "pointer",
              fontWeight: 800,
            }}
            title={isExpanded ? "접기" : "펼치기"}
          >
            {isExpanded ? "−" : "+"}
          </button>

          <button
            onClick={() => setSelectedFolderId(folder.id)}
            style={{
              border: "none",
              background: "transparent",
              cursor: "pointer",
              fontWeight: 800,
              textAlign: "left",
              flex: 1,
            }}
            title="이 폴더에 저장"
          >
            📁 {folder.name === "root" ? "기록" : folder.name}
          </button>

          {folder.id !== "root" && (
            <button
              onClick={() => deleteNodeById(folder.id)}
              style={{
                width: 34,
                height: 28,
                borderRadius: 8,
                border: "1px solid #ddd",
                cursor: "pointer",
              }}
              title="폴더 삭제"
            >
              🗑
            </button>
          )}
        </div>

        {isExpanded && (
          <div style={{ marginTop: 4 }}>
            {folder.children.length === 0 ? (
              <div
                style={{
                  marginLeft: depth * 12 + 44,
                  opacity: 0.6,
                  fontSize: 13,
                  padding: "4px 0",
                }}
              >
                (비어 있음)
              </div>
            ) : (
              folder.children.map((child) => {
                if (child.type === "folder") {
                  return (
                    <FolderTree key={child.id} folder={child} depth={depth + 1} />
                  );
                }

                const item = child as ItemNode;
                return (
                  <div
                    key={item.id}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      padding: "6px 8px",
                      marginLeft: (depth + 1) * 12 + 32,
                      borderRadius: 8,
                      border: "1px solid #eee",
                      background: "#fff",
                    }}
                  >
                    <button
                      onClick={() => loadItemToViewer(item)}
                      style={{
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        textAlign: "left",
                        flex: 1,
                      }}
                      title="불러오기"
                    >
                      <div style={{ fontWeight: 800 }}>{item.name}</div>
                      <div style={{ fontSize: 12, opacity: 0.65 }}>
                        {item.seriesPath} · {formatDate(item.createdAt)}
                      </div>
                    </button>

                    <button
                      onClick={() => {
                        navigator.clipboard
                          .writeText(item.translatedText)
                          .then(() => alert("저장된 번역본을 복사했어요."))
                          .catch(() => alert("복사 실패(권한 확인)"));
                      }}
                      style={{
                        width: 40,
                        height: 28,
                        borderRadius: 8,
                        border: "1px solid #ddd",
                        cursor: "pointer",
                        fontWeight: 800,
                      }}
                      title="저장본 복사"
                    >
                      📋
                    </button>

                    <button
                      onClick={() => deleteNodeById(item.id)}
                      style={{
                        width: 34,
                        height: 28,
                        borderRadius: 8,
                        border: "1px solid #ddd",
                        cursor: "pointer",
                      }}
                      title="항목 삭제"
                    >
                      🗑
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>
    );
  }

  // 팝업에서 폴더 생성 입력 상태
  const [newFolderName, setNewFolderName] = useState("");

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 24 }}>
      {/* 상단 바 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 900, margin: 0 }}>
            Parody Translator
          </h1>
          <div style={{ opacity: 0.7, marginTop: 4, fontSize: 13 }}>
            {novelTitle} · {seriesName} · {episodeIndex + 1}/{episodes.length}화
          </div>
        </div>

        <button
          onClick={() => setIsHistoryOpen(true)}
          style={{
            height: 40,
            padding: "0 14px",
            borderRadius: 10,
            border: "1px solid #ddd",
            cursor: "pointer",
            fontWeight: 800,
          }}
          title="번역 기록"
        >
          🗂 기록
        </button>
      </div>

      <div style={{ opacity: 0.75, marginBottom: 12 }}>
        <div>
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

        {/* 번역 실행 */}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            onClick={() => runTranslation(source, undefined)}
            disabled={isLoading}
            style={{
              height: 44,
              padding: "0 14px",
              borderRadius: 10,
              border: "1px solid #ddd",
              cursor: isLoading ? "not-allowed" : "pointer",
              fontWeight: 800,
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
                fontWeight: 800,
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

        {/* 결과 */}
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

        {/* 하단 네비 + 복사 */}
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
              fontWeight: 800,
              opacity: !hasPrev ? 0.5 : 1,
            }}
          >
            이전화
          </button>

          <div style={{ display: "flex", gap: 8 }}>
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
                fontWeight: 900,
                opacity: !result.trim() ? 0.5 : 1,
              }}
            >
              📋
            </button>

            <button
              onClick={() => saveCurrentTranslationToFolder(selectedFolderId)}
              disabled={!result.trim()}
              title="선택한 폴더에 저장"
              style={{
                height: 42,
                padding: "0 12px",
                borderRadius: 10,
                border: "1px solid #ddd",
                cursor: !result.trim() ? "not-allowed" : "pointer",
                fontWeight: 900,
                opacity: !result.trim() ? 0.5 : 1,
              }}
            >
              💾 저장
            </button>
          </div>

          <button
            onClick={() => goToEpisode(episodeIndex + 1)}
            disabled={!hasNext || isLoading}
            style={{
              height: 42,
              padding: "0 14px",
              borderRadius: 10,
              border: "1px solid #ddd",
              cursor: !hasNext || isLoading ? "not-allowed" : "pointer",
              fontWeight: 800,
              opacity: !hasNext ? 0.5 : 1,
            }}
          >
            다음화
          </button>
        </div>
      </div>

      {/* =========================
          History Modal
         ========================= */}
      {isHistoryOpen && (
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
          onClick={() => setIsHistoryOpen(false)}
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
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                marginBottom: 10,
              }}
            >
              <div>
                <div style={{ fontSize: 18, fontWeight: 900 }}>번역 기록</div>
                <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>
                  폴더를 선택하면 아래의 “💾 저장” 버튼이 그 폴더로 저장됩니다.
                </div>
              </div>

              <button
                onClick={() => setIsHistoryOpen(false)}
                style={{
                  height: 36,
                  padding: "0 12px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  cursor: "pointer",
                  fontWeight: 900,
                }}
              >
                닫기
              </button>
            </div>

            {/* 폴더 생성 */}
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                marginBottom: 12,
                flexWrap: "wrap",
              }}
            >
              <input
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="새 폴더 이름 (선택한 폴더 안에 생성)"
                style={{
                  height: 38,
                  padding: "0 10px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  minWidth: 280,
                }}
              />
              <button
                onClick={() => {
                  createFolder(selectedFolderId, newFolderName);
                  setNewFolderName("");
                }}
                style={{
                  height: 38,
                  padding: "0 12px",
                  borderRadius: 10,
                  border: "1px solid #ddd",
                  cursor: "pointer",
                  fontWeight: 900,
                }}
              >
                📁 폴더 생성
              </button>

              <div style={{ fontSize: 12, opacity: 0.7 }}>
                현재 저장 대상:{" "}
                <b>
                  {(() => {
                    const n = findNodeById(tree, selectedFolderId);
                    if (!n || n.type !== "folder") return "기록";
                    return n.id === "root" ? "기록" : n.name;
                  })()}
                </b>
              </div>
            </div>

            {/* 트리 */}
            <FolderTree folder={tree} depth={0} />
          </div>
        </div>
      )}
    </main>
  );
}
