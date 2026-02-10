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
  novelTitle: string;
  seriesName: string;
  episodeIndex: number;
  episodeLabel: string;
  sourceText: string;
  translatedText: string;

  // ✅ 자동 저장/중복 방지 키
  key: string; // novelTitle|seriesName|episodeIndex
};

type TreeNode = FolderNode | ItemNode;

const STORAGE_KEY = "parody_translator_history_v2";
const ROOT_ID = "root";
const INBOX_ID = "inbox_auto";
const INBOX_NAME = "미분류(자동저장)";

function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadTree(): FolderNode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { id: ROOT_ID, type: "folder", name: "root", children: [] };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.type !== "folder" || !Array.isArray(parsed.children)) {
      return { id: ROOT_ID, type: "folder", name: "root", children: [] };
    }
    return parsed as FolderNode;
  } catch {
    return { id: ROOT_ID, type: "folder", name: "root", children: [] };
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

function extractNode(root: FolderNode, targetId: string): { nextRoot: FolderNode; extracted: TreeNode | null } {
  let extracted: TreeNode | null = null;

  function helper(folder: FolderNode): FolderNode {
    const nextChildren: TreeNode[] = [];
    for (const child of folder.children) {
      if (child.id === targetId) {
        extracted = child;
        continue;
      }
      if (child.type === "folder") nextChildren.push(helper(child));
      else nextChildren.push(child);
    }
    return { ...folder, children: nextChildren };
  }

  const nextRoot = helper(root);
  return { nextRoot, extracted };
}

function findItemByKey(root: FolderNode, key: string): ItemNode | null {
  for (const child of root.children) {
    if (child.type === "item" && child.key === key) return child as ItemNode;
    if (child.type === "folder") {
      const found = findItemByKey(child, key);
      if (found) return found;
    }
  }
  return null;
}

function replaceItemById(root: FolderNode, itemId: string, nextItem: ItemNode): FolderNode {
  function helper(folder: FolderNode): FolderNode {
    const nextChildren = folder.children.map((c) => {
      if (c.type === "item" && c.id === itemId) return nextItem;
      if (c.type === "folder") return helper(c);
      return c;
    });
    return { ...folder, children: nextChildren };
  }
  return helper(root);
}

function ensureInbox(root: FolderNode): FolderNode {
  const exists = findNodeById(root, INBOX_ID);
  if (exists && exists.type === "folder") return root;

  const inbox: FolderNode = { id: INBOX_ID, type: "folder", name: INBOX_NAME, children: [] };
  // inbox는 루트 최상단에 고정
  return { ...root, children: [inbox, ...root.children.filter((c) => c.id !== INBOX_ID)] };
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
 *  Page
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
  const [translatedCache, setTranslatedCache] = useState<Record<number, string>>({});
  const abortRef = useRef<AbortController | null>(null);

  // ✅ 기록/폴더 UI
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [tree, setTree] = useState<FolderNode>({ id: ROOT_ID, type: "folder", name: "root", children: [] });
  const [selectedFolderId, setSelectedFolderId] = useState<string>(INBOX_ID); // 이동/정리 대상
  const [expandedFolderIds, setExpandedFolderIds] = useState<Record<string, boolean>>({ [ROOT_ID]: true, [INBOX_ID]: true });
  const [newFolderName, setNewFolderName] = useState("");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  useEffect(() => {
    const loaded = ensureInbox(loadTree());
    setTree(loaded);
    setSelectedFolderId(INBOX_ID);
    setExpandedFolderIds((prev) => ({ ...prev, [ROOT_ID]: true, [INBOX_ID]: true }));
  }, []);

  useEffect(() => {
    try {
      saveTree(tree);
    } catch {
      // ignore
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
    if (!res.ok) throw new Error(data?.error || "번역 중 오류가 발생했어요.");
    return String(data?.translated ?? "");
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

  // ✅ 자동 저장: 번역 완료 시 '미분류(자동저장)'에 저장/업데이트
  function autoSaveHistory(params: {
    episodeIndex: number;
    sourceText: string;
    translatedText: string;
  }) {
    const key = `${novelTitle}|${seriesName}|${params.episodeIndex}`;
    const episodeLabel = `${params.episodeIndex + 1}화`;
    const itemName = `${seriesName} · ${episodeLabel}`;

    const existing = findItemByKey(tree, key);
    if (existing) {
      // 같은 회차는 "최신 번역"으로 업데이트
      const nextItem: ItemNode = {
        ...existing,
        name: itemName,
        createdAt: Date.now(),
        sourceText: params.sourceText,
        translatedText: params.translatedText,
        episodeLabel,
        episodeIndex: params.episodeIndex,
        novelTitle,
        seriesName,
        key,
      };
      const nextTree = replaceItemById(tree, existing.id, nextItem);
      setTree(nextTree);
      return;
    }

    const item: ItemNode = {
      id: uid(),
      type: "item",
      name: itemName,
      createdAt: Date.now(),
      novelTitle,
      seriesName,
      episodeIndex: params.episodeIndex,
      episodeLabel,
      sourceText: params.sourceText,
      translatedText: params.translatedText,
      key,
    };

    // inbox 맨 위에 추가
    const nextTree = updateFolderChildren(tree, INBOX_ID, (children) => [item, ...children]);
    setTree(nextTree);
  }

  async function runTranslation(text: string, cacheKey?: number) {
    const trimmed = text.trim();
    if (!trimmed) return;

    // ✅ 캐시 있으면 즉시 표시 + (자동저장은 이미 되어있다고 가정)
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
        throw new Error(`회차가 너무 길어서 (${chunks.length}조각) 자동 처리 부담이 큽니다. 한 번에 넣는 분량을 줄여 주세요.`);
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
        // ✅ 자동 저장
        autoSaveHistory({ episodeIndex: cacheKey, sourceText: trimmed, translatedText: out });
      }
    } catch (e: any) {
      if (e?.name === "AbortError") setError("번역이 취소되었습니다.");
      else setError(e?.message || "알 수 없는 오류");
    } finally {
      setIsLoading(false);
      abortRef.current = null;
    }
  }

  const hasPrev = episodeIndex > 0;
  const hasNext = episodeIndex < episodes.length - 1;

  const percent =
    progress && progress.total > 0 ? Math.floor((progress.current / progress.total) * 100) : 0;

  function goToEpisode(nextIndex: number) {
    const nextText = episodes[nextIndex] ?? "";
    setEpisodeIndex(nextIndex);
    setSource(nextText);
    setResult("");
    setError("");
    setProgress(null);
    void runTranslation(nextText, nextIndex); // ✅ 다음/이전화 누르면 자동 번역 + 자동저장
  }

  /** =========================
   *  Folder actions (정리용)
   *  ========================= */
  function toggleExpand(folderId: string) {
    setExpandedFolderIds((prev) => ({ ...prev, [folderId]: !prev[folderId] }));
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

    const nextTree = updateFolderChildren(tree, parentFolderId, (children) => [...children, newFolder]);
    setTree(nextTree);
    setExpandedFolderIds((prev) => ({ ...prev, [parentFolderId]: true, [newFolder.id]: true }));
  }

  function moveSelectedItemToFolder(targetFolderId: string) {
    if (!selectedItemId) {
      alert("이동할 항목을 먼저 선택해 주세요.");
      return;
    }
    const target = findNodeById(tree, targetFolderId);
    if (!target || target.type !== "folder") {
      alert("이동할 폴더를 선택해 주세요.");
      return;
    }

    // 같은 폴더로 이동 방지(대충)
    const { nextRoot, extracted } = extractNode(tree, selectedItemId);
    if (!extracted) return;

    const nextTree = updateFolderChildren(nextRoot, targetFolderId, (children) => [extracted, ...children]);
    setTree(nextTree);
    setSelectedItemId(null);
    alert("이동 완료!");
  }

  function deleteNodeById(nodeId: string) {
    if (nodeId === ROOT_ID || nodeId === INBOX_ID) return;
    const ok = confirm("삭제할까요? (폴더면 안의 항목도 함께 삭제됩니다)");
    if (!ok) return;

    const nextTree = removeNode(tree, nodeId);
    setTree(nextTree);
    if (selectedItemId === nodeId) setSelectedItemId(null);
  }

  function loadItemToViewer(item: ItemNode) {
    setEpisodeIndex(item.episodeIndex);
    setSource(item.sourceText);
    setResult(item.translatedText);
    setError("");
    setProgress(null);
    setTranslatedCache((prev) => ({ ...prev, [item.episodeIndex]: item.translatedText }));
    setIsHistoryOpen(false);
  }

  function FolderTree({ folder, depth }: { folder: FolderNode; depth: number }) {
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
            background: selectedFolderId === folder.id ? "rgba(0,0,0,0.06)" : "transparent",
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
              fontWeight: 900,
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
              fontWeight: 900,
              textAlign: "left",
              flex: 1,
            }}
            title="정리(이동) 대상 폴더 선택"
          >
            📁 {folder.id === ROOT_ID ? "최상위" : folder.name}
          </button>

          {folder.id !== ROOT_ID && folder.id !== INBOX_ID && (
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
              <div style={{ marginLeft: depth * 12 + 44, opacity: 0.6, fontSize: 13, padding: "4px 0" }}>
                (비어 있음)
              </div>
            ) : (
              folder.children.map((child) => {
                if (child.type === "folder") {
                  return <FolderTree key={child.id} folder={child} depth={depth + 1} />;
                }

                const item = child as ItemNode;
                const isSelected = selectedItemId === item.id;

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
                      border: isSelected ? "2px solid #888" : "1px solid #eee",
                      background: "#fff",
                    }}
                  >
                    <button
                      onClick={() => setSelectedItemId(item.id)}
                      style={{
                        width: 34,
                        height: 28,
                        borderRadius: 8,
                        border: "1px solid #ddd",
                        cursor: "pointer",
                        fontWeight: 900,
                      }}
                      title="이동할 항목으로 선택"
                    >
                      {isSelected ? "✔" : "○"}
                    </button>

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
                      <div style={{ fontWeight: 900 }}>{item.name}</div>
                      <div style={{ fontSize: 12, opacity: 0.65 }}>
                        {item.novelTitle}/{item.seriesName} · {formatDate(item.createdAt)}
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
                        fontWeight: 900,
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

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 24 }}>
      {/* 상단 바 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 900, margin: 0 }}>Parody Translator</h1>
          <div style={{ opacity: 0.7, marginTop: 4, fontSize: 13 }}>
            {novelTitle} · {seriesName} · {episodeIndex + 1}/{episodes.length}화
          </div>
        </div>

        <button
          onClick={() => setIsHistoryOpen(true)}
          style={{ height: 40, padding: "0 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900 }}
          title="번역 기록"
        >
          🗂 기록
        </button>
      </div>

      <div style={{ opacity: 0.75, marginBottom: 12 }}>
        <div>
          예상 분할: {chunksPreview.chunksCount}조각 · 글자수: {chunksPreview.totalChars.toLocaleString()}자
        </div>
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        <textarea
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="여기에 원문을 붙여넣기…"
          style={{ width: "100%", minHeight: 180, padding: 12, fontSize: 14, borderRadius: 10, border: "1px solid #ddd", outline: "none" }}
        />

        {/* 번역 실행 */}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <button
            onClick={() => runTranslation(source, episodeIndex)}
            disabled={isLoading}
            style={{ height: 44, padding: "0 14px", borderRadius: 10, border: "1px solid #ddd", cursor: isLoading ? "not-allowed" : "pointer", fontWeight: 900 }}
          >
            {isLoading ? "번역 중..." : "번역하기"}
          </button>

          {isLoading && (
            <button
              onClick={handleCancel}
              style={{ height: 44, padding: "0 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900 }}
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
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 6 }}>
          <button
            onClick={() => goToEpisode(episodeIndex - 1)}
            disabled={!hasPrev || isLoading}
            style={{
              height: 42,
              padding: "0 14px",
              borderRadius: 10,
              border: "1px solid #ddd",
              cursor: !hasPrev || isLoading ? "not-allowed" : "pointer",
              fontWeight: 900,
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
              fontWeight: 900,
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
              fontWeight: 900,
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
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 900 }}>번역 기록 (자동 저장됨)</div>
                <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>
                  1) 번역하면 “{INBOX_NAME}”에 자동으로 쌓임 → 2) 새 폴더 만들고 → 3) 항목 선택(○) 후 “선택 폴더로 이동”
                </div>
              </div>

              <button
                onClick={() => setIsHistoryOpen(false)}
                style={{ height: 36, padding: "0 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900 }}
              >
                닫기
              </button>
            </div>

            {/* 폴더 생성 + 이동 */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
              <input
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                placeholder="새 폴더 이름 (선택한 폴더 안에 생성)"
                style={{ height: 38, padding: "0 10px", borderRadius: 10, border: "1px solid #ddd", minWidth: 280 }}
              />
              <button
                onClick={() => {
                  createFolder(selectedFolderId, newFolderName);
                  setNewFolderName("");
                }}
                style={{ height: 38, padding: "0 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900 }}
              >
                📁 폴더 생성
              </button>

              <button
                onClick={() => moveSelectedItemToFolder(selectedFolderId)}
                style={{ height: 38, padding: "0 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900 }}
                title="선택한 항목(○)을 선택한 폴더로 이동"
              >
                📦 선택 폴더로 이동
              </button>

              <div style={{ fontSize: 12, opacity: 0.7 }}>
                현재 선택 폴더:{" "}
                <b>
                  {(() => {
                    const n = findNodeById(tree, selectedFolderId);
                    if (!n || n.type !== "folder") return "최상위";
                    return n.id === ROOT_ID ? "최상위" : n.name;
                  })()}
                </b>
                {" · "}
                이동할 항목: <b>{selectedItemId ? "선택됨" : "없음"}</b>
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
