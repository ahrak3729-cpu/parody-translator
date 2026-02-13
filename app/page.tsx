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

const STORAGE_KEY = "parody_translator_history_v4";
const FOLDERS_KEY = "parody_translator_history_folders_v3";
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
   컴팩트 슬라이더 Row
========================= */
function SliderRow(props: {
  label: string;
  valueText?: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
      <div style={{ width: 92, fontWeight: 900, fontSize: 13, opacity: 0.85 }}>{props.label}</div>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
        style={{ flex: 1 }}
      />
      <div style={{ width: 56, textAlign: "right", fontSize: 12, opacity: 0.75 }}>
        {props.valueText ?? String(props.value)}
      </div>
    </div>
  );
}

/* =========================
   설정(서식/배경/쿠키)
========================= */
type BackgroundMode = "A_VINTAGE_PAPER" | "B_SOLID" | "C_IMAGE";

type ViewerSettings = {
  // 서식
  fontSize: number; // px
  lineHeight: number;
  textColor: string;

  // 배경
  bgMode: BackgroundMode;
  bgColor: string; // solid / base color
  bgImageUrl: string; // C_IMAGE
  bgRepeat: "no-repeat" | "repeat";
  bgSize: "cover" | "contain" | "auto";
  overlayOpacity: number; // 0~0.35

  // Pixiv
  pixivCookie: string;
};

const DEFAULT_SETTINGS: ViewerSettings = {
  fontSize: 16,
  lineHeight: 1.7,
  textColor: "#111111",

  // 기본은 A안(고급스러운 오래된 종이 느낌) — 수정 가능
  bgMode: "A_VINTAGE_PAPER",
  bgColor: "#F3EAD7",
  bgImageUrl: "",
  bgRepeat: "no-repeat",
  bgSize: "cover",
  overlayOpacity: 0.14,

  pixivCookie: "",
};

function loadSettings(): ViewerSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: ViewerSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function isSameSettings(a: ViewerSettings, b: ViewerSettings) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
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

  // ✅ + 메뉴 팝업: 모달 밖 fixed 레이어로 띄우기 위해 좌표 저장
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ right: number; bottom: number } | null>(null);

  // ✅ 파일 선택 모드: 토글 버튼으로만 켜기
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});

  // 이동 대상 선택 모달
  const [movePickerOpen, setMovePickerOpen] = useState(false);
  const [moveTargetFolderId, setMoveTargetFolderId] = useState<string | null>(null);

  // 페이지네이션
  const PAGE_SIZE = 8;
  const [historyPage, setHistoryPage] = useState(1);

  /* =========================
     설정(⚙️) — 적용값/임시값(draft)
  ========================= */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appliedSettings, setAppliedSettings] = useState<ViewerSettings>(() => {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    return loadSettings();
  });
  const [draftSettings, setDraftSettings] = useState<ViewerSettings>(() => {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    return loadSettings();
  });

  const settingsDirty = useMemo(() => !isSameSettings(appliedSettings, draftSettings), [appliedSettings, draftSettings]);

  // 접기/펴기(기본: 접힘)
  const [secFormatOpen, setSecFormatOpen] = useState(false);
  const [secBgOpen, setSecBgOpen] = useState(false);
  const [secCookieOpen, setSecCookieOpen] = useState(false);

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

    const nextHistory = history.filter((h) => !idsToDelete.includes(((h.folderId || "") as string) || ""));
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
     (Pixiv 쿠키는 settings의 draft/applied 중 적용값 사용)
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
        // ✅ server route가 cookie를 받도록 이미 수정해둔 상태라면 여기로 전달됨
        body: JSON.stringify({ url: u, cookie: appliedSettings.pixivCookie?.trim() || "" }),
      });

      const data: any = await safeReadJson(res);

      if (!res.ok) {
        const msg = data?.error || data?.message || "본문 불러오기 실패";
        throw new Error(String(msg));
      }

      if (data?.__notJson) {
        throw new Error(
          "본문을 JSON으로 받지 못했어요. Pixiv는 로그인/봇 차단 때문에 서버에서 본문 추출이 실패할 수 있어요.\n(쿠키 등록을 확인하거나, 텍스트 직접 붙여넣기로 확인해줘)"
        );
      }

      if (data?.title) setSeriesTitle(String(data.title));
      const text = String(data?.text ?? "");
      if (!text.trim()) {
        throw new Error("본문을 가져왔지만 내용이 비어있어요. (권한/차단 가능)\n쿠키 등록을 확인해줘.");
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
     + 메뉴 앵커 계산 (모달 잘림 방지)
  ========================= */
  function openMenuFromButton(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
    const right = Math.max(12, window.innerWidth - rect.right);
    const bottom = Math.max(12, window.innerHeight - rect.top);
    setMenuAnchor({ right, bottom });
    setMenuOpen(true);
  }

  /* =========================
     설정: 저장/취소
  ========================= */
  function openSettings() {
    setDraftSettings(appliedSettings);
    setSecFormatOpen(false);
    setSecBgOpen(false);
    setSecCookieOpen(false);
    setSettingsOpen(true);
  }

  function closeSettingsDiscard() {
    setDraftSettings(appliedSettings);
    setSettingsOpen(false);
  }

  function saveSettingsApply() {
    const next: ViewerSettings = {
      ...draftSettings,
      fontSize: clamp(Math.round(draftSettings.fontSize), 12, 26),
      lineHeight: Number(draftSettings.lineHeight.toFixed(2)),
      overlayOpacity: Number(clamp(draftSettings.overlayOpacity, 0, 0.35).toFixed(2)),
    };
    setAppliedSettings(next);
    setDraftSettings(next);
    try {
      saveSettings(next);
    } catch {}
    setSettingsOpen(false);
  }

  /* =========================
     미리보기/뷰어 스타일 생성
  ========================= */
  function getPaperBaseGradient(bgColor: string) {
    // "고급스러운 오래된 종이" 느낌을 CSS 그라데이션으로 근사 (이미지 없이도 동작)
    // (원하면 bgImageUrl 넣어서 진짜 텍스처로 교체 가능)
    return `
      radial-gradient(1200px 800px at 20% 10%, rgba(255,255,255,0.55), rgba(255,255,255,0) 55%),
      radial-gradient(900px 700px at 80% 30%, rgba(255,255,255,0.35), rgba(255,255,255,0) 55%),
      linear-gradient(180deg, rgba(0,0,0,0.02), rgba(0,0,0,0) 40%),
      linear-gradient(0deg, rgba(0,0,0,0.025), rgba(0,0,0,0) 45%),
      linear-gradient(0deg, ${bgColor}, ${bgColor})
    `.trim();
  }

  function buildBgStyle(s: ViewerSettings): React.CSSProperties {
    if (s.bgMode === "B_SOLID") {
      return { backgroundColor: s.bgColor };
    }

    if (s.bgMode === "C_IMAGE" && s.bgImageUrl.trim()) {
      return {
        backgroundColor: s.bgColor,
        backgroundImage: `linear-gradient(rgba(255,255,255,${1 - s.overlayOpacity}), rgba(255,255,255,${
          1 - s.overlayOpacity
        })), url(${s.bgImageUrl.trim()})`,
        backgroundRepeat: s.bgRepeat,
        backgroundSize: s.bgSize,
        backgroundPosition: "center",
      };
    }

    // A_VINTAGE_PAPER 기본
    return {
      backgroundColor: s.bgColor,
      backgroundImage: getPaperBaseGradient(s.bgColor),
      backgroundRepeat: "no-repeat",
      backgroundSize: "cover",
      backgroundPosition: "center",
      // overlayOpacity는 “종이 질감 강도”로 보고 base gradient에 이미 반영하는 느낌이라,
      // 여기서는 카드 내부 하이라이트로만 살짝 보정
      boxShadow: `inset 0 0 0 9999px rgba(255,255,255,${clamp(0.18 - s.overlayOpacity, 0, 0.18)})`,
    };
  }

  const viewerStyleApplied: React.CSSProperties = useMemo(() => {
    return {
      border: "1px solid #ddd",
      borderRadius: 14,
      padding: 16,
      minHeight: 240,
      whiteSpace: "pre-wrap",
      lineHeight: appliedSettings.lineHeight,
      fontSize: appliedSettings.fontSize,
      color: appliedSettings.textColor,
      ...buildBgStyle(appliedSettings),
    };
  }, [appliedSettings]);

  const viewerStyleDraft: React.CSSProperties = useMemo(() => {
    return {
      border: "1px solid #ddd",
      borderRadius: 14,
      padding: 16,
      minHeight: 200,
      whiteSpace: "pre-wrap",
      lineHeight: draftSettings.lineHeight,
      fontSize: draftSettings.fontSize,
      color: draftSettings.textColor,
      ...buildBgStyle(draftSettings),
    };
  }, [draftSettings]);

  /* =========================
     UI
  ========================= */
  return (
    <main style={{ maxWidth: 860, margin: "0 auto", padding: 24, paddingBottom: 86 }}>
      {/* 상단바 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 900, margin: 0 }}>Parody Translator</h1>
          <div style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>자동 저장: ☰ 목록에 시간순으로 쌓임</div>
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
              border: "1px solid #ddd",
              cursor: "pointer",
              fontWeight: 900,
              background: "#fff",
              fontSize: 18,
            }}
            title="히스토리"
            aria-label="히스토리"
          >
            ☰
          </button>

          {/* 설정: ⚙️ */}
          <button
            onClick={openSettings}
            style={{
              width: 44,
              height: 40,
              borderRadius: 12,
              border: "1px solid #ddd",
              cursor: "pointer",
              fontWeight: 900,
              background: "#fff",
              fontSize: 18,
              position: "relative",
            }}
            title="설정"
            aria-label="설정"
          >
            ⚙️
            {settingsDirty && (
              <span
                style={{
                  position: "absolute",
                  right: 6,
                  top: 6,
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: "#d00",
                }}
              />
            )}
          </button>
        </div>
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
              border: "1px solid #ddd",
              whiteSpace: "pre-wrap",
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

      {/* 결과 Viewer (적용값으로 표시) */}
      <div style={{ marginTop: 14 }}>
        <div style={{ fontWeight: 900, opacity: 0.85, marginBottom: 8 }}>번역 결과</div>

        <div style={viewerStyleApplied}>
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
          설정(⚙️) 모달
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
          onClick={() => {
            if (settingsDirty) {
              const ok = confirm("저장하지 않은 변경사항이 있어. 닫을까? (변경사항은 사라져)");
              if (!ok) return;
            }
            closeSettingsDiscard();
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
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 헤더 */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 18, fontWeight: 900 }}>설정</div>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                  변경 후 <b>저장</b>을 눌러야 유지돼.
                </div>
              </div>

              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  onClick={closeSettingsDiscard}
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

                <button
                  onClick={saveSettingsApply}
                  disabled={!settingsDirty}
                  style={{
                    height: 36,
                    padding: "0 12px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    cursor: settingsDirty ? "pointer" : "not-allowed",
                    fontWeight: 900,
                    background: "#111",
                    color: "#fff",
                    opacity: settingsDirty ? 1 : 0.5,
                  }}
                >
                  저장
                </button>
              </div>
            </div>

            {/* 미리보기 (서식/배경 공통) */}
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 900, opacity: 0.8, marginBottom: 8 }}>미리보기</div>
              <div style={viewerStyleDraft}>
                {showHeader ? (
                  <>
                    <div style={{ fontSize: 26, fontWeight: 900, marginBottom: 8 }}>{headerPreview.title}</div>
                    <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 18 }}>{headerPreview.epLine}</div>
                  </>
                ) : (
                  <div style={{ fontSize: 13, opacity: 0.6, marginBottom: 10 }}>
                    (URL 번역을 하면 제목/회차가 위에 같이 보여.)
                  </div>
                )}
                <div style={{ opacity: 0.95 }}>
                  {resultBody.trim()
                    ? resultBody.slice(0, 900) + (resultBody.length > 900 ? "\n\n…(미리보기 일부)" : "")
                    : "번역 결과가 있으면 여기서 스타일을 바로 확인할 수 있어."}
                </div>
              </div>
            </div>

            {/* 섹션: 서식 편집 */}
            <details open={secFormatOpen} onToggle={(e) => setSecFormatOpen((e.target as HTMLDetailsElement).open)} style={{ marginTop: 10 }}>
              <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>서식 편집</summary>

              <div style={{ padding: "6px 2px 2px" }}>
                <SliderRow
                  label="글자 크기"
                  min={12}
                  max={26}
                  step={1}
                  value={draftSettings.fontSize}
                  valueText={`${draftSettings.fontSize}px`}
                  onChange={(v) => setDraftSettings((p) => ({ ...p, fontSize: v }))}
                />

                <SliderRow
                  label="줄간격"
                  min={1.3}
                  max={2.4}
                  step={0.05}
                  value={draftSettings.lineHeight}
                  valueText={`${draftSettings.lineHeight.toFixed(2)}`}
                  onChange={(v) => setDraftSettings((p) => ({ ...p, lineHeight: v }))}
                />

                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
                  <div style={{ width: 92, fontWeight: 900, fontSize: 13, opacity: 0.85 }}>글자 색</div>
                  <input
                    type="color"
                    value={draftSettings.textColor}
                    onChange={(e) => setDraftSettings((p) => ({ ...p, textColor: e.target.value }))}
                    style={{ width: 46, height: 32, border: "1px solid #ddd", borderRadius: 10, background: "#fff" }}
                  />
                  <input
                    value={draftSettings.textColor}
                    onChange={(e) => setDraftSettings((p) => ({ ...p, textColor: e.target.value }))}
                    style={{ flex: 1, padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd" }}
                  />
                </div>
              </div>
            </details>

            {/* 섹션: 배경 편집 */}
            <details open={secBgOpen} onToggle={(e) => setSecBgOpen((e.target as HTMLDetailsElement).open)} style={{ marginTop: 10 }}>
              <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>배경 편집</summary>

              <div style={{ padding: "6px 2px 2px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                  <div style={{ width: 92, fontWeight: 900, fontSize: 13, opacity: 0.85 }}>배경 모드</div>
                  <select
                    value={draftSettings.bgMode}
                    onChange={(e) => setDraftSettings((p) => ({ ...p, bgMode: e.target.value as BackgroundMode }))}
                    style={{ flex: 1, padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", fontWeight: 900 }}
                  >
                    <option value="A_VINTAGE_PAPER">A안 · 빈티지 종이</option>
                    <option value="B_SOLID">단색</option>
                    <option value="C_IMAGE">이미지 URL</option>
                  </select>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
                  <div style={{ width: 92, fontWeight: 900, fontSize: 13, opacity: 0.85 }}>바탕색</div>
                  <input
                    type="color"
                    value={draftSettings.bgColor}
                    onChange={(e) => setDraftSettings((p) => ({ ...p, bgColor: e.target.value }))}
                    style={{ width: 46, height: 32, border: "1px solid #ddd", borderRadius: 10, background: "#fff" }}
                  />
                  <input
                    value={draftSettings.bgColor}
                    onChange={(e) => setDraftSettings((p) => ({ ...p, bgColor: e.target.value }))}
                    style={{ flex: 1, padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd" }}
                  />
                </div>

                <SliderRow
                  label="질감 강도"
                  min={0}
                  max={0.35}
                  step={0.01}
                  value={draftSettings.overlayOpacity}
                  valueText={`${draftSettings.overlayOpacity.toFixed(2)}`}
                  onChange={(v) => setDraftSettings((p) => ({ ...p, overlayOpacity: v }))}
                />

                {draftSettings.bgMode === "C_IMAGE" && (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
                      <div style={{ width: 92, fontWeight: 900, fontSize: 13, opacity: 0.85 }}>이미지 URL</div>
                      <input
                        value={draftSettings.bgImageUrl}
                        onChange={(e) => setDraftSettings((p) => ({ ...p, bgImageUrl: e.target.value }))}
                        placeholder="https://..."
                        style={{ flex: 1, padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd" }}
                      />
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                      <div style={{ width: 92, fontWeight: 900, fontSize: 13, opacity: 0.85 }}>반복</div>
                      <select
                        value={draftSettings.bgRepeat}
                        onChange={(e) => setDraftSettings((p) => ({ ...p, bgRepeat: e.target.value as any }))}
                        style={{ flex: 1, padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", fontWeight: 900 }}
                      >
                        <option value="no-repeat">반복 안함</option>
                        <option value="repeat">반복</option>
                      </select>
                    </div>

                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10 }}>
                      <div style={{ width: 92, fontWeight: 900, fontSize: 13, opacity: 0.85 }}>크기</div>
                      <select
                        value={draftSettings.bgSize}
                        onChange={(e) => setDraftSettings((p) => ({ ...p, bgSize: e.target.value as any }))}
                        style={{ flex: 1, padding: "8px 10px", borderRadius: 10, border: "1px solid #ddd", fontWeight: 900 }}
                      >
                        <option value="cover">cover</option>
                        <option value="contain">contain</option>
                        <option value="auto">auto</option>
                      </select>
                    </div>
                  </>
                )}
              </div>
            </details>

            {/* 섹션: Pixiv 쿠키 */}
            <details
              open={secCookieOpen}
              onToggle={(e) => setSecCookieOpen((e.target as HTMLDetailsElement).open)}
              style={{ marginTop: 10 }}
            >
              <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.9 }}>Pixiv 쿠키 등록</summary>

              <div style={{ padding: "6px 2px 2px" }}>
                <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6, whiteSpace: "pre-wrap" }}>
                  여기 쿠키는 서버에서 Pixiv 본문을 가져올 때만 사용해.
                  {"\n"}(서버에 저장되는 게 아니라, 이 브라우저 로컬 저장소에 저장돼)
                </div>

                <textarea
                  value={draftSettings.pixivCookie}
                  onChange={(e) => setDraftSettings((p) => ({ ...p, pixivCookie: e.target.value }))}
                  placeholder="PC 크롬 개발자도구 → Application/Storage → Cookies → pixiv.net\n또는 Network 요청 헤더의 Cookie 값을 그대로 복사"
                  style={{
                    width: "100%",
                    minHeight: 120,
                    padding: 12,
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    marginTop: 10,
                    whiteSpace: "pre-wrap",
                  }}
                />
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

            {/* 상단: 전체/뒤로(아이콘만) */}
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

            {/* 하단 오른쪽: 선택모드일 때만 이동/삭제 버튼이 + 왼쪽에 등장 */}
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

      {/* + 메뉴 팝업 (fixed 레이어) */}
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
                    {/* 다음 단계에서 ↳로 바꾸고 싶으면 여기 depth 들여쓰기 옆에 아이콘 붙이면 됨 */}
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
          background: "rgba(255,255,255,0.96)",
          borderTop: "1px solid #ddd",
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
            onClick={() => handleCopy(resultBody || "")}
            disabled={!resultBody.trim()}
            style={{
              height: 40,
              padding: "0 14px",
              borderRadius: 12,
              border: "1px solid #ddd",
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
