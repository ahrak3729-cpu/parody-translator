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
  name: string; // 히스토리 표시명: 소설제목 + 회차
  createdAt: number;

  novelTitle: string; // 큰 제목(=시리즈/작품명)
  episodeIndex: number;
  episodeLabel: string; // 1화, 2화...
  subtitle: string; // 부제목(선택)
  sourceText: string;
  translatedText: string;

  key: string; // novelTitle|episodeIndex (같은 회차 업데이트용)
};

type TreeNode = FolderNode | ItemNode;

const STORAGE_KEY = "parody_translator_history_v3";
const ROOT_ID = "history_root";
const ROOT_NAME = "히스토리";

function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadTree(): FolderNode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { id: ROOT_ID, type: "folder", name: ROOT_NAME, children: [] };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.type !== "folder" || !Array.isArray(parsed.children)) {
      return { id: ROOT_ID, type: "folder", name: ROOT_NAME, children: [] };
    }
    // 혹시 이전 버전 루트명이 달라도 강제로 교정
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

function renameFolderById(root: FolderNode, folderId: string, nextName: string): FolderNode {
  const name = nextName.trim();
  if (!name) return root;

  function helper(folder: FolderNode): FolderNode {
    const nextChildren = folder.children.map((c) => {
      if (c.type === "folder") {
        if (c.id === folderId) return { ...c, name };
        return helper(c);
      }
      return c;
    });
    if (folder.id === folderId) return { ...folder, name };
    return { ...folder, children: nextChildren };
  }

  // 루트는 UI에서 숨기지만 이름은 고정
  if (folderId === ROOT_ID) return root;
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
 *  Page
 *  ========================= */
export default function Page() {
  /** ✅ 작품/회차 정보 (나중에 URL/목차로 교체) */
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
  const [novelTitle, setNovelTitle] = useState("코난패러디소설"); // ✅ 큰 제목(=시리즈/작품명)
  const [subtitle, setSubtitle] = useState(""); // ✅ 부제목(선택)

  const [source, setSource] = useState(episodes[0] ?? "");
  const [result, setResult] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<Progress>(null);

  // ✅ 회차별 번역 캐시
  const [translatedCache, setTranslatedCache] = useState<Record<number, string>>({});
  const abortRef = useRef<AbortController | null>(null);

  // ✅ 히스토리/폴더
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [tree, setTree] = useState<FolderNode>({ id: ROOT_ID, type: "folder", name: ROOT_NAME, children: [] });
  const [selectedFolderId, setSelectedFolderId] = useState<string>(ROOT_ID);
  const [expandedFolderIds, setExpandedFolderIds] = useState<Record<string, boolean>>({ [ROOT_ID]: true });
  const [newFolderName, setNewFolderName] = useState("");
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);

  // rename UI
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");

  useEffect(() => {
    setTree(loadTree());
    setSelectedFolderId(ROOT_ID);
    setExpandedFolderIds({ [ROOT_ID]: true });
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

  /** ✅ 자동 저장: 히스토리 최상단(루트)에 쌓임. 같은 회차는 최신으로 업데이트 */
  function autoSaveHistory(params: {
    episodeIndex: number;
    sourceText: string;
    translatedText: string;
  }) {
    const key = `${novelTitle}|${params.episodeIndex}`;
    const episodeLabel = `${params.episodeIndex + 1}화`;
    const historyName = `${novelTitle} · ${episodeLabel}`; // ✅ 히스토리 표시명(간단히)

    const existing = findItemByKey(tree, key);
    if (existing) {
      const nextItem: ItemNode = {
        ...existing,
        name: historyName,
        createdAt: Date.now(),
        sourceText: params.sourceText,
        translatedText: params.translatedText,
        episodeLabel,
        episodeIndex: params.episodeIndex,
        novelTitle,
        subtitle,
        key,
      };
      const nextTree = replaceItemById(tree, existing.id, nextItem);
      setTree(nextTree);
      return;
    }

    const item: ItemNode = {
      id: uid(),
      type: "item",
      name: historyName,
      createdAt: Date.now(),
      novelTitle,
      episodeIndex: params.episodeIndex,
      episodeLabel,
      subtitle,
      sourceText: params.sourceText,
      translatedText: params.translatedText,
      key,
    };

    // ✅ 루트 최상단에 추가(최근이 위)
    const nextTree = updateFolderChildren(tree, ROOT_ID, (children) => [item, ...children]);
    setTree(nextTree);
  }

  async function runTranslation(text: string, cacheKey?: number) {
    const trimmed = text.trim();
    if (!trimmed) return;

    // ✅ 캐시 있으면 즉시 표시
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

  const percent = progress && progress.total > 0 ? Math.floor((progress.current / progress.total) * 100) : 0;

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

  function deleteNodeById(nodeId: string) {
    if (nodeId === ROOT_ID) return;
    const ok = confirm("삭제할까요? (폴더면 안의 항목도 함께 삭제됩니다)");
    if (!ok) return;

    const nextTree = removeNode(tree, nodeId);
    setTree(nextTree);
    if (selectedItemId === nodeId) setSelectedItemId(null);
  }

  function startRename(folderId: string, currentName: string) {
    setRenamingFolderId(folderId);
    setRenameText(currentName);
  }

  function applyRename() {
    if (!renamingFolderId) return;
    const nextTree = renameFolderById(tree, renamingFolderId, renameText);
    setTree(nextTree);
    setRenamingFolderId(null);
    setRenameText("");
  }

  function loadItemToViewer(item: ItemNode) {
    setEpisodeIndex(item.episodeIndex);
    setNovelTitle(item.novelTitle);
    setSubtitle(item.subtitle ?? "");
    setSource(item.sourceText);
    setResult(item.translatedText);
    setError("");
    setProgress(null);
    setTranslatedCache((prev) => ({ ...prev, [item.episodeIndex]: item.translatedText }));
    setIsHistoryOpen(false);
  }

  function FolderTree({ folder, depth }: { folder: FolderNode; depth: number }) {
    const isExpanded = !!expandedFolderIds[folder.id];
    const isRoot = folder.id === ROOT_ID;

    // ✅ 루트는 “UI상” 폴더 줄을 숨기고, children만 보여줌
    if (isRoot) {
      return (
        <div style={{ marginTop: 6 }}>
          {/* 최상단에는 루트 children만 표시 */}
          {folder.children.length === 0 ? (
            <div style={{ opacity: 0.6, fontSize: 13, padding: "10px 2px" }}>(아직 저장된 히스토리가 없어요)</div>
          ) : (
            folder.children.map((child) => {
              if (child.type === "folder") return <FolderTree key={child.id} folder={child} depth={0} />;

              const item = child as ItemNode;
              const isSelected = selectedItemId === item.id;

              return (
                <div
                  key={item.id}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: isSelected ? "2px solid #888" : "1px solid #eee",
                    background: "#fff",
                    marginBottom: 8,
                  }}
                >
                  <button
                    onClick={() => setSelectedItemId(item.id)}
                    style={{
                      width: 34,
                      height: 30,
                      borderRadius: 10,
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
                      {formatDate(item.createdAt)}
                      {item.subtitle ? ` · ${item.subtitle}` : ""}
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
                      height: 30,
                      borderRadius: 10,
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
                      height: 30,
                      borderRadius: 10,
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
      );
    }

    return (
      <div style={{ marginBottom: 10 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px",
            marginLeft: depth * 12,
            borderRadius: 10,
            background: selectedFolderId === folder.id ? "rgba(0,0,0,0.06)" : "transparent",
            border: "1px solid #eee",
          }}
        >
          <button
            onClick={() => toggleExpand(folder.id)}
            style={{
              width: 34,
              height: 30,
              borderRadius: 10,
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
            📁 {folder.name}
          </button>

          <button
            onClick={() => startRename(folder.id, folder.name)}
            style={{
              width: 34,
              height: 30,
              borderRadius: 10,
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
              height: 30,
              borderRadius: 10,
              border: "1px solid #ddd",
              cursor: "pointer",
            }}
            title="폴더 삭제"
          >
            🗑
          </button>
        </div>

        {isExpanded && (
          <div style={{ marginTop: 8 }}>
            {folder.children.length === 0 ? (
              <div style={{ marginLeft: depth * 12 + 44, opacity: 0.6, fontSize: 13, padding: "4px 0" }}>(비어 있음)</div>
            ) : (
              folder.children.map((child) => {
                if (child.type === "folder") return <FolderTree key={child.id} folder={child} depth={depth + 1} />;

                const item = child as ItemNode;
                const isSelected = selectedItemId === item.id;

                return (
                  <div
                    key={item.id}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "center",
                      padding: "8px 10px",
                      marginLeft: (depth + 1) * 12 + 16,
                      borderRadius: 10,
                      border: isSelected ? "2px solid #888" : "1px solid #eee",
                      background: "#fff",
                      marginBottom: 8,
                    }}
                  >
                    <button
                      onClick={() => setSelectedItemId(item.id)}
                      style={{
                        width: 34,
                        height: 30,
                        borderRadius: 10,
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
                        {formatDate(item.createdAt)}
                        {item.subtitle ? ` · ${item.subtitle}` : ""}
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
                        height: 30,
                        borderRadius: 10,
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
                        height: 30,
                        borderRadius: 10,
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

  const episodeLabel = `${episodeIndex + 1}화`;

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 24 }}>
      {/* 상단 바 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 900, margin: 0 }}>Parody Translator</h1>
          <div style={{ opacity: 0.7, marginTop: 4, fontSize: 13 }}>
            자동 저장: <b>히스토리</b>에 시간순으로 쌓임 · 현재 회차: {episodeIndex + 1}/{episodes.length}
          </div>
        </div>

        <button
          onClick={() => setIsHistoryOpen(true)}
          style={{ height: 40, padding: "0 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900 }}
          title="히스토리"
        >
          🗂 히스토리
        </button>
      </div>

      {/* 작품/부제목 입력 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
        <input
          value={novelTitle}
          onChange={(e) => setNovelTitle(e.target.value)}
          placeholder="소설/시리즈 제목(큰 제목)"
          style={{ height: 42, padding: "0 12px", borderRadius: 10, border: "1px solid #ddd" }}
        />
        <input
          value={subtitle}
          onChange={(e) => setSubtitle(e.target.value)}
          placeholder="부제목(선택) — 회차 뒤에 붙음"
          style={{ height: 42, padding: "0 12px", borderRadius: 10, border: "1px solid #ddd" }}
        />
      </div>

      <div style={{ opacity: 0.75, marginBottom: 12 }}>
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

        {/* ✅ 결과: 소설 뷰어 스타일(제목+회차/부제목+본문 한 박스) */}
        <div
          style={{
            borderRadius: 12,
            border: "1px solid #ddd",
            background: "#fff",
            padding: 18,
          }}
        >
          <div style={{ fontSize: 34, fontWeight: 900, lineHeight: 1.15 }}>
            {novelTitle.trim() ? novelTitle : "제목 없음"}
          </div>

          <div style={{ marginTop: 10, fontSize: 14, opacity: 0.7 }}>
            {episodeLabel}
            {subtitle.trim() ? ` · ${subtitle.trim()}` : ""}
          </div>

          {/* 여백(클로모처럼 충분히) */}
          <div style={{ height: 28 }} />

          <div
            style={{
              whiteSpace: "pre-wrap",
              fontSize: 16,
              lineHeight: 1.9,
              minHeight: 240,
              background: "#fafafa",
              border: "1px solid #eee",
              borderRadius: 10,
              padding: 14,
            }}
          >
            {result.trim() ? result : "번역 결과가 여기 표시됩니다…"}
          </div>
        </div>

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
                <div style={{ fontSize: 18, fontWeight: 900 }}>히스토리 (자동 저장됨)</div>
                <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>
                  1) 번역하면 히스토리에 자동 저장 → 2) 폴더 만들기 → 3) 항목 선택(○) 후 “선택 폴더로 이동”
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

            {/* 폴더 이름 수정 모드 */}
            {renamingFolderId && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
                <input
                  value={renameText}
                  onChange={(e) => setRenameText(e.target.value)}
                  placeholder="폴더 이름 수정"
                  style={{ height: 38, padding: "0 10px", borderRadius: 10, border: "1px solid #ddd", minWidth: 280 }}
                />
                <button
                  onClick={applyRename}
                  style={{ height: 38, padding: "0 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900 }}
                >
                  저장
                </button>
                <button
                  onClick={() => {
                    setRenamingFolderId(null);
                    setRenameText("");
                  }}
                  style={{ height: 38, padding: "0 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900 }}
                >
                  취소
                </button>
              </div>
            )}

            {/* 트리(루트는 숨김 처리됨) */}
            <FolderTree folder={tree} depth={0} />
          </div>
        </div>
      )}
    </main>
  );
}
