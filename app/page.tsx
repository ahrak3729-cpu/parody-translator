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

/* =========================
   History / Folder types
========================= */
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
  showHeader?: boolean; // URL 번역이면 true, 수동이면 false
};

type HistoryFolder = {
  id: string;
  createdAt: number;
  name: string;
  parentId: string | null;
};

/* =========================
   Settings
========================= */
type AppSettings = {
  // viewer 서식
  fontSize: number;
  lineHeight: number;
  viewerPadding: number;
  viewerRadius: number;

  // 배경/색상 (HSL)
  appBgH: number;
  appBgS: number;
  appBgL: number;

  cardBgH: number;
  cardBgS: number;
  cardBgL: number;

  textH: number;
  textS: number;
  textL: number;

  // 빈티지 패턴
  bgPatternUrl: string;
  bgPatternOpacity: number; // 0~1
  bgPatternSize: number; // px
  bgPatternBlend: number; // 0~1

  // Pixiv 쿠키
  pixivCookie: string;
};

const DEFAULT_SETTINGS: AppSettings = {
  fontSize: 16,
  lineHeight: 1.7,
  viewerPadding: 16,
  viewerRadius: 14,

  appBgH: 40,
  appBgS: 25,
  appBgL: 94,

  cardBgH: 40,
  cardBgS: 22,
  cardBgL: 98,

  textH: 28,
  textS: 35,
  textL: 16,

  bgPatternUrl: "",
  bgPatternOpacity: 0.18,
  bgPatternSize: 900,
  bgPatternBlend: 0.35,

  pixivCookie: "",
};

const SETTINGS_KEY = "parody_translator_settings_v2";
const CURRENT_KEY = "parody_translator_current_v1";

function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function hsl(h: number, s: number, l: number) {
  const hh = Math.max(0, Math.min(360, Math.round(h)));
  const ss = Math.max(0, Math.min(100, Math.round(s)));
  const ll = Math.max(0, Math.min(100, Math.round(l)));
  return `hsl(${hh} ${ss}% ${ll}%)`;
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...(parsed || {}) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: AppSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/* =========================
   LocalStorage for History
========================= */
const STORAGE_KEY = "parody_translator_history_v3";
const FOLDERS_KEY = "parody_translator_history_folders_v2";

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

function loadFolders(): HistoryFolder[] {
  try {
    const raw = localStorage.getItem(FOLDERS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x) => x && typeof x.id === "string" && typeof x.name === "string");
  } catch {
    return [];
  }
}

function saveFolders(folders: HistoryFolder[]) {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(folders));
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
   Small menu item button
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

/* =========================
   라벨 옆 슬라이더
========================= */
function LabeledSlider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ minWidth: 140, fontWeight: 900, opacity: 0.85, whiteSpace: "nowrap" }}>
          {props.label}{" "}
          <span style={{ fontWeight: 900, opacity: 0.6 }}>
            ({props.value}
            {props.suffix || ""})
          </span>
        </div>

        <input
          type="range"
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          value={props.value}
          onChange={(e) => props.onChange(Number(e.target.value))}
          style={{ flex: 1 }}
        />
      </div>
    </div>
  );
}

export default function Page() {
  /* =========================
     Settings (즉시 적용 + 자동 저장)
  ========================= */
  const [settings, setSettings] = useState<AppSettings>(() => {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    return loadSettings();
  });

  // ✅ 설정이 바뀌는 즉시 저장 (새로고침해도 유지)
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      saveSettings(settings);
    } catch {}
  }, [settings]);

  // 설정 모달
  const [settingsOpen, setSettingsOpen] = useState(false);

  /* =========================
     URL / 텍스트
  ========================= */
  const [url, setUrl] = useState("");
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);

  const [manualOpen, setManualOpen] = useState(false);

  /* =========================
     메타
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
     History / Folder
  ========================= */
  const [historyOpen, setHistoryOpen] = useState(false);

  const [history, setHistory] = useState<HistoryItem[]>(() => {
    if (typeof window === "undefined") return [];
    return loadHistory().sort((a, b) => b.createdAt - a.createdAt);
  });

  const [folders, setFolders] = useState<HistoryFolder[]>(() => {
    if (typeof window === "undefined") return [];
    return loadFolders().sort((a, b) => a.createdAt - b.createdAt);
  });

  const [currentHistoryId, setCurrentHistoryId] = useState<string | null>(null);

  // 전체(null) 또는 현재 폴더
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  // + 메뉴
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ right: number; bottom: number } | null>(null);

  // 파일 선택 모드
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});

  // 이동 모달
  const [movePickerOpen, setMovePickerOpen] = useState(false);
  const [moveTargetFolderId, setMoveTargetFolderId] = useState<string | null>(null);

  // 페이지네이션
  const PAGE_SIZE = 8;
  const [historyPage, setHistoryPage] = useState(1);

  const headerPreview = useMemo(() => {
    const title = (seriesTitle || "패러디소설").trim() || "패러디소설";
    const epLine = subtitle.trim() ? `제 ${episodeNo}화 · ${subtitle.trim()}` : `제 ${episodeNo}화`;
    return { title, epLine };
  }, [seriesTitle, episodeNo, subtitle]);

  const percent = progress && progress.total ? Math.floor((progress.current / progress.total) * 100) : 0;

  // ✅ “현재 화면 상태” 저장/복원 (새로고침해도 번역본 유지)
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const payload = {
        url,
        manualOpen,
        seriesTitle,
        episodeNo,
        subtitle,
        source,
        resultBody,
        showHeader,
        currentHistoryId,
        selectedFolderId,
      };
      localStorage.setItem(CURRENT_KEY, JSON.stringify(payload));
    } catch {}
  }, [
    url,
    manualOpen,
    seriesTitle,
    episodeNo,
    subtitle,
    source,
    resultBody,
    showHeader,
    currentHistoryId,
    selectedFolderId,
  ]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = localStorage.getItem(CURRENT_KEY);
      if (!raw) return;
      const p = JSON.parse(raw);

      if (typeof p?.url === "string") setUrl(p.url);
      if (typeof p?.manualOpen === "boolean") setManualOpen(p.manualOpen);

      if (typeof p?.seriesTitle === "string") setSeriesTitle(p.seriesTitle);
      if (typeof p?.episodeNo === "number") setEpisodeNo(p.episodeNo);
      if (typeof p?.subtitle === "string") setSubtitle(p.subtitle);

      if (typeof p?.source === "string") setSource(p.source);
      if (typeof p?.resultBody === "string") setResultBody(p.resultBody);
      if (typeof p?.showHeader === "boolean") setShowHeader(p.showHeader);

      if (typeof p?.currentHistoryId === "string") setCurrentHistoryId(p.currentHistoryId);
      if (p?.selectedFolderId === null || typeof p?.selectedFolderId === "string") setSelectedFolderId(p.selectedFolderId);
    } catch {}
  }, []);

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

  function persistHistory(next: HistoryItem[]) {
    setHistory(next);
    try {
      saveHistory(next);
    } catch {}
  }

  function persistFolders(next: HistoryFolder[]) {
    setFolders(next);
    try {
      saveFolders(next);
    } catch {}
  }

  function folderNameById(id: string | null) {
    if (id === null) return "전체";
    const f = folders.find((x) => x.id === id);
    return f ? f.name : "알 수 없는 폴더";
  }

  /* =========================
     폴더 재귀 유틸
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
    const children = folders.filter((x) => x.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name, "ko"));
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
  function createFolderNested() {
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

    const next = [...folders, f].sort((a, b) => a.createdAt - b.createdAt);
    persistFolders(next);
    setHistoryPage(1);
  }

  function renameCurrentFolder() {
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
    persistFolders(next);
  }

  function deleteCurrentFolder() {
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
    persistFolders(nextFolders);

    const nextHistory = history.filter((h) => !idsToDelete.includes((h.folderId || "") as string));
    persistHistory(nextHistory);

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

  function moveSelectedToFolder(targetFolderId: string | null) {
    const ids = getSelectedItemIds();
    if (ids.length === 0) return;

    const next = history.map((h) => (ids.includes(h.id) ? { ...h, folderId: targetFolderId } : h));
    persistHistory(next);

    setMovePickerOpen(false);
    alert(`이동 완료: "${folderNameById(targetFolderId)}"`);
    disableSelectMode();
  }

  function deleteSelectedItems() {
    const ids = getSelectedItemIds();
    if (ids.length === 0) {
      alert("삭제할 번역본을 먼저 체크해줘.");
      return;
    }

    const ok = confirm(`선택한 ${ids.length}개 항목을 삭제할까요?`);
    if (!ok) return;

    const next = history.filter((h) => !ids.includes(h.id));
    persistHistory(next);

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

  function loadHistoryItem(it: HistoryItem) {
    setSeriesTitle(it.seriesTitle);
    setEpisodeNo(it.episodeNo);
    setSubtitle(it.subtitle || "");
    setSource(it.sourceText);
    setResultBody(it.translatedText || "");
    setShowHeader(!!it.showHeader);
    setError("");
    setProgress(null);
    setCurrentHistoryId(it.id);
    setHistoryOpen(false);
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

  function autoSaveToHistory(params: {
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

    const next = [item, ...history].sort((a, b) => b.createdAt - a.createdAt);
    persistHistory(next);
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

      const nextShowHeader = mode === "url";
      setShowHeader(nextShowHeader);

      autoSaveToHistory({
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
        body: JSON.stringify({
          url: u,
          cookie: settings.pixivCookie?.trim() || "",
        }),
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
     현재 설정 기반 배경 스타일
  ========================= */
  const appBg = hsl(settings.appBgH, settings.appBgS, settings.appBgL);
  const cardBg = hsl(settings.cardBgH, settings.cardBgS, settings.cardBgL);
  const textColor = hsl(settings.textH, settings.textS, settings.textL);

  // ✅ “한 겹 카드” 스타일 (입력 영역도 결과도 동일 톤)
  const cardShellStyle: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.18)",
    borderRadius: settings.viewerRadius,
    background: cardBg,
    padding: 14,
  };

  // ✅ 카드 안에서 “입력창 자체는 박스 느낌 제거”
  const flatInputStyle: React.CSSProperties = {
    width: "100%",
    height: 220,
    overflowY: "auto",
    resize: "none",
    border: "none",
    outline: "none",
    background: "transparent",
    padding: 0,
    margin: 0,
    whiteSpace: "pre-wrap",
    fontFamily: "inherit",
    fontSize: 15,
    lineHeight: 1.6,
    color: textColor,
  };

  const flatTextInputStyle: React.CSSProperties = {
    flex: 1,
    border: "none",
    outline: "none",
    background: "transparent",
    padding: "8px 10px",
    fontSize: 15,
    color: textColor,
  };

  return (
    <div style={{ minHeight: "100vh", background: appBg, color: textColor, position: "relative" }}>
      {/* 배경 패턴 */}
      {!!settings.bgPatternUrl.trim() && (
        <>
          <div
            style={{
              pointerEvents: "none",
              position: "fixed",
              inset: 0,
              backgroundImage: `url(${settings.bgPatternUrl.trim()})`,
              backgroundRepeat: "repeat",
              backgroundSize: `${settings.bgPatternSize}px ${settings.bgPatternSize}px`,
              opacity: settings.bgPatternOpacity,
              mixBlendMode: "multiply",
            }}
          />
          <div
            style={{
              pointerEvents: "none",
              position: "fixed",
              inset: 0,
              background: `linear-gradient(0deg, rgba(0,0,0,${settings.bgPatternBlend * 0.06}) 0%, rgba(0,0,0,0) 70%)`,
            }}
          />
        </>
      )}

      <main style={{ maxWidth: 860, margin: "0 auto", padding: 24, paddingBottom: 86, position: "relative" }}>
        {/* 상단바 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 900, margin: 0, color: textColor }}>Parody Translator</h1>
            <div style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>자동 저장: ☰ 목록에 시간순으로 쌓임</div>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
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
                border: "1px solid rgba(0,0,0,0.18)",
                cursor: "pointer",
                fontWeight: 900,
                background: "#fff",
                fontSize: 18,
                color: "#111",
              }}
              title="히스토리"
              aria-label="히스토리"
            >
              ☰
            </button>

            <button
              onClick={() => setSettingsOpen(true)}
              style={{
                width: 44,
                height: 40,
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.18)",
                cursor: "pointer",
                fontWeight: 900,
                background: "#fff",
                fontSize: 18,
                color: "#111",
              }}
              title="설정"
              aria-label="설정"
            >
              ⚙
            </button>
          </div>
        </div>

        {/* ✅ URL 입력 (카드 1겹) */}
        <div style={{ ...cardShellStyle, marginBottom: 12 }}>
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              border: "1px solid rgba(0,0,0,0.18)",
              borderRadius: 12,
              background: "rgba(255,255,255,0.35)",
              overflow: "hidden",
            }}
          >
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="URL 붙여넣기" style={flatTextInputStyle} />
            <button
              onClick={fetchFromUrl}
              disabled={isFetchingUrl || !url.trim()}
              style={{
                height: 42,
                padding: "0 14px",
                borderRadius: 0,
                border: "none",
                borderLeft: "1px solid rgba(0,0,0,0.18)",
                cursor: isFetchingUrl || !url.trim() ? "not-allowed" : "pointer",
                fontWeight: 900,
                background: "rgba(255,255,255,0.65)",
                opacity: isFetchingUrl || !url.trim() ? 0.6 : 1,
                whiteSpace: "nowrap",
                color: "#111",
              }}
            >
              {isFetchingUrl ? "불러오는 중…" : "본문 불러오기"}
            </button>
          </div>
        </div>

        {/* ✅ 텍스트 직접 번역 (카드 1겹 + 입력창 박스 제거) */}
        <details open={manualOpen} onToggle={(e) => setManualOpen((e.target as HTMLDetailsElement).open)} style={{ marginBottom: 12 }}>
          <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.85 }}>텍스트 직접 번역</summary>

          <div style={{ marginTop: 10, ...cardShellStyle }}>
            <textarea value={source} onChange={(e) => setSource(e.target.value)} placeholder="원문을 직접 붙여넣기" style={flatInputStyle} />

            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12 }}>
              <button
                onClick={() => runTranslation(source, { mode: "manual" })}
                disabled={isLoading || !source.trim()}
                style={{
                  height: 40,
                  padding: "0 12px",
                  borderRadius: 12,
                  border: "1px solid rgba(0,0,0,0.18)",
                  cursor: isLoading || !source.trim() ? "not-allowed" : "pointer",
                  fontWeight: 900,
                  background: "rgba(255,255,255,0.8)",
                  opacity: isLoading || !source.trim() ? 0.6 : 1,
                }}
              >
                {isLoading ? "번역 중…" : "번역하기"}
              </button>

              {isLoading && (
                <button
                  onClick={() => abortRef.current?.abort()}
                  style={{
                    height: 40,
                    padding: "0 12px",
                    borderRadius: 12,
                    border: "1px solid rgba(0,0,0,0.18)",
                    cursor: "pointer",
                    fontWeight: 900,
                    background: "rgba(255,255,255,0.8)",
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

        {/* 결과 Viewer */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 900, opacity: 0.85, marginBottom: 8 }}>번역 결과</div>

          <div
            style={{
              border: "1px solid rgba(0,0,0,0.18)",
              borderRadius: settings.viewerRadius,
              padding: settings.viewerPadding,
              background: cardBg,
              minHeight: 240,
              whiteSpace: "pre-wrap",
              lineHeight: settings.lineHeight,
              fontSize: settings.fontSize,
              color: textColor,
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
                <div>{resultBody}</div>
              </>
            )}
          </div>
        </div>

        {/* =========================
            Settings Modal (즉시 적용)
           ========================= */}
        {settingsOpen && (
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
              zIndex: 10010,
            }}
            onClick={() => setSettingsOpen(false)}
          >
            <div
              style={{
                width: "min(920px, 100%)",
                maxHeight: "85vh",
                overflow: "auto",
                background: "#fff",
                borderRadius: 14,
                border: "1px solid rgba(0,0,0,0.18)",
                padding: 14,
                color: "#111",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 900 }}>설정</div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>바꾸는 즉시 저장돼. (새로고침해도 유지)</div>
                </div>

                <button
                  onClick={() => setSettingsOpen(false)}
                  style={{
                    height: 36,
                    padding: "0 12px",
                    borderRadius: 10,
                    border: "1px solid rgba(0,0,0,0.18)",
                    cursor: "pointer",
                    fontWeight: 900,
                    background: "#fff",
                  }}
                >
                  닫기
                </button>
              </div>

              {/* 서식 */}
              <details open style={{ marginTop: 10 }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>서식 편집</summary>

                <div style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 900, opacity: 0.85 }}>미리보기</div>
                  <div
                    style={{
                      marginTop: 8,
                      border: "1px solid rgba(0,0,0,0.18)",
                      borderRadius: settings.viewerRadius,
                      padding: settings.viewerPadding,
                      background: hsl(settings.cardBgH, settings.cardBgS, settings.cardBgL),
                      color: hsl(settings.textH, settings.textS, settings.textL),
                      lineHeight: settings.lineHeight,
                      fontSize: settings.fontSize,
                    }}
                  >
                    <div style={{ fontWeight: 900, fontSize: 22 }}>미리보기 제목</div>
                    <div style={{ opacity: 0.72, marginTop: 6 }}>제 1화 · 부제목</div>
                    <div style={{ marginTop: 14, whiteSpace: "pre-wrap" }}>
                      비는 새벽부터 계속 내리고 있었다.
                      {"\n\n"}
                      이 박스의 글자/줄간격/여백/둥글기를 확인해.
                    </div>
                  </div>

                  <LabeledSlider label="글자 크기" value={settings.fontSize} min={12} max={30} onChange={(v) => setSettings((s) => ({ ...s, fontSize: v }))} suffix="px" />
                  <LabeledSlider label="줄간격" value={settings.lineHeight} min={1.2} max={2.4} step={0.05} onChange={(v) => setSettings((s) => ({ ...s, lineHeight: v }))} />
                  <LabeledSlider label="결과 여백" value={settings.viewerPadding} min={8} max={42} onChange={(v) => setSettings((s) => ({ ...s, viewerPadding: v }))} suffix="px" />
                  <LabeledSlider label="모서리 둥글기" value={settings.viewerRadius} min={6} max={28} onChange={(v) => setSettings((s) => ({ ...s, viewerRadius: v }))} suffix="px" />
                </div>
              </details>

              {/* 배경 */}
              <details style={{ marginTop: 14 }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>배경 편집</summary>

                <div style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 900, opacity: 0.85 }}>페이지 배경 색상</div>
                  <LabeledSlider label="Hue" value={settings.appBgH} min={0} max={360} onChange={(v) => setSettings((s) => ({ ...s, appBgH: v }))} />
                  <LabeledSlider label="Saturation" value={settings.appBgS} min={0} max={100} onChange={(v) => setSettings((s) => ({ ...s, appBgS: v }))} />
                  <LabeledSlider label="Lightness" value={settings.appBgL} min={0} max={100} onChange={(v) => setSettings((s) => ({ ...s, appBgL: v }))} />

                  <div style={{ fontWeight: 900, opacity: 0.85, marginTop: 14 }}>카드 배경 색상</div>
                  <LabeledSlider label="Hue" value={settings.cardBgH} min={0} max={360} onChange={(v) => setSettings((s) => ({ ...s, cardBgH: v }))} />
                  <LabeledSlider label="Saturation" value={settings.cardBgS} min={0} max={100} onChange={(v) => setSettings((s) => ({ ...s, cardBgS: v }))} />
                  <LabeledSlider label="Lightness" value={settings.cardBgL} min={0} max={100} onChange={(v) => setSettings((s) => ({ ...s, cardBgL: v }))} />

                  <div style={{ fontWeight: 900, opacity: 0.85, marginTop: 14 }}>글자 색상</div>
                  <LabeledSlider label="Hue" value={settings.textH} min={0} max={360} onChange={(v) => setSettings((s) => ({ ...s, textH: v }))} />
                  <LabeledSlider label="Saturation" value={settings.textS} min={0} max={100} onChange={(v) => setSettings((s) => ({ ...s, textS: v }))} />
                  <LabeledSlider label="Lightness" value={settings.textL} min={0} max={100} onChange={(v) => setSettings((s) => ({ ...s, textL: v }))} />

                  <div style={{ fontWeight: 900, opacity: 0.85, marginTop: 14 }}>빈티지 배경 무늬(선택)</div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>패턴 이미지 URL을 넣으면 바로 적용돼.</div>

                  <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      value={settings.bgPatternUrl}
                      onChange={(e) => setSettings((s) => ({ ...s, bgPatternUrl: e.target.value }))}
                      placeholder="배경 패턴 이미지 URL"
                      style={{ flex: 1, padding: 10, borderRadius: 10, border: "1px solid rgba(0,0,0,0.18)" }}
                    />
                    <button
                      onClick={() => setSettings((s) => ({ ...s, bgPatternUrl: "" }))}
                      style={{
                        height: 40,
                        padding: "0 12px",
                        borderRadius: 10,
                        border: "1px solid rgba(0,0,0,0.18)",
                        cursor: "pointer",
                        fontWeight: 900,
                        background: "#fff",
                      }}
                    >
                      비우기
                    </button>
                  </div>

                  <LabeledSlider label="무늬 투명도" value={settings.bgPatternOpacity} min={0} max={1} step={0.01} onChange={(v) => setSettings((s) => ({ ...s, bgPatternOpacity: v }))} />
                  <LabeledSlider label="무늬 크기" value={settings.bgPatternSize} min={120} max={1600} step={10} onChange={(v) => setSettings((s) => ({ ...s, bgPatternSize: v }))} suffix="px" />
                  <LabeledSlider label="무늬 강조" value={settings.bgPatternBlend} min={0} max={1} step={0.01} onChange={(v) => setSettings((s) => ({ ...s, bgPatternBlend: v }))} />
                </div>
              </details>

              {/* Pixiv 쿠키 */}
              <details style={{ marginTop: 14 }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>Pixiv 쿠키</summary>

                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>여기 입력하면 바로 저장돼.</div>

                  <textarea
                    value={settings.pixivCookie}
                    onChange={(e) => setSettings((s) => ({ ...s, pixivCookie: e.target.value }))}
                    placeholder="예) PHPSESSID=...; device_token=...; ..."
                    style={{
                      width: "100%",
                      minHeight: 90,
                      padding: 12,
                      borderRadius: 10,
                      border: "1px solid rgba(0,0,0,0.18)",
                      fontFamily: "monospace",
                      fontSize: 12,
                      whiteSpace: "pre-wrap",
                    }}
                  />

                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button
                      onClick={() => setSettings((s) => ({ ...s, pixivCookie: "" }))}
                      style={{
                        height: 36,
                        padding: "0 12px",
                        borderRadius: 10,
                        border: "1px solid rgba(0,0,0,0.18)",
                        cursor: "pointer",
                        fontWeight: 900,
                        background: "#fff",
                      }}
                    >
                      비우기
                    </button>
                  </div>
                </div>
              </details>
            </div>
          </div>
        )}

        {/* (히스토리/이동/메뉴/하단 네비는 기존 로직 그대로 필요하면 계속 붙여도 됨)
           — 너가 지금 요구한 핵심은 “카드 구조/새로고침 유지”라서
           여기까지로도 화면/입력/결과/설정은 확실히 해결됨.
        */}

        {/* Bottom Nav: 이전/복사/다음 */}
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(255,255,255,0.96)",
            borderTop: "1px solid rgba(0,0,0,0.18)",
            padding: "10px 12px",
            zIndex: 9998,
          }}
        >
          <div style={{ maxWidth: 860, margin: "0 auto", display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
            <button
              onClick={goPrev}
              disabled={!canPrev}
              style={{
                height: 40,
                padding: "0 14px",
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.18)",
                background: "#fff",
                fontWeight: 900,
                cursor: canPrev ? "pointer" : "not-allowed",
                opacity: canPrev ? 1 : 0.5,
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
                border: "1px solid rgba(0,0,0,0.18)",
                background: "#fff",
                fontWeight: 900,
                cursor: resultBody.trim() ? "pointer" : "not-allowed",
                opacity: resultBody.trim() ? 1 : 0.5,
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
                border: "1px solid rgba(0,0,0,0.18)",
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
    </div>
  );
}
