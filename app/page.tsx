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
  name: string; // 히스토리 표시명: "소설제목 · 제 N화"
  createdAt: number;

  // 메타(표시/헤더용)
  seriesTitle: string; // 패러디/웹소설 큰 제목
  episodeIndex: number;
  episodeSubtitle: string; // 부제목(없을 수 있음)

  sourceText: string;
  translatedBody: string;

  // ✅ 중복 방지(같은 제목+회차면 최신 번역으로 업데이트)
  key: string; // seriesTitle|episodeIndex
};

type TreeNode = FolderNode | ItemNode;

const STORAGE_KEY = "parody_translator_history_v5"; // v5: 히스토리 루트 단일 + 폴더명 수정 + 헤더(제목/회차/부제목)
const ROOT_ID = "history_root";
const ROOT_NAME = "히스토리";

function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadTree(): FolderNode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { id: ROOT_ID, type: "folder", name: ROOT_NAME, children: [] };

    const parsed = JSON.parse(raw);
    if (!parsed || parsed.type !== "folder" || !Array.isArray(parsed.children)) {
      return { id: ROOT_ID, type: "folder", name: ROOT_NAME, children: [] };
    }
    // 루트 이름/ID 강제(이전 버전 데이터가 있어도 정합 유지)
    return { ...(parsed as FolderNode), id: ROOT_ID, name: ROOT_NAME };
  } catch {
    return { id: ROOT_ID, type: "folder", name: ROOT_NAME, children: [] };
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
    if (child.type === "item" && (child as ItemNode).key === key) return child as ItemNode;
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

function renameFolderById(root: FolderNode, folderId: string, nextName: string): FolderNode {
  if (root.id === folderId) {
    // 루트는 이름 고정
    return root;
  }
  function helper(folder: FolderNode): FolderNode {
    const nextChildren = folder.children.map((c) => {
      if (c.type === "folder") {
        const fc = c as FolderNode;
        if (fc.id === folderId) return { ...fc, name: nextName };
        return helper(fc);
      }
      return c;
    });
    return { ...folder, children: nextChildren };
  }
  return helper(root);
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
 *  Header builder
 *  ========================= */
function buildEpisodeLine(episodeIndex: number, subtitle: string) {
  const n = episodeIndex + 1;
  const t = subtitle.trim();
  return t ? `제 ${n}화 · ${t}` : `제 ${n}화`;
}

function buildFullText(seriesTitle: string, episodeIndex: number, subtitle: string, body: string) {
  const title = seriesTitle.trim() || "제목 없음";
  const episodeLine = buildEpisodeLine(episodeIndex, subtitle);
  // 제목(1줄) + 빈줄(1) + 회차줄(1줄) + 빈줄(2) + 본문
  return `${title}\n\n${episodeLine}\n\n\n${body.trim()}`;
}

/** =========================
 *  Page
 *  ========================= */
export default function Page() {
  /** ✅ 패러디/웹소설 큰 제목(=시리즈 큰 제목) */
  const [seriesTitle, setSeriesTitle] = useState("코난패러디소설");
  /** ✅ 부제목(회차 설명) */
  const [episodeSubtitle, setEpisodeSubtitle] = useState("");

  /** ✅ 테스트용 회차(나중에 실제 원문으로 교체) */
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
  const [translatedBody, setTranslatedBody] = useState(""); // ✅ 본문만(화면 표시용)
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<Progress>(null);

  // ✅ 회차별 번역 캐시(본문만)
  const [translatedCache, setTranslatedCache] = useState<Record<number, string>>({});
  const abortRef = useRef<AbortController | null>(null);

  // ✅ 기록/폴더 UI
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [tree, setTree] = useState<FolderNode>({ id: ROOT_ID, type: "folder", name: ROOT_NAME, children: [] });
  const [selectedFolderId, setSelectedFolderId] = useState<string>(ROOT_ID); // 이동/정리 대상 폴더
  const [expandedFolderIds, setExpandedFolderIds] = useState<Record<string, boolean>>({ [ROOT_ID]: true });
  const [newFolderName, setNewFolderName] = useState("");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  // ✅ 드래그(PC)
  const [draggingItemId, setDraggingItemId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);

  useEffect(() => {
    const loaded = loadTree();
    setTree(loaded);
    setSelectedFolderId(ROOT_ID);
    setExpandedFolderIds((prev) => ({ ...prev, [ROOT_ID]: true }));
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

  async function handleCopyFull() {
    const full = buildFullText(seriesTitle, episodeIndex, episodeSubtitle, translatedBody);
    try {
      await navigator.clipboard.writeText(full);
      alert("번역본(제목/회차/부제목+본문)이 복사되었습니다.");
    } catch {
      alert("복사에 실패했습니다. 브라우저 권한을 확인해주세요.");
    }
  }

  /** ✅ 자동 저장: 번역 완료 시 히스토리(루트)에 시간순으로 쌓임 / 같은 회차는 업데이트 */
  function autoSaveHistory(params: {
    episodeIndex: number;
    sourceText: string;
    translatedBody: string;
    seriesTitle: string;
    episodeSubtitle: string;
  }) {
    const key = `${params.seriesTitle.trim()}|${params.episodeIndex}`;

    const itemName = `${params.seriesTitle.trim() || "제목 없음"} · 제 ${params.episodeIndex + 1}화`;

    const existing = findItemByKey(tree, key);
    if (existing) {
      const nextItem: ItemNode = {
        ...existing,
        name: itemName,
        createdAt: Date.now(),
        seriesTitle: params.seriesTitle,
        episodeIndex: params.episodeIndex,
        episodeSubtitle: params.episodeSubtitle,
        sourceText: params.sourceText,
        translatedBody: params.translatedBody,
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
      seriesTitle: params.seriesTitle,
      episodeIndex: params.episodeIndex,
      episodeSubtitle: params.episodeSubtitle,
      sourceText: params.sourceText,
      translatedBody: params.translatedBody,
      key,
    };

    // ✅ 루트 맨 위에 추가(최신이 위)
    const nextTree = updateFolderChildren(tree, ROOT_ID, (children) => [item, ...children]);
    setTree(nextTree);
  }

  async function runTranslation(text: string, cacheKey?: number) {
    const trimmed = text.trim();
    if (!trimmed) return;

    // ✅ 캐시가 있으면 즉시 표시(본문만)
    if (cacheKey !== undefined && translatedCache[cacheKey]) {
      setTranslatedBody(translatedCache[cacheKey]);
      setError("");
      setProgress(null);
      return;
    }

    setIsLoading(true);
    setTranslatedBody("");
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
        setTranslatedBody(out);
      }

      setProgress({ current: chunks.length, total: chunks.length });
      setTranslatedBody(out);

      if (cacheKey !== undefined) {
        setTranslatedCache((prev) => ({ ...prev, [cacheKey]: out }));
        autoSaveHistory({
          episodeIndex: cacheKey,
          sourceText: trimmed,
          translatedBody: out,
          seriesTitle,
          episodeSubtitle,
        });
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

  const percent = progress && progress.total > 0 ? Math.floor((progress.current / progress.total) * 100) : 0;

  function goToEpisode(nextIndex: number) {
    const nextText = episodes[nextIndex] ?? "";
    setEpisodeIndex(nextIndex);
    setSource(nextText);
    setTranslatedBody("");
    setError("");
    setProgress(null);
    void runTranslation(nextText, nextIndex); // ✅ 다음/이전화 누르면 자동 번역 + 자동저장
  }

  /** =========================
   *  Folder actions
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

  function renameFolder(folderId: string) {
    if (folderId === ROOT_ID) return;
    const node = findNodeById(tree, folderId);
    if (!node || node.type !== "folder") return;

    const current = node.name;
    const next = prompt("폴더 이름을 수정하세요:", current);
    if (next === null) return;

    const trimmed = next.trim();
    if (!trimmed) {
      alert("이름은 비워둘 수 없어요.");
      return;
    }

    const nextTree = renameFolderById(tree, folderId, trimmed);
    setTree(nextTree);
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

    const { nextRoot, extracted } = extractNode(tree, selectedItemId);
    if (!extracted) return;

    const nextTree = updateFolderChildren(nextRoot, targetFolderId, (children) => [extracted, ...children]);
    setTree(nextTree);
    setSelectedItemId(null);
    alert("이동 완료!");
  }

  function moveItemByDrag(itemId: string, targetFolderId: string) {
    const target = findNodeById(tree, targetFolderId);
    if (!target || target.type !== "folder") return;

    const { nextRoot, extracted } = extractNode(tree, itemId);
    if (!extracted) return;

    const nextTree = updateFolderChildren(nextRoot, targetFolderId, (children) => [extracted, ...children]);
    setTree(nextTree);
    setSelectedItemId(null);
  }

  function deleteNodeById(nodeId: string) {
    if (nodeId === ROOT_ID) return;

    const ok = confirm("삭제할까요? (폴더면 안의 항목도 함께 삭제됩니다)");
    if (!ok) return;

    const nextTree = removeNode(tree, nodeId);
    setTree(nextTree);
    if (selectedItemId === nodeId) setSelectedItemId(null);
  }

  function loadItemToViewer(item: ItemNode) {
    setEpisodeIndex(item.episodeIndex);
    setSeriesTitle(item.seriesTitle);
    setEpisodeSubtitle(item.episodeSubtitle);
    setSource(item.sourceText);
    setTranslatedBody(item.translatedBody);
    setError("");
    setProgress(null);
    setTranslatedCache((prev) => ({ ...prev, [item.episodeIndex]: item.translatedBody }));
    setIsHistoryOpen(false);
  }

  function FolderTree({ folder, depth }: { folder: FolderNode; depth: number }) {
    const isExpanded = !!expandedFolderIds[folder.id];
    const isDropOver = dragOverFolderId === folder.id;

    return (
      <div>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverFolderId(folder.id);
          }}
          onDragLeave={() => {
            setDragOverFolderId((cur) => (cur === folder.id ? null : cur));
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (draggingItemId) moveItemByDrag(draggingItemId, folder.id);
            setDraggingItemId(null);
            setDragOverFolderId(null);
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 8px",
            marginLeft: depth * 12,
            borderRadius: 10,
            background: selectedFolderId === folder.id ? "rgba(0,0,0,0.06)" : "transparent",
            outline: isDropOver ? "2px dashed #888" : "none",
            outlineOffset: 2,
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
            title="정리(이동/생성) 대상 폴더 선택"
          >
            📁 {folder.id === ROOT_ID ? ROOT_NAME : folder.name}
          </button>

          {folder.id !== ROOT_ID && (
            <>
              <button
                onClick={() => renameFolder(folder.id)}
                style={{
                  width: 34,
                  height: 28,
                  borderRadius: 8,
                  border: "1px solid #ddd",
                  cursor: "pointer",
                }}
                title="폴더 이름 수정"
              >
                ✏️
              </button>

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
            </>
          )}
        </div>

        {isExpanded && (
          <div style={{ marginTop: 6 }}>
            {folder.children.length === 0 ? (
              <div style={{ marginLeft: depth * 12 + 44, opacity: 0.6, fontSize: 13, padding: "4px 0" }}>(비어 있음)</div>
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
                      borderRadius: 10,
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

                    {/* ✅ 드래그 핸들(PC) */}
                    <div
                      draggable
                      onDragStart={() => setDraggingItemId(item.id)}
                      onDragEnd={() => {
                        setDraggingItemId(null);
                        setDragOverFolderId(null);
                      }}
                      title="드래그해서 폴더에 놓기(PC)"
                      style={{
                        width: 34,
                        height: 28,
                        borderRadius: 8,
                        border: "1px solid #ddd",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        cursor: "grab",
                        userSelect: "none",
                        fontWeight: 900,
                      }}
                    >
                      ≡
                    </div>

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
                        {formatDate(item.createdAt)} · {buildEpisodeLine(item.episodeIndex, item.episodeSubtitle)}
                      </div>
                    </button>

                    <button
                      onClick={() => {
                        const full = buildFullText(item.seriesTitle, item.episodeIndex, item.episodeSubtitle, item.translatedBody);
                        navigator.clipboard
                          .writeText(full)
                          .then(() => alert("저장된 번역본(헤더 포함)을 복사했어요."))
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
                      title="저장본 복사(헤더 포함)"
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

  const episodeLine = buildEpisodeLine(episodeIndex, episodeSubtitle);
  const fullTextForCopy = translatedBody.trim()
    ? buildFullText(seriesTitle, episodeIndex, episodeSubtitle, translatedBody)
    : "";

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 24 }}>
      {/* 상단 바 */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 10 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 22, fontWeight: 900, margin: 0 }}>Parody Translator</h1>
          <div style={{ opacity: 0.7, marginTop: 6, fontSize: 13 }}>
            번역하면 <b>히스토리</b>에 자동 저장됩니다 · {episodeIndex + 1}/{episodes.length}화
          </div>
        </div>

        <button
          onClick={() => setIsHistoryOpen(true)}
          style={{ height: 40, padding: "0 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900, marginTop: 2 }}
          title="번역 기록"
        >
          🗂 히스토리
        </button>
      </div>

      {/* 메타 입력(제목/부제목) */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <input
          value={seriesTitle}
          onChange={(e) => setSeriesTitle(e.target.value)}
          placeholder="패러디/웹소설 제목(큰 제목)"
          style={{ height: 40, padding: "0 10px", borderRadius: 10, border: "1px solid #ddd", minWidth: 280 }}
        />
        <input
          value={episodeSubtitle}
          onChange={(e) => setEpisodeSubtitle(e.target.value)}
          placeholder="부제목(선택)"
          style={{ height: 40, padding: "0 10px", borderRadius: 10, border: "1px solid #ddd", minWidth: 220 }}
        />
      </div>

      <div style={{ opacity: 0.75, marginBottom: 12, fontSize: 13 }}>
        예상 분할: {chunksPreview.chunksCount}조각 · 글자수: {chunksPreview.totalChars.toLocaleString()}자
      </div>

      <div style={{ display: "grid", gap: 12 }}>
        <textarea
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="여기에 원문을 붙여넣기…"
          style={{ width: "100%", minHeight: 180, padding: 12, fontSize: 14, borderRadius: 10, border: "1px solid #ddd", outline: "none" }}
        />

        {/* 번역 실행 */}
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button
            onClick={() => runTranslation(source, episodeIndex)}
            disabled={isLoading}
            style={{
              height: 44,
              padding: "0 14px",
              borderRadius: 10,
              border: "1px solid #ddd",
              cursor: isLoading ? "not-allowed" : "pointer",
              fontWeight: 900,
            }}
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

        {/* ✅ 결과 헤더(클로모 느낌) */}
        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: 12,
            padding: 14,
            background: "#fafafa",
          }}
        >
          <div style={{ fontSize: 22, fontWeight: 800, lineHeight: 1.25 }}>{seriesTitle.trim() || "제목 없음"}</div>
          <div style={{ marginTop: 6, fontSize: 13, opacity: 0.75 }}>{episodeLine}</div>

          {/* 본문 시작 전 여백 충분히 */}
          <div style={{ height: 16 }} />

          <textarea
            value={translatedBody}
            readOnly
            placeholder="번역 결과(본문)가 여기 표시됩니다…"
            style={{
              width: "100%",
              minHeight: 240,
              padding: 12,
              fontSize: 14,
              borderRadius: 10,
              border: "1px solid #ddd",
              outline: "none",
              background: "#fff",
              whiteSpace: "pre-wrap",
            }}
          />
        </div>

        {/* 하단 네비 + 복사 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 2 }}>
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
            onClick={handleCopyFull}
            disabled={!fullTextForCopy}
            title="번역본 복사(제목/회차/부제목+본문)"
            style={{
              height: 42,
              width: 48,
              borderRadius: 10,
              border: "1px solid #ddd",
              cursor: !fullTextForCopy ? "not-allowed" : "pointer",
              fontWeight: 900,
              opacity: !fullTextForCopy ? 0.5 : 1,
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
                <div style={{ fontSize: 18, fontWeight: 900 }}>히스토리</div>
                <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>
                  1) 번역하면 시간순으로 쌓임 → 2) 폴더 생성 → 3) 항목 선택(○) 후 “선택 폴더로 이동” 또는 드래그(≡)
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
                    if (!n || n.type !== "folder") return ROOT_NAME;
                    return n.id === ROOT_ID ? ROOT_NAME : n.name;
                  })()}
                </b>
                {" · "}
                이동할 항목: <b>{selectedItemId ? "선택됨" : "없음"}</b>
              </div>
            </div>

            {/* 트리(루트 = 히스토리만) */}
            <FolderTree folder={tree} depth={0} />
          </div>
        </div>
      )}
    </main>
  );
}
```0
