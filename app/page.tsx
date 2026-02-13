"use client";

import React, { useMemo, useRef, useState } from "react";

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
      for (let i = 0; i < p.length; i += maxChars) chunks.push(p.slice(i, i + maxChars));
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
  showHeader?: boolean; // url 번역이면 true, 수동은 false
};

type HistoryFolder = {
  id: string;
  createdAt: number;
  name: string;
  parentId: string | null;
};

const STORAGE_KEY = "parody_translator_history_v3";
const FOLDERS_KEY = "parody_translator_history_folders_v2";

/** ✅ 설정 저장 키 */
const SETTINGS_KEY = "parody_translator_settings_v1";

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

/* =========================
   ✅ 설정(배경/서식) 모델
========================= */
type ThemePreset = "vintage" | "minimalLight" | "inkDark" | "nightReading";
type BackgroundType = "paper" | "solid" | "gradient" | "image";

type AppSettings = {
  preset: ThemePreset;
  backgroundType: BackgroundType;

  // 배경 기본
  baseColor: string; // solid/paper base
  gradientFrom: string;
  gradientTo: string;
  imageUrl: string;

  // 종이 느낌/가독성
  paperGrain: number; // 0..100
  vignette: number; // 0..100
  warmth: number; // 0..100
  overlay: number; // 0..100 (가독성 오버레이)

  // 서식(번역 결과 보기)
  fontSize: number; // px
  lineHeight: number; // 1.4~2.2
};

const DEFAULT_SETTINGS: AppSettings = {
  preset: "vintage",
  backgroundType: "paper",

  baseColor: "#F2E7D3",
  gradientFrom: "#F4E9D6",
  gradientTo: "#EAD9B8",
  imageUrl: "",

  paperGrain: 18,
  vignette: 22,
  warmth: 18,
  overlay: 10,

  fontSize: 16,
  lineHeight: 1.75,
};

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function applyPreset(p: ThemePreset): Partial<AppSettings> {
  switch (p) {
    case "vintage":
      return {
        preset: "vintage",
        backgroundType: "paper",
        baseColor: "#F2E7D3",
        gradientFrom: "#F4E9D6",
        gradientTo: "#EAD9B8",
        imageUrl: "",
        paperGrain: 18,
        vignette: 22,
        warmth: 18,
        overlay: 10,
        fontSize: 16,
        lineHeight: 1.75,
      };
    case "minimalLight":
      return {
        preset: "minimalLight",
        backgroundType: "solid",
        baseColor: "#F7F7F7",
        paperGrain: 0,
        vignette: 0,
        warmth: 0,
        overlay: 0,
        fontSize: 16,
        lineHeight: 1.75,
      };
    case "inkDark":
      return {
        preset: "inkDark",
        backgroundType: "solid",
        baseColor: "#0E0F12",
        paperGrain: 0,
        vignette: 0,
        warmth: 0,
        overlay: 16,
        fontSize: 16,
        lineHeight: 1.8,
      };
    case "nightReading":
      return {
        preset: "nightReading",
        backgroundType: "solid",
        baseColor: "#121316",
        paperGrain: 0,
        vignette: 0,
        warmth: 0,
        overlay: 18,
        fontSize: 17,
        lineHeight: 1.85,
      };
    default:
      return {};
  }
}

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;

    const s: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...parsed,
    };

    // 방어적 클램프
    s.paperGrain = clamp(Number(s.paperGrain ?? DEFAULT_SETTINGS.paperGrain), 0, 100);
    s.vignette = clamp(Number(s.vignette ?? DEFAULT_SETTINGS.vignette), 0, 100);
    s.warmth = clamp(Number(s.warmth ?? DEFAULT_SETTINGS.warmth), 0, 100);
    s.overlay = clamp(Number(s.overlay ?? DEFAULT_SETTINGS.overlay), 0, 100);
    s.fontSize = clamp(Number(s.fontSize ?? DEFAULT_SETTINGS.fontSize), 12, 28);
    s.lineHeight = clamp(Number(s.lineHeight ?? DEFAULT_SETTINGS.lineHeight), 1.3, 2.4);
    return s;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: AppSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/* =========================
   ✅ 배경 스타일 계산
========================= */
function withWarmth(colorHex: string, warmth: number) {
  // 아주 단순한 "따뜻함" 가산(완전 정확한 색공간 변환은 아님)
  // warmth 0..100 => red +, blue -
  const w = clamp(warmth, 0, 100) / 100;
  const hex = colorHex.replace("#", "").trim();
  if (hex.length !== 6) return colorHex;

  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);

  const rr = clamp(Math.round(r + 25 * w), 0, 255);
  const gg = clamp(Math.round(g + 10 * w), 0, 255);
  const bb = clamp(Math.round(b - 25 * w), 0, 255);

  const toHex = (x: number) => x.toString(16).padStart(2, "0");
  return `#${toHex(rr)}${toHex(gg)}${toHex(bb)}`;
}

function buildBackgroundCss(s: AppSettings) {
  const base = withWarmth(s.baseColor, s.warmth);

  if (s.backgroundType === "solid") {
    return { backgroundColor: base, backgroundImage: "none" as const };
  }

  if (s.backgroundType === "gradient") {
    const from = withWarmth(s.gradientFrom, s.warmth);
    const to = withWarmth(s.gradientTo, s.warmth);
    return {
      backgroundColor: from,
      backgroundImage: `linear-gradient(135deg, ${from}, ${to})`,
    };
  }

  if (s.backgroundType === "image") {
    // URL은 사용자가 넣는 그대로 (깨지면 그냥 배경색으로)
    return {
      backgroundColor: base,
      backgroundImage: s.imageUrl.trim()
        ? `linear-gradient(rgba(255,255,255,${clamp(s.overlay, 0, 100) / 300}), rgba(255,255,255,${
            clamp(s.overlay, 0, 100) / 300
          })), url("${s.imageUrl.trim()}")`
        : "none",
      backgroundSize: "cover",
      backgroundPosition: "center",
      backgroundRepeat: "no-repeat",
    };
  }

  // paper
  // paper grain: 아주 미세한 라인 패턴 2겹 + 옅은 그라데이션
  const grain = clamp(s.paperGrain, 0, 100) / 100;
  const overlay = clamp(s.overlay, 0, 100) / 100;

  const from = withWarmth(s.gradientFrom, s.warmth);
  const to = withWarmth(s.gradientTo, s.warmth);

  return {
    backgroundColor: base,
    backgroundImage: [
      `linear-gradient(135deg, ${from}, ${to})`,
      `repeating-linear-gradient(0deg, rgba(0,0,0,${0.03 * grain}), rgba(0,0,0,${0.03 * grain}) 1px, rgba(0,0,0,0) 2px, rgba(0,0,0,0) 6px)`,
      `repeating-linear-gradient(90deg, rgba(0,0,0,${0.02 * grain}), rgba(0,0,0,${0.02 * grain}) 1px, rgba(0,0,0,0) 2px, rgba(0,0,0,0) 7px)`,
      `linear-gradient(rgba(255,255,255,${0.2 + overlay * 0.25}), rgba(255,255,255,${0.2 + overlay * 0.25}))`,
    ].join(", "),
    backgroundBlendMode: "multiply, multiply, multiply, normal",
  };
}

function buildVignetteStyle(vignette: number) {
  const v = clamp(vignette, 0, 100) / 100;
  // inset shadow로 비네팅 대체
  return {
    boxShadow: v
      ? `inset 0 0 ${Math.round(240 * v)}px rgba(0,0,0,${0.30 * v})`
      : "none",
  } as React.CSSProperties;
}

/* =========================
   Page
========================= */
export default function Page() {
  /* =========================
     ✅ Settings
  ========================= */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(() => {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    return loadSettings();
  });

  function updateSettings(patch: Partial<AppSettings>) {
    setSettings((prev) => {
      const next: AppSettings = { ...prev, ...patch };
      // 클램프
      next.paperGrain = clamp(Number(next.paperGrain), 0, 100);
      next.vignette = clamp(Number(next.vignette), 0, 100);
      next.warmth = clamp(Number(next.warmth), 0, 100);
      next.overlay = clamp(Number(next.overlay), 0, 100);
      next.fontSize = clamp(Number(next.fontSize), 12, 28);
      next.lineHeight = clamp(Number(next.lineHeight), 1.3, 2.4);

      try {
        saveSettings(next);
      } catch {}
      return next;
    });
  }

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
  function createFolderNested() {
    const name = prompt("새 폴더 이름을 입력해줘");
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;

    const f: HistoryFolder = {
      id: uid(),
      createdAt: Date.now(),
      name: trimmed,
      parentId: selectedFolderId, // 현재 폴더 안에 생성
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
        throw new Error("본문을 가져왔지만 내용이 비어있어요. (Pixiv 차단/권한 문제 가능)\n텍스트 직접 붙여넣기로 먼저 확인해줘.");
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
     ✅ 배경/뷰어 스타일 적용
  ========================= */
  const bgCss = useMemo(() => buildBackgroundCss(settings), [settings]);
  const vignetteCss = useMemo(() => buildVignetteStyle(settings.vignette), [settings.vignette]);

  const isDarkBg = useMemo(() => {
    // 아주 단순한 다크 판단
    const c = settings.baseColor.replace("#", "");
    if (c.length !== 6) return false;
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luma < 80;
  }, [settings.baseColor]);

  const textColor = isDarkBg ? "#F3F3F3" : "#151515";
  const mutedColor = isDarkBg ? "rgba(243,243,243,0.65)" : "rgba(0,0,0,0.55)";

  const cardBg = isDarkBg ? "rgba(20,20,20,0.75)" : "rgba(255,255,255,0.78)";
  const cardBorder = isDarkBg ? "1px solid rgba(255,255,255,0.10)" : "1px solid rgba(0,0,0,0.10)";

  /* =========================
     UI
  ========================= */
  return (
    <div
      style={{
        minHeight: "100vh",
        position: "relative",
        ...bgCss,
      }}
    >
      {/* 비네팅 레이어 */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          ...vignetteCss,
        }}
      />

      <main style={{ maxWidth: 860, margin: "0 auto", padding: 24, paddingBottom: 86, position: "relative", color: textColor }}>
        {/* 상단바 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 900, margin: 0 }}>Parody Translator</h1>
            <div style={{ fontSize: 13, opacity: 0.85, marginTop: 6, color: mutedColor }}>
              자동 저장: ☰ 목록에 시간순으로 쌓임
            </div>
          </div>

          {/* ✅ 우측: 히스토리(☰) + 설정(⚙️) */}
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
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
                border: cardBorder,
                cursor: "pointer",
                fontWeight: 900,
                background: cardBg,
                fontSize: 18,
                color: textColor,
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
                border: cardBorder,
                cursor: "pointer",
                fontWeight: 900,
                background: cardBg,
                fontSize: 18,
                color: textColor,
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
              border: cardBorder,
              background: cardBg,
              color: textColor,
              outline: "none",
            }}
          />
          <button
            onClick={fetchFromUrl}
            disabled={isFetchingUrl || !url.trim()}
            style={{
              height: 40,
              padding: "0 12px",
              borderRadius: 10,
              border: cardBorder,
              cursor: isFetchingUrl || !url.trim() ? "not-allowed" : "pointer",
              fontWeight: 900,
              background: cardBg,
              opacity: isFetchingUrl || !url.trim() ? 0.6 : 1,
              color: textColor,
            }}
          >
            {isFetchingUrl ? "불러오는 중…" : "본문 불러오기"}
          </button>
        </div>

        {/* 텍스트 직접 번역 */}
        <details open={manualOpen} onToggle={(e) => setManualOpen((e.target as HTMLDetailsElement).open)} style={{ marginBottom: 12 }}>
          <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.92 }}>텍스트 직접 번역</summary>

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
                border: cardBorder,
                background: cardBg,
                color: textColor,
                whiteSpace: "pre-wrap",
                outline: "none",
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
                  border: cardBorder,
                  cursor: isLoading || !source.trim() ? "not-allowed" : "pointer",
                  fontWeight: 900,
                  background: cardBg,
                  opacity: isLoading || !source.trim() ? 0.6 : 1,
                  color: textColor,
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
                    border: cardBorder,
                    cursor: "pointer",
                    fontWeight: 900,
                    background: cardBg,
                    color: textColor,
                  }}
                >
                  취소
                </button>
              )}

              {progress && (
                <span style={{ fontSize: 13, opacity: 0.9, color: mutedColor }}>
                  진행 {percent}% ({progress.current}/{progress.total})
                </span>
              )}
            </div>
          </div>
        </details>

        {error && (
          <div style={{ color: "#FF4D4D", marginTop: 8, fontWeight: 700, whiteSpace: "pre-wrap" }}>
            {error}
          </div>
        )}

        {/* 결과 Viewer */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 900, opacity: 0.92, marginBottom: 8 }}>번역 결과</div>

          <div
            style={{
              border: cardBorder,
              borderRadius: 14,
              padding: 16,
              background: cardBg,
              minHeight: 240,
              whiteSpace: "pre-wrap",
              lineHeight: settings.lineHeight,
              fontSize: settings.fontSize,
              color: textColor,
            }}
          >
            {!resultBody.trim() ? (
              <div style={{ opacity: 0.8, color: mutedColor }}>번역 결과가 여기에 표시됩니다.</div>
            ) : (
              <>
                {showHeader && (
                  <>
                    <div style={{ fontSize: 28, fontWeight: 900, marginBottom: 10 }}>{headerPreview.title}</div>
                    <div style={{ fontSize: 14, opacity: 0.85, marginBottom: 28, color: mutedColor }}>{headerPreview.epLine}</div>
                  </>
                )}
                <div>{resultBody}</div>
              </>
            )}
          </div>
        </div>

        {/* =========================
            ✅ Settings Modal
           ========================= */}
        {settingsOpen && (
          <div
            role="dialog"
            aria-modal="true"
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.45)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
              zIndex: 11000,
            }}
            onClick={() => setSettingsOpen(false)}
          >
            <div
              style={{
                width: "min(920px, 100%)",
                maxHeight: "85vh",
                overflow: "auto",
                background: isDarkBg ? "#121212" : "#fff",
                borderRadius: 14,
                border: "1px solid rgba(0,0,0,0.12)",
                padding: 14,
                color: isDarkBg ? "#F3F3F3" : "#111",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 900 }}>설정</div>
                  <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>기본은 A안(빈티지 종이) · 변경사항은 즉시 미리보기로 확인</div>
                </div>

                <button
                  onClick={() => setSettingsOpen(false)}
                  style={{
                    height: 36,
                    padding: "0 12px",
                    borderRadius: 10,
                    border: "1px solid rgba(0,0,0,0.15)",
                    cursor: "pointer",
                    fontWeight: 900,
                    background: isDarkBg ? "#1C1C1C" : "#fff",
                    color: isDarkBg ? "#F3F3F3" : "#111",
                  }}
                >
                  닫기
                </button>
              </div>

              {/* ✅ 배경 편집 */}
              <details open style={{ border: "1px solid rgba(0,0,0,0.10)", borderRadius: 14, padding: 12, background: isDarkBg ? "#191919" : "#FAFAFA" }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>배경 편집</summary>

                <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
                  {/* 프리셋 */}
                  <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ fontWeight: 900, opacity: 0.85 }}>프리셋</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {[
                        { key: "vintage", label: "Vintage Paper" },
                        { key: "minimalLight", label: "Minimal Light" },
                        { key: "inkDark", label: "Ink Dark" },
                        { key: "nightReading", label: "Night Reading" },
                      ].map((p) => {
                        const active = settings.preset === (p.key as ThemePreset);
                        return (
                          <button
                            key={p.key}
                            onClick={() => {
                              const patch = applyPreset(p.key as ThemePreset);
                              updateSettings(patch);
                            }}
                            style={{
                              height: 34,
                              padding: "0 12px",
                              borderRadius: 999,
                              border: "1px solid rgba(0,0,0,0.15)",
                              cursor: "pointer",
                              fontWeight: 900,
                              background: active ? "#111" : isDarkBg ? "#222" : "#fff",
                              color: active ? "#fff" : isDarkBg ? "#F3F3F3" : "#111",
                            }}
                          >
                            {p.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 배경 타입 */}
                  <div style={{ display: "grid", gap: 8 }}>
                    <div style={{ fontWeight: 900, opacity: 0.85 }}>배경 타입</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                      {[
                        { key: "paper", label: "종이" },
                        { key: "solid", label: "단색" },
                        { key: "gradient", label: "그라데이션" },
                        { key: "image", label: "이미지(URL)" },
                      ].map((t) => {
                        const active = settings.backgroundType === (t.key as BackgroundType);
                        return (
                          <button
                            key={t.key}
                            onClick={() => updateSettings({ backgroundType: t.key as BackgroundType })}
                            style={{
                              height: 34,
                              padding: "0 12px",
                              borderRadius: 999,
                              border: "1px solid rgba(0,0,0,0.15)",
                              cursor: "pointer",
                              fontWeight: 900,
                              background: active ? "#111" : isDarkBg ? "#222" : "#fff",
                              color: active ? "#fff" : isDarkBg ? "#F3F3F3" : "#111",
                            }}
                          >
                            {t.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 컬러/URL */}
                  <div style={{ display: "grid", gap: 10 }}>
                    {(settings.backgroundType === "solid" || settings.backgroundType === "paper") && (
                      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                        <div style={{ width: 120, fontWeight: 900, opacity: 0.85 }}>바탕색</div>
                        <input
                          type="color"
                          value={settings.baseColor}
                          onChange={(e) => updateSettings({ baseColor: e.target.value })}
                          style={{ width: 48, height: 34, border: "none", background: "transparent" }}
                        />
                        <input
                          value={settings.baseColor}
                          onChange={(e) => updateSettings({ baseColor: e.target.value })}
                          style={{
                            padding: "8px 10px",
                            borderRadius: 10,
                            border: "1px solid rgba(0,0,0,0.15)",
                            width: 140,
                            background: isDarkBg ? "#101010" : "#fff",
                            color: isDarkBg ? "#F3F3F3" : "#111",
                            outline: "none",
                          }}
                        />
                      </div>
                    )}

                    {settings.backgroundType === "gradient" && (
                      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                        <div style={{ width: 120, fontWeight: 900, opacity: 0.85 }}>그라데이션</div>

                        <input
                          type="color"
                          value={settings.gradientFrom}
                          onChange={(e) => updateSettings({ gradientFrom: e.target.value })}
                          style={{ width: 48, height: 34, border: "none", background: "transparent" }}
                        />
                        <input
                          type="color"
                          value={settings.gradientTo}
                          onChange={(e) => updateSettings({ gradientTo: e.target.value })}
                          style={{ width: 48, height: 34, border: "none", background: "transparent" }}
                        />
                      </div>
                    )}

                    {settings.backgroundType === "image" && (
                      <div style={{ display: "grid", gap: 8 }}>
                        <div style={{ fontWeight: 900, opacity: 0.85 }}>배경 이미지 URL</div>
                        <input
                          value={settings.imageUrl}
                          onChange={(e) => updateSettings({ imageUrl: e.target.value })}
                          placeholder='예) https://.../paper.jpg'
                          style={{
                            width: "100%",
                            padding: "10px 12px",
                            borderRadius: 10,
                            border: "1px solid rgba(0,0,0,0.15)",
                            background: isDarkBg ? "#101010" : "#fff",
                            color: isDarkBg ? "#F3F3F3" : "#111",
                            outline: "none",
                          }}
                        />
                        <div style={{ fontSize: 12, opacity: 0.75 }}>
                          참고: 사이트가 CORS/403을 걸면 이미지가 안 뜰 수 있어. 그때는 다른 이미지 주소를 쓰거나 종이/단색으로 바꿔줘.
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 종이 느낌/가독성 */}
                  <div style={{ display: "grid", gap: 10 }}>
                    <div style={{ fontWeight: 900, opacity: 0.85 }}>종이 느낌 / 가독성</div>

                    <div style={{ display: "grid", gap: 10 }}>
                      <label style={{ display: "grid", gap: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontWeight: 900, opacity: 0.8 }}>종이결</span>
                          <span style={{ fontSize: 12, opacity: 0.75 }}>{settings.paperGrain}</span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={settings.paperGrain}
                          onChange={(e) => updateSettings({ paperGrain: Number(e.target.value) })}
                        />
                      </label>

                      <label style={{ display: "grid", gap: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontWeight: 900, opacity: 0.8 }}>비네팅</span>
                          <span style={{ fontSize: 12, opacity: 0.75 }}>{settings.vignette}</span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={settings.vignette}
                          onChange={(e) => updateSettings({ vignette: Number(e.target.value) })}
                        />
                      </label>

                      <label style={{ display: "grid", gap: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontWeight: 900, opacity: 0.8 }}>따뜻함(세피아)</span>
                          <span style={{ fontSize: 12, opacity: 0.75 }}>{settings.warmth}</span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={settings.warmth}
                          onChange={(e) => updateSettings({ warmth: Number(e.target.value) })}
                        />
                      </label>

                      <label style={{ display: "grid", gap: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontWeight: 900, opacity: 0.8 }}>가독성 오버레이</span>
                          <span style={{ fontSize: 12, opacity: 0.75 }}>{settings.overlay}</span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={100}
                          value={settings.overlay}
                          onChange={(e) => updateSettings({ overlay: Number(e.target.value) })}
                        />
                      </label>
                    </div>
                  </div>
                </div>
              </details>

              {/* ✅ 서식 편집 (기본 접힘) */}
              <details style={{ marginTop: 12, border: "1px solid rgba(0,0,0,0.10)", borderRadius: 14, padding: 12, background: isDarkBg ? "#191919" : "#FAFAFA" }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>서식 편집</summary>

                <div style={{ marginTop: 12, display: "grid", gap: 10 }}>
                  <label style={{ display: "grid", gap: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontWeight: 900, opacity: 0.8 }}>글자 크기</span>
                      <span style={{ fontSize: 12, opacity: 0.75 }}>{settings.fontSize}px</span>
                    </div>
                    <input
                      type="range"
                      min={12}
                      max={28}
                      value={settings.fontSize}
                      onChange={(e) => updateSettings({ fontSize: Number(e.target.value) })}
                    />
                  </label>

                  <label style={{ display: "grid", gap: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontWeight: 900, opacity: 0.8 }}>줄간격</span>
                      <span style={{ fontSize: 12, opacity: 0.75 }}>{settings.lineHeight.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min={1.3}
                      max={2.4}
                      step={0.01}
                      value={settings.lineHeight}
                      onChange={(e) => updateSettings({ lineHeight: Number(e.target.value) })}
                    />
                  </label>
                </div>
              </details>

              {/* ✅ 미리보기 */}
              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 900, opacity: 0.85, marginBottom: 8 }}>미리보기</div>

                <div
                  style={{
                    border: "1px solid rgba(0,0,0,0.10)",
                    borderRadius: 14,
                    padding: 12,
                    background: "rgba(255,255,255,0.35)",
                  }}
                >
                  <div
                    style={{
                      border: cardBorder,
                      borderRadius: 14,
                      padding: 16,
                      background: cardBg,
                      lineHeight: settings.lineHeight,
                      fontSize: settings.fontSize,
                      color: textColor,
                    }}
                  >
                    <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 8 }}>패러디 소설 제목</div>
                    <div style={{ fontSize: 13, opacity: 0.85, marginBottom: 18, color: mutedColor }}>제 1화 · 부제목 예시</div>
                    <div style={{ opacity: 0.95 }}>
                      이건 미리보기 문장이다. 줄간격/글자크기/배경을 바꾸면 여기서 바로 느낌이 보여야 한다.
                      <br />
                      <br />
                      그리고 실제 번역 결과 뷰어에도 동시에 반영된다.
                    </div>
                  </div>
                </div>
              </div>

              {/* ✅ 앞으로 기능 더 붙일 자리(기본 접힘) */}
              <details style={{ marginTop: 12, border: "1px solid rgba(0,0,0,0.10)", borderRadius: 14, padding: 12, background: isDarkBg ? "#191919" : "#FAFAFA" }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>기타(추가 기능)</summary>
                <div style={{ marginTop: 10, fontSize: 13, opacity: 0.8 }}>
                  여기에는 나중에 “쿠키 입력”, “Pixiv 전용 옵션”, “내보내기 포맷”, “단축키” 같은 기능들을 접어서 추가할 수 있어.
                </div>
              </details>
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
              background: "rgba(0,0,0,0.35)",
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
                background: "#fff",
                borderRadius: 14,
                border: "1px solid #ddd",
                padding: 14,
                position: "relative",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* 헤더 */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 900 }}>목록</div>

                  {/* 상태줄 */}
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
                          border: "1px solid #ddd",
                          background: "#fff",
                          cursor: "pointer",
                          fontWeight: 900,
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
                  style={{ height: 36, padding: "0 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900, background: "#fff" }}
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
                    border: "1px solid #ddd",
                    background: selectedFolderId === null ? "#111" : "#fff",
                    color: selectedFolderId === null ? "#fff" : "#111",
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
                    border: "1px solid #ddd",
                    background: "#fff",
                    cursor: selectedFolderId === null ? "not-allowed" : "pointer",
                    fontWeight: 900,
                    opacity: selectedFolderId === null ? 0.5 : 1,
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
                          border: "1px solid #ddd",
                          background: "#fff",
                          cursor: "pointer",
                          fontWeight: 900,
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

                      return (
                        <div
                          key={it.id}
                          style={{
                            border: selectMode && checked ? "2px solid #111" : "1px solid #eee",
                            borderRadius: 12,
                            padding: 12,
                            background: "#fff",
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
                            }}
                            title={selectMode ? "선택/해제" : "불러오기"}
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
                        background: "#fff",
                        paddingTop: 10,
                        paddingBottom: 10,
                        borderTop: "1px solid #eee",
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
                              border: "1px solid #ddd",
                              cursor: "pointer",
                              fontWeight: 900,
                              background: active ? "#111" : "#fff",
                              color: active ? "#fff" : "#111",
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

              {/* 하단 오른쪽: 선택모드 이동/삭제 + + */}
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
                        border: "1px solid #ddd",
                        background: "#fff",
                        fontWeight: 900,
                        cursor: selectedCount > 0 ? "pointer" : "not-allowed",
                        opacity: selectedCount > 0 ? 1 : 0.5,
                        fontSize: 13,
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
                        border: "1px solid #ddd",
                        background: "#fff",
                        fontWeight: 900,
                        cursor: selectedCount > 0 ? "pointer" : "not-allowed",
                        opacity: selectedCount > 0 ? 1 : 0.5,
                        fontSize: 13,
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
                    border: "1px solid #ddd",
                    background: "#fff",
                    fontWeight: 900,
                    cursor: "pointer",
                    boxShadow: "0 10px 24px rgba(0,0,0,0.12)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 22,
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
                background: "#fff",
                border: "1px solid #ddd",
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

              <div style={{ height: 1, background: "#eee", margin: "8px 6px" }} />

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
              background: "rgba(0,0,0,0.35)",
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
                background: "#fff",
                borderRadius: 14,
                border: "1px solid #ddd",
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

              <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 10 }}>
                <button
                  onClick={() => setMoveTargetFolderId(null)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 10px",
                    borderRadius: 10,
                    border: moveTargetFolderId === null ? "2px solid #111" : "1px solid #ddd",
                    background: "#fff",
                    cursor: "pointer",
                    fontWeight: 900,
                  }}
                >
                  🧺 전체
                </button>

                <div style={{ height: 10 }} />

                {buildFolderTree(null, 0).map(({ f, depth }) => {
                  const active = moveTargetFolderId === f.id;
                  return (
                    <button
                      key={f.id}
                      onClick={() => setMoveTargetFolderId(f.id)}
                      style={{
                        width: "100%",
                        textAlign: "left",
                        padding: "10px 10px",
                        borderRadius: 10,
                        border: active ? "2px solid #111" : "1px solid #ddd",
                        background: "#fff",
                        cursor: "pointer",
                        fontWeight: 900,
                        marginTop: 8,
                      }}
                    >
                      <span style={{ display: "inline-block", width: depth * 14 }} />
                      📁 {f.name}
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
                    border: "1px solid #ddd",
                    cursor: "pointer",
                    fontWeight: 900,
                    background: "#fff",
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
                    border: "1px solid #ddd",
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

        {/* Bottom Nav: 이전/복사/다음 */}
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            background: cardBg,
            borderTop: cardBorder,
            padding: "10px 12px",
            zIndex: 9998,
            backdropFilter: "blur(8px)",
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
                border: cardBorder,
                background: cardBg,
                fontWeight: 900,
                cursor: canPrev ? "pointer" : "not-allowed",
                opacity: canPrev ? 1 : 0.5,
                color: textColor,
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
                border: cardBorder,
                background: cardBg,
                fontWeight: 900,
                cursor: resultBody.trim() ? "pointer" : "not-allowed",
                opacity: resultBody.trim() ? 1 : 0.5,
                color: textColor,
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
                border: cardBorder,
                background: cardBg,
                fontWeight: 900,
                cursor: canNext ? "pointer" : "not-allowed",
                opacity: canNext ? 1 : 0.5,
                color: textColor,
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
