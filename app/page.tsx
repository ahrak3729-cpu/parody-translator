"use client";

import React, { useMemo, useRef, useState } from "react";

/* =========================
   Utils: chunking (긴 글 대응)
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
  showHeader?: boolean; // url 번역이면 true, 수동은 false (설정 UI는 없음)
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
type ViewerSettings = {
  // 서식(번역 결과보기 > 서식 편집)
  fontSize: number;      // px
  lineHeight: number;    // 배수
  viewerPadding: number; // px
  viewerRadius: number;  // px

  // 배경(페이지 전체 / 결과 카드)
  appBgH: number;
  appBgS: number;
  appBgL: number;
  cardBgH: number;
  cardBgS: number;
  cardBgL: number;

  // 글자 색
  textH: number;
  textS: number;
  textL: number;

  // 빈티지 무늬(배경 이미지)
  bgPatternUrl: string;      // 배경 이미지 URL
  bgPatternOpacity: number;  // 0~1
  bgPatternSize: number;     // px (tile size)
  bgPatternBlend: number;    // 0~1 (overlay 강도)

  // Pixiv 쿠키 (저장만)
  pixivCookie: string;
};

const DEFAULT_SETTINGS: ViewerSettings = {
  fontSize: 16,
  lineHeight: 1.75,
  viewerPadding: 16,
  viewerRadius: 14,

  // A안 기본(따뜻한 종이+고급스러운 느낌)
  // 페이지 배경: 아주 옅은 베이지(채도 낮게)
  appBgH: 40,
  appBgS: 25,
  appBgL: 94,

  // 결과 카드 배경: 종이보다 살짝 진한 크림
  cardBgH: 40,
  cardBgS: 22,
  cardBgL: 98,

  // 텍스트: 짙은 다크브라운
  textH: 25,
  textS: 18,
  textL: 18,

  // 빈티지 패턴(기본은 비움 — 사용자가 URL 넣으면 적용)
  bgPatternUrl: "",
  bgPatternOpacity: 0.18,
  bgPatternSize: 520,
  bgPatternBlend: 0.55,

  pixivCookie: "",
};

const STORAGE_KEY = "parody_translator_history_v3";
const FOLDERS_KEY = "parody_translator_history_folders_v2";
const SETTINGS_KEY = "parody_translator_viewer_settings_v1";

function uid() {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
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

/* =========================
   Storage helpers
========================= */
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

/* =========================
   Settings load/save (빌드 에러 방지 핵심)
========================= */
function loadSettings(): ViewerSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;

    // ✅ 핵심: out의 타입을 명확히 고정해서 never 추론 방지
    const out: ViewerSettings = {
      ...DEFAULT_SETTINGS,
      ...(parsed as Partial<ViewerSettings>),
    };

    // 값 범위 안전장치
    out.fontSize = clamp(out.fontSize, 12, 30);
    out.lineHeight = clamp(out.lineHeight, 1.2, 2.4);
    out.viewerPadding = clamp(out.viewerPadding, 8, 42);
    out.viewerRadius = clamp(out.viewerRadius, 6, 28);

    out.appBgH = clamp(out.appBgH, 0, 360);
    out.appBgS = clamp(out.appBgS, 0, 100);
    out.appBgL = clamp(out.appBgL, 0, 100);

    out.cardBgH = clamp(out.cardBgH, 0, 360);
    out.cardBgS = clamp(out.cardBgS, 0, 100);
    out.cardBgL = clamp(out.cardBgL, 0, 100);

    out.textH = clamp(out.textH, 0, 360);
    out.textS = clamp(out.textS, 0, 100);
    out.textL = clamp(out.textL, 0, 100);

    out.bgPatternOpacity = clamp(out.bgPatternOpacity, 0, 1);
    out.bgPatternSize = clamp(out.bgPatternSize, 120, 1600);
    out.bgPatternBlend = clamp(out.bgPatternBlend, 0, 1);

    out.bgPatternUrl = String(out.bgPatternUrl ?? "");
    out.pixivCookie = String(out.pixivCookie ?? "");

    return out;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: ViewerSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/* =========================
   Safe JSON read
========================= */
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
   Small UI components
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
    <div style={{ marginTop: 10 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <div style={{ fontWeight: 900, opacity: 0.85 }}>
          {props.label}{" "}
          <span style={{ fontWeight: 900, opacity: 0.6 }}>
            ({props.value}
            {props.suffix || ""})
          </span>
        </div>
      </div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ width: "100%", marginTop: 6 }}
      />
    </div>
  );
}

function hsl(h: number, s: number, l: number) {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
}

/* =========================
   Page
========================= */
export default function Page() {
  /* URL 중심 */
  const [url, setUrl] = useState("");
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);

  /* 텍스트 직접 번역: 접기/펴기 */
  const [manualOpen, setManualOpen] = useState(false);

  /* 메타(기본값) */
  const [seriesTitle, setSeriesTitle] = useState("패러디소설");
  const [episodeNo, setEpisodeNo] = useState(1);
  const [subtitle, setSubtitle] = useState("");

  /* 원문 / 결과 */
  const [source, setSource] = useState("");
  const [resultBody, setResultBody] = useState("");
  const [showHeader, setShowHeader] = useState(false); // UI에선 숨김(규칙은 내부)
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState<Progress>(null);

  const abortRef = useRef<AbortController | null>(null);

  /* History / 폴더 */
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
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  /* + 메뉴 팝업 */
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ right: number; bottom: number } | null>(null);

  /* 파일 선택 모드 */
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});

  /* 이동 모달 */
  const [movePickerOpen, setMovePickerOpen] = useState(false);
  const [moveTargetFolderId, setMoveTargetFolderId] = useState<string | null>(null);

  /* 페이지네이션 */
  const PAGE_SIZE = 8;
  const [historyPage, setHistoryPage] = useState(1);

  /* Settings */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<ViewerSettings>(() => {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    return loadSettings();
  });
  const [draftSettings, setDraftSettings] = useState<ViewerSettings>(settings);
  const [settingsDirty, setSettingsDirty] = useState(false);

  /* header preview */
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

  /* folder recursion */
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

  /* select mode */
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
    return Object.entries(selectedIds).filter(([, v]) => v).map(([k]) => k);
  }

  /* folder actions */
  function createFolderNested() {
    const name = prompt("새 폴더 이름을 입력해줘");
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;

    const f: HistoryFolder = {
      id: uid(),
      createdAt: Date.now(),
      name: trimmed,
      parentId: selectedFolderId, // ✅ 현재 폴더 안에 생성
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

  /* move / delete items */
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

  /* translate API */
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

  /* run translation */
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

      // ✅ 헤더 표시 규칙은 "설정"이 아니라 내부 규칙(수동 false / URL true)
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

  /* URL -> extract */
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
          "본문을 JSON으로 받지 못했어요. Pixiv는 로그인/봇 차단 때문에 서버에서 본문 추출이 실패할 수 있어요.\n(텍스트 직접 붙여넣기로 먼저 확인해줘)"
        );
      }

      if (data?.title) setSeriesTitle(String(data.title));
      const text = String(data?.text ?? "");
      if (!text.trim()) {
        throw new Error("본문을 가져왔지만 내용이 비어있어요. (Pixiv 차단/권한 문제 가능)\n텍스트 직접 붙여넣기로 확인해줘.");
      }

      setSource(text);
      await runTranslation(text, { mode: "url", sourceUrl: u });
    } catch (e: any) {
      setError(e?.message || "본문 불러오기 실패");
    } finally {
      setIsFetchingUrl(false);
    }
  }

  /* + 메뉴 anchor */
  function openMenuFromButton(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
    const right = Math.max(12, window.innerWidth - rect.right);
    const bottom = Math.max(12, window.innerHeight - rect.top);
    setMenuAnchor({ right, bottom });
    setMenuOpen(true);
  }

  /* Settings helpers */
  function openSettings() {
    setDraftSettings(settings);
    setSettingsDirty(false);
    setSettingsOpen(true);
  }

  function updateDraft(patch: Partial<ViewerSettings>) {
    setDraftSettings((prev) => {
      const next = { ...prev, ...patch };
      return next;
    });
    setSettingsDirty(true);
  }

  function saveDraft() {
    const safe: ViewerSettings = {
      ...DEFAULT_SETTINGS,
      ...draftSettings,
      fontSize: clamp(draftSettings.fontSize, 12, 30),
      lineHeight: clamp(draftSettings.lineHeight, 1.2, 2.4),
      viewerPadding: clamp(draftSettings.viewerPadding, 8, 42),
      viewerRadius: clamp(draftSettings.viewerRadius, 6, 28),

      appBgH: clamp(draftSettings.appBgH, 0, 360),
      appBgS: clamp(draftSettings.appBgS, 0, 100),
      appBgL: clamp(draftSettings.appBgL, 0, 100),

      cardBgH: clamp(draftSettings.cardBgH, 0, 360),
      cardBgS: clamp(draftSettings.cardBgS, 0, 100),
      cardBgL: clamp(draftSettings.cardBgL, 0, 100),

      textH: clamp(draftSettings.textH, 0, 360),
      textS: clamp(draftSettings.textS, 0, 100),
      textL: clamp(draftSettings.textL, 0, 100),

      bgPatternOpacity: clamp(draftSettings.bgPatternOpacity, 0, 1),
      bgPatternSize: clamp(draftSettings.bgPatternSize, 120, 1600),
      bgPatternBlend: clamp(draftSettings.bgPatternBlend, 0, 1),

      bgPatternUrl: String(draftSettings.bgPatternUrl ?? ""),
      pixivCookie: String(draftSettings.pixivCookie ?? ""),
    };

    setSettings(safe);
    try {
      saveSettings(safe);
    } catch {}
    setSettingsDirty(false);
    alert("설정이 저장되었습니다.");
  }

  /* ====== Derived styles (settings apply) ====== */
  const appBg = hsl(settings.appBgH, settings.appBgS, settings.appBgL);
  const cardBg = hsl(settings.cardBgH, settings.cardBgS, settings.cardBgL);
  const textColor = hsl(settings.textH, settings.textS, settings.textL);

  // 배경 패턴은 페이지 전체에 overlay
  const patternEnabled = !!settings.bgPatternUrl.trim();
  const patternStyle: React.CSSProperties = patternEnabled
    ? {
        backgroundImage: `url(${settings.bgPatternUrl.trim()})`,
        backgroundRepeat: "repeat",
        backgroundSize: `${settings.bgPatternSize}px ${settings.bgPatternSize}px`,
        opacity: settings.bgPatternOpacity,
        mixBlendMode: "multiply",
        pointerEvents: "none",
      }
    : {};

  // “blend” 느낌: 패턴 오버레이를 더 강하게 보이게 하는 얕은 필터 레이어
  const patternFilterStyle: React.CSSProperties = patternEnabled
    ? {
        background: `linear-gradient(0deg, rgba(0,0,0,${settings.bgPatternBlend * 0.06}) 0%, rgba(0,0,0,0) 70%)`,
        pointerEvents: "none",
      }
    : {};

  /* =========================
     UI
  ========================= */
  return (
    <div style={{ minHeight: "100vh", background: appBg, color: textColor }}>
      {/* 배경 패턴 레이어 */}
      {patternEnabled && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 0, ...patternStyle }} />
          <div style={{ position: "fixed", inset: 0, zIndex: 0, ...patternFilterStyle }} />
        </>
      )}

      {/* 콘텐츠 */}
      <main style={{ maxWidth: 860, margin: "0 auto", padding: 24, paddingBottom: 86, position: "relative", zIndex: 1 }}>
        {/* 상단바 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 900, margin: 0 }}>Parody Translator</h1>
            <div style={{ fontSize: 13, opacity: 0.72, marginTop: 6 }}>자동 저장: ☰ 목록에 시간순으로 쌓임</div>
          </div>

          {/* 오른쪽: 히스토리(☰) + 설정(⚙) */}
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
                border: "1px solid rgba(0,0,0,0.14)",
                cursor: "pointer",
                fontWeight: 900,
                background: "rgba(255,255,255,0.85)",
                fontSize: 18,
                backdropFilter: "blur(6px)",
              }}
              title="히스토리"
              aria-label="히스토리"
            >
              ☰
            </button>

            <button
              onClick={openSettings}
              style={{
                width: 44,
                height: 40,
                borderRadius: 12,
                border: "1px solid rgba(0,0,0,0.14)",
                cursor: "pointer",
                fontWeight: 900,
                background: "rgba(255,255,255,0.85)",
                fontSize: 18,
                backdropFilter: "blur(6px)",
              }}
              title="설정"
              aria-label="설정"
            >
              ⚙
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
              border: "1px solid rgba(0,0,0,0.14)",
              background: "rgba(255,255,255,0.85)",
              backdropFilter: "blur(6px)",
              color: textColor,
            }}
          />
          <button
            onClick={fetchFromUrl}
            disabled={isFetchingUrl || !url.trim()}
            style={{
              height: 40,
              padding: "0 12px",
              borderRadius: 10,
              border: "1px solid rgba(0,0,0,0.14)",
              cursor: isFetchingUrl || !url.trim() ? "not-allowed" : "pointer",
              fontWeight: 900,
              background: "rgba(255,255,255,0.85)",
              opacity: isFetchingUrl || !url.trim() ? 0.6 : 1,
              backdropFilter: "blur(6px)",
            }}
          >
            {isFetchingUrl ? "불러오는 중…" : "본문 불러오기"}
          </button>
        </div>

        {/* 텍스트 직접 번역 */}
        <details open={manualOpen} onToggle={(e) => setManualOpen((e.target as HTMLDetailsElement).open)} style={{ marginBottom: 12 }}>
          <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.88 }}>텍스트 직접 번역</summary>

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
                border: "1px solid rgba(0,0,0,0.14)",
                whiteSpace: "pre-wrap",
                background: "rgba(255,255,255,0.85)",
                backdropFilter: "blur(6px)",
                color: textColor,
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
                  border: "1px solid rgba(0,0,0,0.14)",
                  cursor: isLoading || !source.trim() ? "not-allowed" : "pointer",
                  fontWeight: 900,
                  background: "rgba(255,255,255,0.85)",
                  opacity: isLoading || !source.trim() ? 0.6 : 1,
                  backdropFilter: "blur(6px)",
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
                    borderRadius: 10,
                    border: "1px solid rgba(0,0,0,0.14)",
                    cursor: "pointer",
                    fontWeight: 900,
                    background: "rgba(255,255,255,0.85)",
                    backdropFilter: "blur(6px)",
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

        {error && <div style={{ color: "#b30000", marginTop: 8, fontWeight: 800, whiteSpace: "pre-wrap" }}>{error}</div>}

        {/* 결과 Viewer */}
        <div style={{ marginTop: 14 }}>
          <div style={{ fontWeight: 900, opacity: 0.88, marginBottom: 8 }}>번역 결과</div>

          <div
            style={{
              border: "1px solid rgba(0,0,0,0.14)",
              borderRadius: settings.viewerRadius,
              padding: settings.viewerPadding,
              background: cardBg,
              minHeight: 240,
              whiteSpace: "pre-wrap",
              lineHeight: settings.lineHeight,
              fontSize: settings.fontSize,
              color: textColor,
              boxShadow: "0 18px 40px rgba(0,0,0,0.10)",
            }}
          >
            {!resultBody.trim() ? (
              <div style={{ opacity: 0.62 }}>번역 결과가 여기에 표시됩니다.</div>
            ) : (
              <>
                {showHeader && (
                  <>
                    <div style={{ fontSize: 28, fontWeight: 900, marginBottom: 10 }}>{headerPreview.title}</div>
                    <div style={{ fontSize: 14, opacity: 0.75, marginBottom: 28 }}>{headerPreview.epLine}</div>
                  </>
                )}
                <div>{resultBody}</div>
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
                  <div style={{ fontSize: 12, opacity: 0.72, marginTop: 4, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
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

              {/* 상단: 전체 + 뒤로(아이콘만) */}
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

              {/* 하단 오른쪽: 선택모드일 때만 이동/삭제가 + 왼쪽에 등장 */}
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

                {/* + 버튼 */}
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

        {/* + 메뉴 팝업 (fixed 레이어: 잘림 방지) */}
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

        {/* 이동 모달 */}
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
                  style={{ height: 36, padding: "0 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900, background: "#fff" }}
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
                      {/* ✅ 폴더 깊이 표시: ↳ */}
                      <span style={{ display: "inline-block", width: depth * 16 }} />
                      {depth > 0 ? <span style={{ opacity: 0.7, marginRight: 6 }}>↳</span> : null}
                      📁 {f.name}
                    </button>
                  );
                })}
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginTop: 12 }}>
                <button
                  onClick={() => setMovePickerOpen(false)}
                  style={{ height: 38, padding: "0 14px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900, background: "#fff" }}
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
              background: "rgba(0,0,0,0.35)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
              zIndex: 10050,
            }}
            onClick={() => setSettingsOpen(false)}
          >
            <div
              style={{
                width: "min(860px, 100%)",
                maxHeight: "85vh",
                overflow: "auto",
                background: "#fff",
                borderRadius: 14,
                border: "1px solid #ddd",
                padding: 14,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 900 }}>설정</div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                    변경 후 <b>저장</b>을 눌러야 유지돼. {settingsDirty ? <b style={{ color: "#b30000" }}>· 저장 안 됨</b> : <span>· 저장됨</span>}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    onClick={() => {
                      setDraftSettings(settings);
                      setSettingsDirty(false);
                      alert("현재 저장된 설정으로 되돌렸어.");
                    }}
                    style={{ height: 36, padding: "0 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900, background: "#fff" }}
                  >
                    되돌리기
                  </button>

                  <button
                    onClick={saveDraft}
                    disabled={!settingsDirty}
                    style={{
                      height: 36,
                      padding: "0 12px",
                      borderRadius: 10,
                      border: "1px solid #ddd",
                      cursor: settingsDirty ? "pointer" : "not-allowed",
                      fontWeight: 900,
                      background: settingsDirty ? "#111" : "#eee",
                      color: settingsDirty ? "#fff" : "#777",
                    }}
                  >
                    저장
                  </button>

                  <button
                    onClick={() => setSettingsOpen(false)}
                    style={{ height: 36, padding: "0 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900, background: "#fff" }}
                  >
                    닫기
                  </button>
                </div>
              </div>

              {/* --- 서식 편집 --- */}
              <details open style={{ marginTop: 14 }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>서식 편집</summary>

                <div style={{ marginTop: 10 }}>
                  <LabeledSlider label="글자 크기" value={draftSettings.fontSize} min={12} max={30} onChange={(v) => updateDraft({ fontSize: v })} suffix="px" />
                  <LabeledSlider label="줄간격" value={draftSettings.lineHeight} min={1.2} max={2.4} step={0.05} onChange={(v) => updateDraft({ lineHeight: v })} />
                  <LabeledSlider label="결과 여백" value={draftSettings.viewerPadding} min={8} max={42} onChange={(v) => updateDraft({ viewerPadding: v })} suffix="px" />
                  <LabeledSlider label="모서리 둥글기" value={draftSettings.viewerRadius} min={6} max={28} onChange={(v) => updateDraft({ viewerRadius: v })} suffix="px" />

                  <div style={{ marginTop: 12, fontWeight: 900, opacity: 0.85 }}>미리보기</div>
                  <div
                    style={{
                      marginTop: 8,
                      border: "1px solid #ddd",
                      borderRadius: draftSettings.viewerRadius,
                      padding: draftSettings.viewerPadding,
                      background: hsl(draftSettings.cardBgH, draftSettings.cardBgS, draftSettings.cardBgL),
                      color: hsl(draftSettings.textH, draftSettings.textS, draftSettings.textL),
                      lineHeight: draftSettings.lineHeight,
                      fontSize: draftSettings.fontSize,
                    }}
                  >
                    <div style={{ fontWeight: 900, fontSize: 22 }}>미리보기 제목</div>
                    <div style={{ opacity: 0.72, marginTop: 6 }}>제 1화 · 부제목</div>
                    <div style={{ marginTop: 14 }}>
                      비는 새벽부터 계속 내리고 있었다.
                      {"\n\n"}
                      이 박스의 글자크기/줄간격/여백을 지금 조절한 값으로 확인할 수 있어.
                    </div>
                  </div>
                </div>
              </details>

              {/* --- 배경 편집 --- */}
              <details style={{ marginTop: 14 }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>배경 편집</summary>

                <div style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 900, opacity: 0.85, marginTop: 4 }}>페이지 배경 색상</div>
                  <LabeledSlider label="Hue" value={draftSettings.appBgH} min={0} max={360} onChange={(v) => updateDraft({ appBgH: v })} />
                  <LabeledSlider label="Saturation" value={draftSettings.appBgS} min={0} max={100} onChange={(v) => updateDraft({ appBgS: v })} />
                  <LabeledSlider label="Lightness" value={draftSettings.appBgL} min={0} max={100} onChange={(v) => updateDraft({ appBgL: v })} />

                  <div style={{ fontWeight: 900, opacity: 0.85, marginTop: 14 }}>결과 카드 배경 색상</div>
                  <LabeledSlider label="Hue" value={draftSettings.cardBgH} min={0} max={360} onChange={(v) => updateDraft({ cardBgH: v })} />
                  <LabeledSlider label="Saturation" value={draftSettings.cardBgS} min={0} max={100} onChange={(v) => updateDraft({ cardBgS: v })} />
                  <LabeledSlider label="Lightness" value={draftSettings.cardBgL} min={0} max={100} onChange={(v) => updateDraft({ cardBgL: v })} />

                  <div style={{ fontWeight: 900, opacity: 0.85, marginTop: 14 }}>글자 색상</div>
                  <LabeledSlider label="Hue" value={draftSettings.textH} min={0} max={360} onChange={(v) => updateDraft({ textH: v })} />
                  <LabeledSlider label="Saturation" value={draftSettings.textS} min={0} max={100} onChange={(v) => updateDraft({ textS: v })} />
                  <LabeledSlider label="Lightness" value={draftSettings.textL} min={0} max={100} onChange={(v) => updateDraft({ textL: v })} />

                  <div style={{ fontWeight: 900, opacity: 0.85, marginTop: 14 }}>빈티지 배경 무늬(선택)</div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                    오래된 종이 같은 무늬를 쓰고 싶으면, 패턴 이미지 URL을 넣어줘. (없으면 비워두면 됨)
                  </div>

                  <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      value={draftSettings.bgPatternUrl}
                      onChange={(e) => updateDraft({ bgPatternUrl: e.target.value })}
                      placeholder="배경 패턴 이미지 URL"
                      style={{ flex: 1, padding: 10, borderRadius: 10, border: "1px solid #ddd" }}
                    />
                    <button
                      onClick={() => updateDraft({ bgPatternUrl: "" })}
                      style={{ height: 40, padding: "0 12px", borderRadius: 10, border: "1px solid #ddd", cursor: "pointer", fontWeight: 900, background: "#fff" }}
                    >
                      비우기
                    </button>
                  </div>

                  <LabeledSlider label="무늬 투명도" value={draftSettings.bgPatternOpacity} min={0} max={1} step={0.01} onChange={(v) => updateDraft({ bgPatternOpacity: v })} />
                  <LabeledSlider label="무늬 크기" value={draftSettings.bgPatternSize} min={120} max={1600} step={10} onChange={(v) => updateDraft({ bgPatternSize: v })} suffix="px" />
                  <LabeledSlider label="무늬 강조" value={draftSettings.bgPatternBlend} min={0} max={1} step={0.01} onChange={(v) => updateDraft({ bgPatternBlend: v })} />

                  <div style={{ marginTop: 12, fontWeight: 900, opacity: 0.85 }}>미리보기</div>
                  <div
                    style={{
                      marginTop: 8,
                      border: "1px solid #ddd",
                      borderRadius: 14,
                      overflow: "hidden",
                    }}
                  >
                    <div style={{ position: "relative", height: 200, background: hsl(draftSettings.appBgH, draftSettings.appBgS, draftSettings.appBgL) }}>
                      {!!draftSettings.bgPatternUrl.trim() && (
                        <>
                          <div
                            style={{
                              position: "absolute",
                              inset: 0,
                              backgroundImage: `url(${draftSettings.bgPatternUrl.trim()})`,
                              backgroundRepeat: "repeat",
                              backgroundSize: `${draftSettings.bgPatternSize}px ${draftSettings.bgPatternSize}px`,
                              opacity: draftSettings.bgPatternOpacity,
                              mixBlendMode: "multiply",
                            }}
                          />
                          <div
                            style={{
                              position: "absolute",
                              inset: 0,
                              background: `linear-gradient(0deg, rgba(0,0,0,${draftSettings.bgPatternBlend * 0.06}) 0%, rgba(0,0,0,0) 70%)`,
                            }}
                          />
                        </>
                      )}

                      <div style={{ position: "absolute", inset: 14 }}>
                        <div
                          style={{
                            height: "100%",
                            borderRadius: draftSettings.viewerRadius,
                            background: hsl(draftSettings.cardBgH, draftSettings.cardBgS, draftSettings.cardBgL),
                            color: hsl(draftSettings.textH, draftSettings.textS, draftSettings.textL),
                            padding: draftSettings.viewerPadding,
                            lineHeight: draftSettings.lineHeight,
                            fontSize: draftSettings.fontSize,
                            border: "1px solid rgba(0,0,0,0.12)",
                          }}
                        >
                          <div style={{ fontWeight: 900 }}>배경 미리보기</div>
                          <div style={{ marginTop: 8, opacity: 0.8 }}>페이지 배경 + 패턴 + 카드 배경이 이렇게 보일 거야.</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </details>

              {/* --- 쿠키 등록 --- */}
              <details style={{ marginTop: 14 }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>쿠키 등록</summary>
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    여기에 저장된 쿠키는 **브라우저 로컬에만 저장**돼. (서버로 보내는 코드를 추가하지 않는 한 전송되지 않아)
                  </div>

                  <textarea
                    value={draftSettings.pixivCookie}
                    onChange={(e) => updateDraft({ pixivCookie: e.target.value })}
                    placeholder="Pixiv 쿠키 문자열을 붙여넣기"
                    style={{
                      width: "100%",
                      minHeight: 120,
                      padding: 12,
                      borderRadius: 10,
                      border: "1px solid #ddd",
                      marginTop: 8,
                      whiteSpace: "pre-wrap",
                    }}
                  />
                </div>
              </details>
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
            background: "rgba(255,255,255,0.92)",
            borderTop: "1px solid rgba(0,0,0,0.14)",
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
                border: "1px solid rgba(0,0,0,0.14)",
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
                border: "1px solid rgba(0,0,0,0.14)",
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
                border: "1px solid rgba(0,0,0,0.14)",
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
