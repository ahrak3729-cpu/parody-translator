"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

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
  translatedText: string; // 본문만 저장
  url?: string;

  folderId?: string | null;
  showHeader?: boolean; // 저장 당시 보여줬는지
};

type HistoryFolder = {
  id: string;
  createdAt: number;
  name: string;
  parentId: string | null;
};

type AppSettings = {
  // Viewer
  fontSize: number; // px
  lineHeight: number; // CSS number
  containerMaxWidth: number; // px

  // Header rules
  showHeaderForUrl: boolean;
  showHeaderForManual: boolean;

  // Theme
  theme: "light" | "dark";
};

const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 16,
  lineHeight: 1.7,
  containerMaxWidth: 860,

  showHeaderForUrl: true,
  showHeaderForManual: false,

  theme: "light",
};

function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw, __notJson: true, __contentType: contentType };
  }
}

/* =========================
   IndexedDB (영구 저장)
========================= */
const DB_NAME = "parody_translator_db";
const DB_VERSION = 2;
const STORE_HISTORY = "history";
const STORE_FOLDERS = "folders";
const STORE_SETTINGS = "settings";
const SETTINGS_KEY = "app_settings_singleton";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        db.createObjectStore(STORE_HISTORY, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
        db.createObjectStore(STORE_FOLDERS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result || []) as T[]);
    req.onerror = () => reject(req.error);
  });
}

async function dbReplaceAll<T extends { id: string }>(storeName: string, items: T[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);

    const clearReq = store.clear();
    clearReq.onerror = () => reject(clearReq.error);

    clearReq.onsuccess = () => {
      for (const it of items) store.put(it);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    };
  });
}

async function dbGetSettings(): Promise<AppSettings | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SETTINGS, "readonly");
    const store = tx.objectStore(STORE_SETTINGS);
    const req = store.get(SETTINGS_KEY);
    req.onsuccess = () => resolve((req.result?.value as AppSettings) ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function dbSaveSettings(value: AppSettings): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SETTINGS, "readwrite");
    const store = tx.objectStore(STORE_SETTINGS);
    store.put({ key: SETTINGS_KEY, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* =========================
   작은 메뉴 버튼
========================= */
function MenuButton(props: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      style={{
        width: "100%",
        textAlign: "left",
        padding: "10px 10px",
        borderRadius: 12,
        border: "1px solid #eee",
        background: "#fff",
        cursor: props.disabled ? "not-allowed" : "pointer",
        fontWeight: 900,
        opacity: props.disabled ? 0.5 : 1,
        marginTop: 6,
      }}
    >
      {props.label}
    </button>
  );
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

export default function Page() {
  /* =========================
     Settings
  ========================= */
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);

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
     메타(기본값)
  ========================= */
  const [seriesTitle, setSeriesTitle] = useState("패러디소설");
  const [episodeNo, setEpisodeNo] = useState(1);
  const [subtitle, setSubtitle] = useState("");

  /* =========================
     원문 / 결과
  ========================= */
  const [source, setSource] = useState("");
  const [resultBody, setResultBody] = useState("");
  const [showHeader, setShowHeader] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<Progress>(null);

  const abortRef = useRef<AbortController | null>(null);

  /* =========================
     History / 폴더
  ========================= */
  const [historyOpen, setHistoryOpen] = useState(false);

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [folders, setFolders] = useState<HistoryFolder[]>([]);

  const [currentHistoryId, setCurrentHistoryId] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  // + 메뉴 팝업
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ right: number; bottom: number } | null>(null);

  // 파일 선택 모드
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});

  // 이동 대상 선택 모달
  const [movePickerOpen, setMovePickerOpen] = useState(false);
  const [moveTargetFolderId, setMoveTargetFolderId] = useState<string | null>(null);

  // 페이지네이션
  const PAGE_SIZE = 8;
  const [historyPage, setHistoryPage] = useState(1);

  /* =========================
     최초 로드: IndexedDB → state
  ========================= */
  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const [h, f, s] = await Promise.all([
          dbGetAll<HistoryItem>(STORE_HISTORY),
          dbGetAll<HistoryFolder>(STORE_FOLDERS),
          dbGetSettings(),
        ]);

        if (!alive) return;

        const nextHistory = (h || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        const nextFolders = (f || []).slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
        const nextSettings = s ? { ...DEFAULT_SETTINGS, ...s } : DEFAULT_SETTINGS;

        setHistory(nextHistory);
        setFolders(nextFolders);
        setSettings(nextSettings);

        setCurrentHistoryId(nextHistory[0]?.id ?? null);
      } catch (e: any) {
        console.error(e);
        setError("저장소(IndexedDB) 로드에 실패했어요. 브라우저 설정을 확인해줘.");
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  async function updateSettings(patch: Partial<AppSettings>) {
    const next: AppSettings = { ...settings, ...patch };
    setSettings(next);
    try {
      await dbSaveSettings(next);
    } catch (e) {
      console.error(e);
      alert("설정 저장에 실패했어요. (IndexedDB 제한/차단 가능)");
    }
  }

  async function resetSettings() {
    await updateSettings(DEFAULT_SETTINGS);
  }

  const headerPreview = useMemo(() => {
    const title = (seriesTitle || "패러디소설").trim() || "패러디소설";
    const epLine = subtitle.trim() ? `제 ${episodeNo}화 · ${subtitle.trim()}` : `제 ${episodeNo}화`;
    return { title, epLine };
  }, [seriesTitle, episodeNo, subtitle]);

  const percent = progress && progress.total ? Math.floor((progress.current / progress.total) * 100) : 0;

  const currentIndex = useMemo(() => {
    if (!currentHistoryId) return -1;
    return history.findIndex((h) => h.id === currentHistoryId);
  }, [history, currentHistoryId]);

  const canPrev = currentIndex >= 0 && currentIndex < history.length - 1;
  const canNext = currentIndex > 0;

  const parentFolderId = useMemo(() => {
    if (selectedFolderId === null) return null;
    const me = folders.find((f) => f.id === selectedFolderId);
    return me?.parentId ?? null;
  }, [folders, selectedFolderId]);

  const breadcrumb = useMemo(() => {
    if (selectedFolderId === null) return ["전체"];
    const path: string[] = [];
    let cur: string | null = selectedFolderId;
    while (cur) {
      const f = folders.find((x) => x.id === cur);
      if (!f) break;
      path.unshift(f.name);
      cur = f.parentId;
    }
    path.unshift("전체");
    return path;
  }, [folders, selectedFolderId]);

  const breadcrumbText = useMemo(() => breadcrumb.join(" ▶ "), [breadcrumb]);

  const currentSubFolders = useMemo(() => {
    const pid = selectedFolderId;
    return folders.filter((f) => f.parentId === pid);
  }, [folders, selectedFolderId]);

  const filteredHistory = useMemo(() => {
    if (selectedFolderId === null) return history;
    return history.filter((h) => (h.folderId || null) === selectedFolderId);
  }, [history, selectedFolderId]);

  const totalPages = useMemo(() => Math.max(1, Math.ceil(filteredHistory.length / PAGE_SIZE)), [filteredHistory.length]);

  const pagedHistory = useMemo(() => {
    const start = (historyPage - 1) * PAGE_SIZE;
    return filteredHistory.slice(start, start + PAGE_SIZE);
  }, [filteredHistory, historyPage]);

  const selectedCount = useMemo(() => Object.values(selectedIds).filter(Boolean).length, [selectedIds]);

  async function persistHistory(next: HistoryItem[]) {
    setHistory(next);
    try {
      await dbReplaceAll<HistoryItem>(STORE_HISTORY, next);
    } catch (e) {
      console.error(e);
      alert("히스토리 저장에 실패했어요. (IndexedDB 제한/차단 가능)");
    }
  }

  async function persistFolders(next: HistoryFolder[]) {
    setFolders(next);
    try {
      await dbReplaceAll<HistoryFolder>(STORE_FOLDERS, next);
    } catch (e) {
      console.error(e);
      alert("폴더 저장에 실패했어요. (IndexedDB 제한/차단 가능)");
    }
  }

  function folderNameById(id: string | null) {
    if (id === null) return "전체";
    const f = folders.find((x) => x.id === id);
    return f ? f.name : "알 수 없는 폴더";
  }

  /* =========================
     폴더 유틸(재귀)
  ========================= */
  function collectDescFolderIds(rootId: string): string[] {
    const result: string[] = [rootId];
    const stack: string[] = [rootId];
    while (stack.length) {
      const cur = stack.pop()!;
      const children = folders.filter((f) => f.parentId === cur);
      for (const c of children) {
        result.push(c.id);
        stack.push(c.id);
      }
    }
    return result;
  }

  function buildFolderTree(parentId: string | null, depth = 0): Array<{ f: HistoryFolder; depth: number }> {
    const children = folders
      .filter((x) => x.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name, "ko"));
    const out: Array<{ f: HistoryFolder; depth: number }> = [];
    for (const f of children) {
      out.push({ f, depth });
      out.push(...buildFolderTree(f.id, depth + 1));
    }
    return out;
  }

  /* =========================
     선택 모드
  ========================= */
  function enableSelectMode() {
    setSelectMode(true);
    setSelectedIds({});
  }

  function disableSelectMode() {
    setSelectMode(false);
    setSelectedIds({});
    setMovePickerOpen(false);
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function getSelectedItemIds(): string[] {
    return Object.entries(selectedIds)
      .filter(([, v]) => v)
      .map(([k]) => k);
  }

  /* =========================
     폴더 액션
  ========================= */
  async function createFolderNested() {
    const name = prompt("새 폴더 이름을 입력해줘");
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;

    const f: HistoryFolder = {
      id: uid(),
      createdAt: Date.now(),
      name: trimmed,
      parentId: selectedFolderId,
    };

    const next = [...folders, f].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    await persistFolders(next);
    setHistoryPage(1);
  }

  async function renameCurrentFolder() {
    if (selectedFolderId === null) {
      alert("‘전체’는 이름을 바꿀 수 없어.");
      return;
    }
    const f = folders.find((x) => x.id === selectedFolderId);
    if (!f) return;

    const nextName = prompt("폴더 이름 수정", f.name);
    if (!nextName) return;
    const trimmed = nextName.trim();
    if (!trimmed) return;

    const next = folders.map((x) => (x.id === f.id ? { ...x, name: trimmed } : x));
    await persistFolders(next);
  }

  async function deleteCurrentFolder() {
    if (selectedFolderId === null) {
      alert("‘전체’는 삭제할 수 없어.");
      return;
    }
    const f = folders.find((x) => x.id === selectedFolderId);
    if (!f) return;

    const ok = confirm(`폴더 "${f.name}" 를 삭제할까요?\n하위 폴더/그 안의 항목도 함께 삭제됩니다.`);
    if (!ok) return;

    const idsToDelete = collectDescFolderIds(f.id);

    const nextFolders = folders.filter((x) => !idsToDelete.includes(x.id));
    const nextHistory = history.filter((h) => !idsToDelete.includes((h.folderId || "") as string));

    await persistFolders(nextFolders);
    await persistHistory(nextHistory);

    setSelectedFolderId(f.parentId);
    setHistoryPage(1);
    disableSelectMode();
  }

  function goUpFolder() {
    if (selectedFolderId === null) return;
    setSelectedFolderId(parentFolderId);
    setHistoryPage(1);
    disableSelectMode();
  }

  /* =========================
     파일 이동 / 삭제
  ========================= */
  function openMovePicker() {
    const ids = getSelectedItemIds();
    if (ids.length === 0) {
      alert("옮길 번역본을 먼저 체크해줘.");
      return;
    }
    setMoveTargetFolderId(selectedFolderId);
    setMovePickerOpen(true);
  }

  async function moveSelectedToFolder(targetFolderId: string | null) {
    const ids = getSelectedItemIds();
    if (ids.length === 0) return;

    const next = history.map((h) => (ids.includes(h.id) ? { ...h, folderId: targetFolderId } : h));
    await persistHistory(next);

    setMovePickerOpen(false);
    alert(`이동 완료: "${folderNameById(targetFolderId)}"`);
    disableSelectMode();
  }

  async function deleteSelectedItems() {
    const ids = getSelectedItemIds();
    if (ids.length === 0) {
      alert("삭제할 번역본을 먼저 체크해줘.");
      return;
    }

    const ok = confirm(`선택한 ${ids.length}개 항목을 삭제할까요?`);
    if (!ok) return;

    const next = history.filter((h) => !ids.includes(h.id));
    await persistHistory(next);

    const nextFiltered = selectedFolderId === null ? next : next.filter((h) => (h.folderId || null) === selectedFolderId);
    const nextTotalPages = Math.max(1, Math.ceil(nextFiltered.length / PAGE_SIZE));
    setHistoryPage((p) => Math.min(p, nextTotalPages));

    if (currentHistoryId && ids.includes(currentHistoryId)) {
      setCurrentHistoryId(next[0]?.id ?? null);
      if (!next[0]) {
        setSource("");
        setResultBody("");
      }
    }

    disableSelectMode();
  }

  function inferHeaderForItem(it: HistoryItem) {
    return it.url ? settings.showHeaderForUrl : settings.showHeaderForManual;
  }

  function loadHistoryItem(it: HistoryItem) {
    setSeriesTitle(it.seriesTitle);
    setEpisodeNo(it.episodeNo);
    setSubtitle(it.subtitle || "");
    setSource(it.sourceText);
    setResultBody(it.translatedText || "");

    const inferred = inferHeaderForItem(it);
    setShowHeader(typeof it.showHeader === "boolean" ? it.showHeader : inferred);

    setError("");
    setProgress(null);
    setCurrentHistoryId(it.id);
    setHistoryOpen(false);
  }

  async function toggleHeaderForHistoryItem(id: string) {
    const it = history.find((x) => x.id === id);
    if (!it) return;

    const current = typeof it.showHeader === "boolean" ? it.showHeader : inferHeaderForItem(it);
    const nextValue = !current;

    const next = history.map((h) => (h.id === id ? { ...h, showHeader: nextValue } : h));
    await persistHistory(next);

    // 현재 화면에 로드된 항목이면 즉시 반영
    if (currentHistoryId === id) {
      setShowHeader(nextValue);
    }
  }

  async function handleCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      alert("복사되었습니다.");
    } catch {
      alert("복사 실패(브라우저 권한 확인)");
    }
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
      const msg = (data && ((data as any).error || (data as any).message)) || "번역 실패";
      throw new Error(String(msg));
    }
    return String((data as any)?.translated ?? "");
  }

  async function autoSaveToHistory(params: {
    sourceText: string;
    translatedBody: string;
    url?: string;
    seriesTitle: string;
    episodeNo: number;
    subtitle: string;
    showHeader: boolean;
  }) {
    const item: HistoryItem = {
      id: uid(),
      createdAt: Date.now(),
      seriesTitle: params.seriesTitle.trim() || "패러디소설",
      episodeNo: Math.max(1, Math.floor(params.episodeNo || 1)),
      subtitle: params.subtitle.trim(),
      sourceText: params.sourceText,
      translatedText: params.translatedBody,
      url: params.url?.trim() || undefined,
      folderId: selectedFolderId || null,
      showHeader: params.showHeader,
    };

    const next = [item, ...history].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    await persistHistory(next);
    setCurrentHistoryId(item.id);
    setHistoryPage(1);
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  /* =========================
     번역 실행
  ========================= */
  async function runTranslation(text: string, opts?: { mode: "manual" | "url"; sourceUrl?: string }) {
    if (!text.trim()) return;

    const mode = opts?.mode ?? "manual";

    setIsLoading(true);
    setError("");
    setResultBody("");
    setProgress(null);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const chunks = chunkText(text, 4500);
      if (chunks.length > 80) throw new Error(`너무 길어서 자동 처리 부담이 큽니다. (분할 ${chunks.length}조각)`);

      setProgress({ current: 0, total: chunks.length });

      let out = "";
      for (let i = 0; i < chunks.length; i++) {
        setProgress({ current: i, total: chunks.length });
        const t = await translateChunk(chunks[i], controller.signal);
        out += (out ? "\n\n" : "") + t.trim();
      }

      setResultBody(out);
      setProgress({ current: chunks.length, total: chunks.length });

      const nextShowHeader = mode === "url" ? settings.showHeaderForUrl : settings.showHeaderForManual;
      setShowHeader(nextShowHeader);

      await autoSaveToHistory({
        sourceText: text.trim(),
        translatedBody: out,
        url: opts?.sourceUrl,
        seriesTitle: headerPreview.title,
        episodeNo,
        subtitle,
        showHeader: nextShowHeader,
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
        const msg = data?.error || data?.message || "본문 불러오기 실패";
        throw new Error(String(msg));
      }

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
      await runTranslation(text, { mode: "url", sourceUrl: u });
    } catch (e: any) {
      setError(e?.message || "본문 불러오기 실패");
    } finally {
      setIsFetchingUrl(false);
    }
  }

  /* =========================
     + 메뉴 앵커 계산
  ========================= */
  function openMenuFromButton(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
    const right = Math.max(12, window.innerWidth - rect.right);
    const bottom = Math.max(12, window.innerHeight - rect.top);
    setMenuAnchor({ right, bottom });
    setMenuOpen(true);
  }

  /* =========================
     Theme colors
  ========================= */
  const theme = settings.theme;
  const bg = theme === "dark" ? "#0b0c10" : "#ffffff";
  const fg = theme === "dark" ? "#f2f4f8" : "#111111";
  const cardBg = theme === "dark" ? "#12141b" : "#ffffff";
  const border = theme === "dark" ? "1px solid #2a2f3a" : "1px solid #ddd";
  const subtleBorder = theme === "dark" ? "1px solid #222733" : "1px solid #eee";
  const overlay = "rgba(0,0,0,0.35)";

  /* =========================
     UI
  ========================= */
  return (
    <main
      style={{
        maxWidth: settings.containerMaxWidth,
        margin: "0 auto",
        padding: 24,
        paddingBottom: 86,
        background: bg,
        color: fg,
        minHeight: "100vh",
      }}
    >
      {/* 상단바 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 900, margin: 0 }}>Parody Translator</h1>
          <div style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>자동 저장: ☰ 목록에 시간순으로 쌓임 (영구 저장)</div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {/* 히스토리: ☰ 아이콘만 */}
          <button
            onClick={() => {
              setHistoryOpen(true);
              setHistoryPage(1);
              setMenuOpen(false);
              setMenuAnchor(null);
            }}
            style={{
              width: 44,
              height: 40,
              borderRadius: 12,
              border,
              cursor: "pointer",
              fontWeight: 900,
              background: cardBg,
              fontSize: 18,
              color: fg,
            }}
            title="히스토리"
            aria-label="히스토리"
          >
            ☰
          </button>

          {/* 설정 아이콘 */}
          <button
            onClick={() => setSettingsOpen(true)}
            style={{
              width: 44,
              height: 40,
              borderRadius: 12,
              border,
              cursor: "pointer",
              fontWeight: 900,
              background: cardBg,
              fontSize: 18,
              color: fg,
            }}
            title="설정"
            aria-label="설정"
          >
            ⚙️
          </button>
        </div>
      </div>

      {/* URL 입력 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="URL 붙여넣기"
          style={{
            flex: 1,
            padding: 10,
            borderRadius: 10,
            border,
            background: cardBg,
            color: fg,
          }}
        />
        <button
          onClick={fetchFromUrl}
          disabled={isFetchingUrl || !url.trim()}
          style={{
            height: 40,
            padding: "0 12px",
            borderRadius: 10,
            border,
            cursor: isFetchingUrl || !url.trim() ? "not-allowed" : "pointer",
            fontWeight: 900,
            background: cardBg,
            opacity: isFetchingUrl || !url.trim() ? 0.6 : 1,
            color: fg,
          }}
        >
          {isFetchingUrl ? "불러오는 중…" : "본문 불러오기"}
        </button>
      </div>

      {/* 텍스트 직접 번역 */}
      <details open={manualOpen} onToggle={(e) => setManualOpen((e.target as HTMLDetailsElement).open)} style={{ marginBottom: 12 }}>
        <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.85 }}>텍스트 직접 번역</summary>

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
              border,
              whiteSpace: "pre-wrap",
              background: cardBg,
              color: fg,
            }}
          />

          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 10 }}>
            <button
              onClick={() => runTranslation(source, { mode: "manual" })}
              disabled={isLoading || !source.trim()}
              style={{
                height: 40,
                padding: "0 12px",
                borderRadius: 10,
                border,
                cursor: isLoading || !source.trim() ? "not-allowed" : "pointer",
                fontWeight: 900,
                background: cardBg,
                opacity: isLoading || !source.trim() ? 0.6 : 1,
                color: fg,
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
                  border,
                  cursor: "pointer",
                  fontWeight: 900,
                  background: cardBg,
                  color: fg,
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

      {error && <div style={{ color: "#ff4d4f", marginTop: 8, fontWeight: 700, whiteSpace: "pre-wrap" }}>{error}</div>}

      {/* 결과 Viewer */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 900, opacity: 0.85, marginBottom: 8 }}>번역 결과</div>

        <div
          style={{
            border,
            borderRadius: 14,
            padding: 16,
            background: cardBg,
            minHeight: 240,
            whiteSpace: "pre-wrap",
            lineHeight: settings.lineHeight,
            color: fg,
          }}
        >
          {!resultBody.trim() ? (
            <div style={{ opacity: 0.55 }}>번역 결과가 여기에 표시됩니다.</div>
          ) : (
            <>
              {showHeader && (
                <>
                  <div style={{ fontSize: 28, fontWeight: 900, marginBottom: 10 }}>{headerPreview.title}</div>
                  <div style={{ fontSize: 14, opacity: 0.7, marginBottom: 28 }}>{headerPreview.epLine}</div>
                </>
              )}
              <div style={{ fontSize: settings.fontSize }}>{resultBody}</div>
            </>
          )}
        </div>
      </div>

      {/* =========================
          Settings Modal
         ========================= */}
      {settingsOpen && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: overlay,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 10002,
          }}
          onClick={() => setSettingsOpen(false)}
        >
          <div
            style={{
              width: "min(720px, 100%)",
              maxHeight: "80vh",
              overflow: "auto",
              background: cardBg,
              color: fg,
              borderRadius: 14,
              border,
              padding: 14,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <div style={{ fontSize: 18, fontWeight: 900 }}>설정</div>
              <button
                onClick={() => setSettingsOpen(false)}
                style={{ height: 36, padding: "0 12px", borderRadius: 10, border, cursor: "pointer", fontWeight: 900, background: cardBg, color: fg }}
              >
                닫기
              </button>
            </div>

            {/* Theme */}
            <div style={{ marginTop: 14, border: subtleBorder, borderRadius: 12, padding: 12 }}>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>테마</div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  onClick={() => updateSettings({ theme: "light" })}
                  style={{
                    height: 36,
                    padding: "0 12px",
                    borderRadius: 10,
                    border,
                    cursor: "pointer",
                    fontWeight: 900,
                    background: settings.theme === "light" ? "#111" : cardBg,
                    color: settings.theme === "light" ? "#fff" : fg,
                  }}
                >
                  라이트
                </button>
                <button
                  onClick={() => updateSettings({ theme: "dark" })}
                  style={{
                    height: 36,
                    padding: "0 12px",
                    borderRadius: 10,
                    border,
                    cursor: "pointer",
                    fontWeight: 900,
                    background: settings.theme === "dark" ? "#111" : cardBg,
                    color: settings.theme === "dark" ? "#fff" : fg,
                  }}
                >
                  다크
                </button>
              </div>
            </div>

            {/* Viewer */}
            <div style={{ marginTop: 12, border: subtleBorder, borderRadius: 12, padding: 12 }}>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>번역 결과 보기</div>

              <div style={{ marginTop: 10 }}>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>글자 크기: {settings.fontSize}px</div>
                <input
                  type="range"
                  min={14}
                  max={22}
                  value={settings.fontSize}
                  onChange={(e) => updateSettings({ fontSize: clamp(Number(e.target.value), 14, 22) })}
                  style={{ width: "100%" }}
                />
              </div>

              <div style={{ marginTop: 14 }}>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>줄 간격: {settings.lineHeight.toFixed(1)}</div>
                <input
                  type="range"
                  min={14}
                  max={22}
                  value={Math.round(settings.lineHeight * 10)}
                  onChange={(e) => updateSettings({ lineHeight: clamp(Number(e.target.value) / 10, 1.4, 2.2) })}
                  style={{ width: "100%" }}
                />
              </div>

              <div style={{ marginTop: 14 }}>
                <div style={{ fontWeight: 800, marginBottom: 6 }}>전체 폭: {settings.containerMaxWidth}px</div>
                <input
                  type="range"
                  min={680}
                  max={980}
                  step={10}
                  value={settings.containerMaxWidth}
                  onChange={(e) => updateSettings({ containerMaxWidth: clamp(Number(e.target.value), 680, 980) })}
                  style={{ width: "100%" }}
                />
              </div>
            </div>

            {/* Header rules */}
            <div style={{ marginTop: 12, border: subtleBorder, borderRadius: 12, padding: 12 }}>
              <div style={{ fontWeight: 900, marginBottom: 10 }}>헤더 표시 규칙</div>

              <label style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer", userSelect: "none" }}>
                <input
                  type="checkbox"
                  checked={settings.showHeaderForUrl}
                  onChange={(e) => updateSettings({ showHeaderForUrl: e.target.checked })}
                  style={{ width: 18, height: 18 }}
                />
                <span style={{ fontWeight: 800 }}>URL 번역 결과에 큰제목/회차 표시</span>
              </label>

              <div style={{ height: 10 }} />

              <label style={{ display: "flex", gap: 10, alignItems: "center", cursor: "pointer", userSelect: "none" }}>
                <input
                  type="checkbox"
                  checked={settings.showHeaderForManual}
                  onChange={(e) => updateSettings({ showHeaderForManual: e.target.checked })}
                  style={{ width: 18, height: 18 }}
                />
                <span style={{ fontWeight: 800 }}>수동 번역 결과에 큰제목/회차 표시</span>
              </label>

              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75, lineHeight: 1.5 }}>
                ※ 히스토리 항목별로는 목록의 🏷 버튼으로 개별 토글 가능.
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginTop: 14 }}>
              <button
                onClick={resetSettings}
                style={{
                  height: 38,
                  padding: "0 14px",
                  borderRadius: 10,
                  border,
                  cursor: "pointer",
                  fontWeight: 900,
                  background: cardBg,
                  color: fg,
                }}
              >
                설정 초기화
              </button>

              <button
                onClick={() => setSettingsOpen(false)}
                style={{
                  height: 38,
                  padding: "0 14px",
                  borderRadius: 10,
                  border,
                  cursor: "pointer",
                  fontWeight: 900,
                  background: "#111",
                  color: "#fff",
                }}
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

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
            background: overlay,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 9999,
          }}
          onClick={() => {
            setHistoryOpen(false);
            setMenuOpen(false);
            setMenuAnchor(null);
            disableSelectMode();
          }}
        >
          <div
            style={{
              width: "min(920px, 100%)",
              maxHeight: "85vh",
              overflow: "auto",
              background: cardBg,
              color: fg,
              borderRadius: 14,
              border,
              padding: 14,
              position: "relative",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 헤더 */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 900 }}>목록</div>

                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span>
                    현재 폴더: <b>{breadcrumbText}</b>
                  </span>

                  {selectedFolderId !== null && (
                    <button
                      onClick={renameCurrentFolder}
                      style={{
                        width: 32,
                        height: 28,
                        borderRadius: 10,
                        border,
                        background: cardBg,
                        cursor: "pointer",
                        fontWeight: 900,
                        color: fg,
                      }}
                      title="폴더 이름 수정"
                    >
                      ✏️
                    </button>
                  )}

                  {selectMode && <span style={{ fontWeight: 900 }}>· 선택 {selectedCount}개</span>}
                </div>
              </div>

              <button
                onClick={() => {
                  setHistoryOpen(false);
                  setMenuOpen(false);
                  setMenuAnchor(null);
                  disableSelectMode();
                }}
                style={{ height: 36, padding: "0 12px", borderRadius: 10, border, cursor: "pointer", fontWeight: 900, background: cardBg, color: fg }}
              >
                닫기
              </button>
            </div>

            {/* 상단: 전체/뒤로 */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
              <button
                onClick={() => {
                  setSelectedFolderId(null);
                  setHistoryPage(1);
                  disableSelectMode();
                }}
                style={{
                  height: 34,
                  padding: "0 12px",
                  borderRadius: 999,
                  border,
                  background: selectedFolderId === null ? "#111" : cardBg,
                  color: selectedFolderId === null ? "#fff" : fg,
                  cursor: "pointer",
                  fontWeight: 900,
                }}
              >
                전체
              </button>

              <button
                onClick={goUpFolder}
                disabled={selectedFolderId === null}
                style={{
                  width: 44,
                  height: 34,
                  borderRadius: 999,
                  border,
                  background: cardBg,
                  cursor: selectedFolderId === null ? "not-allowed" : "pointer",
                  fontWeight: 900,
                  opacity: selectedFolderId === null ? 0.5 : 1,
                  color: fg,
                }}
                title="상위 폴더"
              >
                ⬅
              </button>
            </div>

            {/* 서브폴더 */}
            {currentSubFolders.length > 0 && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
                {currentSubFolders
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name, "ko"))
                  .map((f) => (
                    <button
                      key={f.id}
                      onClick={() => {
                        setSelectedFolderId(f.id);
                        setHistoryPage(1);
                        disableSelectMode();
                      }}
                      style={{
                        height: 34,
                        padding: "0 12px",
                        borderRadius: 999,
                        border,
                        background: cardBg,
                        cursor: "pointer",
                        fontWeight: 900,
                        color: fg,
                      }}
                    >
                      📁 {f.name}
                    </button>
                  ))}
              </div>
            )}

            {/* 리스트 */}
            {filteredHistory.length === 0 ? (
              <div style={{ opacity: 0.65, padding: 10 }}>(이 폴더에 저장된 항목이 없어요)</div>
            ) : (
              <>
                <div style={{ display: "grid", gap: 10, paddingBottom: 62 }}>
                  {pagedHistory.map((it) => {
                    const label = `${it.seriesTitle} · ${it.episodeNo}화`;
                    const checked = !!selectedIds[it.id];

                    const effectiveHeader = typeof it.showHeader === "boolean" ? it.showHeader : inferHeaderForItem(it);

                    return (
                      <div
                        key={it.id}
                        style={{
                          border: selectMode && checked ? (theme === "dark" ? "2px solid #fff" : "2px solid #111") : subtleBorder,
                          borderRadius: 12,
                          padding: 12,
                          background: cardBg,
                          display: "flex",
                          gap: 10,
                          alignItems: "center",
                        }}
                      >
                        {selectMode && (
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleSelect(it.id)}
                            style={{ width: 18, height: 18, cursor: "pointer" }}
                            aria-label="항목 선택"
                          />
                        )}

                        <button
                          onClick={() => {
                            if (selectMode) {
                              toggleSelect(it.id);
                              return;
                            }
                            loadHistoryItem(it);
                          }}
                          style={{
                            flex: 1,
                            border: "none",
                            background: "transparent",
                            cursor: "pointer",
                            textAlign: "left",
                            color: fg,
                          }}
                          title={selectMode ? "선택/해제" : "불러오기"}
                        >
                          <div style={{ fontWeight: 900, display: "flex", gap: 8, alignItems: "center" }}>
                            <span>{label}</span>
                            <span style={{ fontSize: 12, opacity: 0.7 }}>
                              {effectiveHeader ? "· 헤더 ON" : "· 헤더 OFF"}
                            </span>
                          </div>
                          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                            {formatDate(it.createdAt)}
                            {it.url ? ` · URL 저장됨` : ""}
                          </div>
                        </button>

                        {/* ✅ 항목별 헤더 토글 */}
                        <button
                          onClick={() => toggleHeaderForHistoryItem(it.id)}
                          style={{
                            width: 46,
                            height: 34,
                            borderRadius: 10,
                            border,
                            cursor: "pointer",
                            fontWeight: 900,
                            background: cardBg,
                            color: fg,
                            opacity: 1,
                          }}
                          title="이 항목의 헤더 표시 토글"
                          aria-label="헤더 표시 토글"
                        >
                          🏷
                        </button>

                        <button
                          onClick={() => handleCopy(it.translatedText)}
                          style={{
                            width: 46,
                            height: 34,
                            borderRadius: 10,
                            border,
                            cursor: "pointer",
                            fontWeight: 900,
                            background: cardBg,
                            color: fg,
                          }}
                          title="번역본 복사"
                        >
                          📋
                        </button>
                      </div>
                    );
                  })}
                </div>

                {/* 페이지네이션 */}
                {totalPages > 1 && (
                  <div
                    style={{
                      position: "sticky",
                      bottom: 0,
                      background: cardBg,
                      paddingTop: 10,
                      paddingBottom: 10,
                      borderTop: subtleBorder,
                      display: "flex",
                      justifyContent: "center",
                      gap: 6,
                    }}
                  >
                    {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => {
                      const active = p === historyPage;
                      return (
                        <button
                          key={p}
                          onClick={() => setHistoryPage(p)}
                          style={{
                            minWidth: 34,
                            height: 32,
                            padding: "0 10px",
                            borderRadius: 10,
                            border,
                            cursor: "pointer",
                            fontWeight: 900,
                            background: active ? "#111" : cardBg,
                            color: active ? "#fff" : fg,
                          }}
                        >
                          {p}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {/* 하단 오른쪽: 선택모드 이동/삭제 + 메뉴(➕) */}
            <div style={{ position: "absolute", right: 14, bottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
              {selectMode && (
                <>
                  <button
                    onClick={openMovePicker}
                    disabled={selectedCount === 0}
                    style={{
                      height: 40,
                      padding: "0 12px",
                      borderRadius: 14,
                      border,
                      background: cardBg,
                      fontWeight: 900,
                      cursor: selectedCount > 0 ? "pointer" : "not-allowed",
                      opacity: selectedCount > 0 ? 1 : 0.5,
                      fontSize: 13,
                      color: fg,
                    }}
                    title="이동"
                  >
                    이동
                  </button>

                  <div style={{ width: 8 }} />

                  <button
                    onClick={deleteSelectedItems}
                    disabled={selectedCount === 0}
                    style={{
                      height: 40,
                      padding: "0 12px",
                      borderRadius: 14,
                      border,
                      background: cardBg,
                      fontWeight: 900,
                      cursor: selectedCount > 0 ? "pointer" : "not-allowed",
                      opacity: selectedCount > 0 ? 1 : 0.5,
                      fontSize: 13,
                      color: fg,
                    }}
                    title="삭제"
                  >
                    삭제
                  </button>
                </>
              )}

              <button
                onClick={(e) => openMenuFromButton(e)}
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 18,
                  border,
                  background: cardBg,
                  fontWeight: 900,
                  cursor: "pointer",
                  boxShadow: "0 10px 24px rgba(0,0,0,0.12)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 22,
                  color: fg,
                }}
                title="메뉴"
                aria-label="메뉴"
              >
                ➕
              </button>
            </div>
          </div>
        </div>
      )}

      {/* + 메뉴 팝업 (fixed) */}
      {historyOpen && menuOpen && menuAnchor && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 10001 }}
          onClick={() => {
            setMenuOpen(false);
            setMenuAnchor(null);
          }}
        >
          <div
            style={{
              position: "fixed",
              right: menuAnchor.right,
              bottom: menuAnchor.bottom,
              width: 220,
              background: cardBg,
              color: fg,
              border,
              borderRadius: 14,
              boxShadow: "0 18px 40px rgba(0,0,0,0.14)",
              padding: 8,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <MenuButton
              label="📁 새 폴더 만들기"
              onClick={() => {
                setMenuOpen(false);
                setMenuAnchor(null);
                createFolderNested();
              }}
            />

            <MenuButton
              label="🗑 폴더 삭제"
              disabled={selectedFolderId === null}
              onClick={() => {
                setMenuOpen(false);
                setMenuAnchor(null);
                deleteCurrentFolder();
              }}
            />

            <div style={{ height: 1, background: theme === "dark" ? "#2a2f3a" : "#eee", margin: "8px 6px" }} />

            <MenuButton
              label={selectMode ? "✅ 파일선택 종료" : "☑️ 파일선택"}
              onClick={() => {
                setMenuOpen(false);
                setMenuAnchor(null);
                if (!selectMode) enableSelectMode();
                else disableSelectMode();
              }}
            />
          </div>
        </div>
      )}

      {/* Move Picker Modal */}
      {movePickerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: overlay,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            zIndex: 10000,
          }}
          onClick={() => setMovePickerOpen(false)}
        >
          <div
            style={{
              width: "min(720px, 100%)",
              maxHeight: "80vh",
              overflow: "auto",
              background: cardBg,
              color: fg,
              borderRadius: 14,
              border,
              padding: 14,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 900 }}>어느 폴더로 옮길까?</div>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                  선택된 항목: <b>{selectedCount}개</b> · 대상 폴더: <b>{folderNameById(moveTargetFolderId)}</b>
                </div>
              </div>

              <button
                onClick={() => setMovePickerOpen(false)}
                style={{ height: 36, padding: "0 12px", borderRadius: 10, border, cursor: "pointer", fontWeight: 900, background: cardBg, color: fg }}
              >
                닫기
              </button>
            </div>

            <div style={{ border: subtleBorder, borderRadius: 12, padding: 10 }}>
              <button
                onClick={() => setMoveTargetFolderId(null)}
                style={{
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 10px",
                  borderRadius: 10,
                  border: moveTargetFolderId === null ? (theme === "dark" ? "2px solid #fff" : "2px solid #111") : border,
                  background: cardBg,
                  cursor: "pointer",
                  fontWeight: 900,
                  color: fg,
                }}
              >
                🧺 전체
              </button>

              <div style={{ height: 10 }} />

              {buildFolderTree(null, 0).map(({ f, depth }) => {
                const active = moveTargetFolderId === f.id;

                // ✅ depth에 따라 ↳ 반복 표시
                const marker = depth > 0 ? "↳ ".repeat(depth) : "";
                return (
                  <button
                    key={f.id}
                    onClick={() => setMoveTargetFolderId(f.id)}
                    style={{
                      width: "100%",
                      textAlign: "left",
                      padding: "10px 10px",
                      borderRadius: 10,
                      border: active ? (theme === "dark" ? "2px solid #fff" : "2px solid #111") : border,
                      background: cardBg,
                      cursor: "pointer",
                      fontWeight: 900,
                      marginTop: 8,
                      color: fg,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                    }}
                  >
                    <span style={{ opacity: depth > 0 ? 0.85 : 1, fontSize: 13, whiteSpace: "pre" }}>{marker}</span>
                    <span style={{ whiteSpace: "pre" }}>📁</span>
                    <span>{f.name}</span>
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginTop: 12 }}>
              <button
                onClick={() => setMovePickerOpen(false)}
                style={{
                  height: 38,
                  padding: "0 14px",
                  borderRadius: 10,
                  border,
                  cursor: "pointer",
                  fontWeight: 900,
                  background: cardBg,
                  color: fg,
                }}
              >
                취소
              </button>

              <button
                onClick={() => moveSelectedToFolder(moveTargetFolderId)}
                disabled={selectedCount === 0}
                style={{
                  height: 38,
                  padding: "0 14px",
                  borderRadius: 10,
                  border,
                  cursor: selectedCount > 0 ? "pointer" : "not-allowed",
                  fontWeight: 900,
                  background: "#111",
                  color: "#fff",
                  opacity: selectedCount > 0 ? 1 : 0.5,
                }}
              >
                이동 확정
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom Nav */}
      <div
        style={{
          position: "fixed",
          left: 0,
          right: 0,
          bottom: 0,
          background: theme === "dark" ? "rgba(18,20,27,0.96)" : "rgba(255,255,255,0.96)",
          borderTop: theme === "dark" ? "1px solid #2a2f3a" : "1px solid #ddd",
          padding: "10px 12px",
          zIndex: 9998,
        }}
      >
        <div style={{ maxWidth: settings.containerMaxWidth, margin: "0 auto", display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
          <button
            onClick={goPrev}
            disabled={!canPrev}
            style={{
              height: 40,
              padding: "0 14px",
              borderRadius: 12,
              border,
              background: cardBg,
              fontWeight: 900,
              cursor: canPrev ? "pointer" : "not-allowed",
              opacity: canPrev ? 1 : 0.5,
              color: fg,
            }}
          >
            ◀ 이전
          </button>

          <button
            onClick={() => handleCopy(resultBody || "")}
            disabled={!resultBody.trim()}
            style={{
              height: 40,
              padding: "0 14px",
              borderRadius: 12,
              border,
              background: cardBg,
              fontWeight: 900,
              cursor: resultBody.trim() ? "pointer" : "not-allowed",
              opacity: resultBody.trim() ? 1 : 0.5,
              color: fg,
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
              border,
              background: cardBg,
              fontWeight: 900,
              cursor: canNext ? "pointer" : "not-allowed",
              opacity: canNext ? 1 : 0.5,
              color: fg,
            }}
          >
            다음 ▶
          </button>
        </div>
      </div>
    </main>
  );
}
