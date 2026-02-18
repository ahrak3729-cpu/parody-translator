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

  // ✅ “패러디소설” 같은 기본값 자동 주입 금지: 빈 문자열 허용
  seriesTitle: string;

  // ✅ 회차가 원문에 없으면 null (임의로 1화 생성 금지)
  episodeNo: number | null;
  // ✅ 원문 회차 표식(헤더 표시용): "#01" 같은 원문 그대로 / 第1話는 "제 1화"로 저장
  episodeHeader: string;

  // 원문 부제목/제목(저장용)
  subtitle: string;

  // ✅ 번역된 부제목(표시용)
  translatedSubtitle?: string;

  sourceText: string;

  translatedText: string; // 본문만 저장
  url?: string;
  folderId?: string | null;

  // 헤더 표시 여부
  showHeader?: boolean;
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

  // ✅ 폰트
  fontFamily: string;

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
  bgPatternBlend: number; // 0~1 (강조 느낌)

  // Pixiv 쿠키
  pixivCookie: string;

  // ✅ 프리셋
  pixivPresetEnabled: boolean; // Pixiv 복사용 텍스트 정리+헤더 적용
  pixivStripMeta: boolean; // 날짜/시간/작가명 제거
};

const DEFAULT_SETTINGS: AppSettings = {
  // 서식(기본 A안)
  fontSize: 16,
  lineHeight: 1.7,
  viewerPadding: 16,
  viewerRadius: 14,

  // ✅ 기본 폰트(시스템)
  fontFamily:
    'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',

  // 오래된 종이 + 고급스러운 톤 (HSL)
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

  // ✅ 프리셋 기본값
  pixivPresetEnabled: true,
  pixivStripMeta: true,
};

const SETTINGS_KEY = "parody_translator_settings_v1"; // 기존 키 유지
const SESSION_KEY = "parody_translator_session_v1"; // 현재 화면 상태 저장

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

    // ✅ 구버전 호환: episodeNo가 number만 있던 시절 데이터 -> 그대로 살리되, 없으면 null
    return parsed
      .filter((x) => x && typeof x === "object" && typeof x.id === "string")
      .map((x) => {
        const ep =
          typeof (x as any).episodeNo === "number" && Number.isFinite((x as any).episodeNo)
            ? Math.max(1, Math.floor((x as any).episodeNo))
            : null;

        const item: HistoryItem = {
          id: String((x as any).id),
          createdAt: Number((x as any).createdAt) || Date.now(),
          seriesTitle: typeof (x as any).seriesTitle === "string" ? (x as any).seriesTitle : "",
          episodeNo: ep,
           episodeHeader:
            typeof (x as any).episodeHeader === "string"
              ? (x as any).episodeHeader
              : ep != null
              ? `제 ${ep}화`
              : "",
          subtitle: typeof (x as any).subtitle === "string" ? (x as any).subtitle : "",
          translatedSubtitle:
            typeof (x as any).translatedSubtitle === "string" ? (x as any).translatedSubtitle : undefined,
          sourceText: typeof (x as any).sourceText === "string" ? (x as any).sourceText : "",
          translatedText: typeof (x as any).translatedText === "string" ? (x as any).translatedText : "",
          url: typeof (x as any).url === "string" ? (x as any).url : undefined,
          folderId: typeof (x as any).folderId === "string" ? (x as any).folderId : (x as any).folderId ?? null,
          showHeader: typeof (x as any).showHeader === "boolean" ? (x as any).showHeader : false,
        };
        return item;
      });
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
   ✅ 라벨 옆 슬라이더 (가로형)
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

/* =========================
   ✅ 세션(현재 화면) 저장/복원
========================= */
type AppSession = {
  url: string;
  manualOpen: boolean;

  seriesTitle: string;
  episodeNo: number | null;
   episodeHeader: string;
  subtitle: string;
  translatedSubtitle: string;

  source: string;
  resultBody: string;
  showHeader: boolean;

  currentHistoryId: string | null;
};

function loadSession(): Partial<AppSession> | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveSession(s: AppSession) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
}

/* =========================
   ✅ Pixiv 프리셋: 읽기모드 복사 텍스트 정리
   - 목표: 회차/부제목 추출 + 메타(날짜/시간/작가명) 제거
   - 원문에 없는 “패러디소설” 같은 문구 절대 추가 금지
   - ✅ Side / Side Fate / Side out 은 '부제목 후보에서 제외'
   - ✅ 회차도 원문에 명시된 경우에만 생성 (임의로 1화 생성 금지)
========================= */
function normalizeText(t: string) {
  return t.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ");
}

function looksLikeDateTimeLine(line: string) {
  const s = line.trim();

  // 2018년 12월 7일 오후 9:06 / 2025/02/01 13:20 등
  if (/\b\d{4}[./-]\d{1,2}[./-]\d{1,2}\b/.test(s)) return true;
  if (/\b\d{1,2}:\d{2}\b/.test(s) && /\b(AM|PM|오전|오후)\b/.test(s)) return true;
  if (/\b\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일\b/.test(s)) return true;
  if (/^\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/.test(s)) return true;
  if (/^\d{1,2}:\d{2}$/.test(s)) return true;
  return false;
}

function looksLikeAuthorLine(line: string) {
  const s = line.trim();
  if (/^(作者|Author|by)\b/i.test(s)) return true;
  if (/^(.+)\s*さん$/.test(s)) return true; // 일본어 “~さん”
  if (/^\S+\s*\(.*\)$/.test(s) && s.length <= 40) return true; // 짧은 "이름(무언가)"
  return false;
}

function parseEpisodeNo(line: string): number | null {
  const s = line.trim();

  // ✅ 단독 회차 표식만 인정 (뒤에 텍스트가 붙으면 회차로 보지 않음)
  // "#1" / "#01"
  let m = s.match(/^#\s*(\d{1,4})\s*$/);
  if (m?.[1]) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 9999) return n;
    return null;
  }

  // "第1話"
  m = s.match(/^第\s*(\d{1,4})\s*話\s*$/);
  if (m?.[1]) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 9999) return n;
    return null;
  }

  // "제 1화" / "1화"
  m = s.match(/^(?:제\s*)?(\d{1,4})\s*화\s*$/);
  if (m?.[1]) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1 && n <= 9999) return n;
    return null;
  }

  return null;
}

function pickSubtitleFromLine(line: string): string | null {
  const raw = line.trim();
  if (!raw) return null;

  // 너무 긴 문장은 제목으로 보기 어려움
  if (raw.length > 80) return null;

  // 회차 같은 숫자/기호 제거 후 남은 텍스트에서 제목 후보 추출
  const cleaned = raw
    .replace(/^#\s*\d+\s*/, "")
    .replace(/^(?:第|제)?\s*\d+\s*(?:話|화)\s*[:：.-]?\s*/, "")
    .trim();

  if (!cleaned) return null;

  // 구분자(|, /, -)가 있으면 첫 구간을 우선 부제목으로
  const parts = cleaned.split(/\s*(?:\||\/|／|—|–|-|―)\s*/g).filter(Boolean);
  const cand = (parts[0] || "").trim();
  if (!cand) return null;

  // ✅ "Fate," 같이 끝이 쉼표/콜론/유사 문장부호면 제목으로 보지 않음
  // (Pixiv에서 "#1 Fate," 같은 라인이 많아서 오인식 방지)
  if (/[,:，：]$/.test(cand)) return null;

  // 문장형은 제외
  if (/[。.!?]$/.test(cand)) return null;

  return cand;
}

type PixivPresetResult = {
  cleanedText: string;
  episodeNo?: number;
  subtitle?: string; // 원문 부제목
};

function applyPixivPreset(rawText: string, stripMeta: boolean): PixivPresetResult {
  const text = normalizeText(rawText).trim();
  if (!text) return { cleanedText: "" };

  const lines = text.split("\n").map((l) => l.replace(/\s+$/g, ""));
  const outLines: string[] = [];

  let episodeNo: number | undefined;
  let subtitle: string | undefined;

  // 상단 몇 줄에서 회차/부제목 후보를 우선 탐색
  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const ln = lines[i].trim();
    if (!ln) continue;

    if (episodeNo == null) {
      const n = parseEpisodeNo(ln);
      if (n != null) episodeNo = n;
    }

    if (!subtitle) {
      const t = pickSubtitleFromLine(ln);
      if (t) subtitle = t;
    }
  }

  // 메타 제거 + 정리
  for (const l0 of lines) {
    const l = l0.trimEnd();
    const t = l.trim();

    if (stripMeta) {
      if (looksLikeDateTimeLine(t)) continue;
      if (looksLikeAuthorLine(t)) continue;
    }

    outLines.push(l);
  }

  const cleaned = outLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { cleanedText: cleaned, episodeNo, subtitle };
}

export default function Page() {
  /* =========================
     Settings (persisted)
  ========================= */
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  // ✅ "설정을 로드한 뒤에만 저장"하기 위한 가드
  const settingsHydratedRef = useRef(false);

  // 설정 모달(draft)
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draftSettings, setDraftSettings] = useState<AppSettings>(settings);
  const [settingsDirty, setSettingsDirty] = useState(false);

  // ✅ 마운트 후 1회: localStorage에서 settings 로드
  useEffect(() => {
    if (typeof window === "undefined") return;

    const loaded = loadSettings();
    setSettings(loaded);

    // 설정 모달 draft도 동기화
    setDraftSettings(loaded);
    setSettingsDirty(false);

    settingsHydratedRef.current = true;
  }, []);

  // ✅ settings 변경 시 자동 저장 (단, 로드 전엔 저장 금지)
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!settingsHydratedRef.current) return;

    try {
      saveSettings(settings);
    } catch {}
  }, [settings]);

  function openSettings() {
    setDraftSettings(settings);
    setSettingsDirty(false);
    setSettingsOpen(true);
  }
  function updateDraft(patch: Partial<AppSettings>) {
    setDraftSettings((prev) => {
      const next = { ...prev, ...patch };
      setSettingsDirty(true);
      return next;
    });
  }
  function saveDraft() {
    setSettings(draftSettings);
    try {
      saveSettings(draftSettings);
    } catch {}
    setSettingsDirty(false);
  }
  function undoDraft() {
    setDraftSettings(settings);
    setSettingsDirty(false);
  }

  /* =========================
     URL 중심
  ========================= */
  const [url, setUrl] = useState("");
  const [isFetchingUrl, setIsFetchingUrl] = useState(false);

  /* =========================
     텍스트 직접 번역
  ========================= */
  const [manualOpen, setManualOpen] = useState(false);

  /* =========================
     메타
  ========================= */
  // ✅ 기본값 “패러디소설” 제거 (원문에 없는 문구 추가 금지)
  const [seriesTitle, setSeriesTitle] = useState("");

  // ✅ 회차 기본값 임의 생성 금지: null부터 시작
  const [episodeNo, setEpisodeNo] = useState<number | null>(null);

  // 원문 부제목(저장용)
  const [subtitle, setSubtitle] = useState("");

  // ✅ 번역된 부제목(표시용)
  const [translatedSubtitle, setTranslatedSubtitle] = useState("");

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

  // ✅ 헤더는 “회차(큰 제목) + 번역된 부제목(작은 줄)”
  //    회차가 없으면 epLine은 빈 문자열
  const headerPreview = useMemo(() => {
    const epLine = episodeNo != null ? `제 ${episodeNo}화` : "";
    const subLine = translatedSubtitle.trim();
    return { epLine, subLine };
  }, [episodeNo, translatedSubtitle]);

  const percent =
    progress && progress.total ? Math.floor((progress.current / progress.total) * 100) : 0;

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

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredHistory.length / PAGE_SIZE)),
    [filteredHistory.length]
  );

  const pagedHistory = useMemo(() => {
    const start = (historyPage - 1) * PAGE_SIZE;
    return filteredHistory.slice(start, start + PAGE_SIZE);
  }, [filteredHistory, historyPage]);

  const selectedCount = useMemo(
    () => Object.values(selectedIds).filter(Boolean).length,
    [selectedIds]
  );

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
     ✅ 새로고침 유지: 세션 복원
  ========================= */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const s = loadSession();
    if (!s) return;

    if (typeof s.url === "string") setUrl(s.url);
    if (typeof s.manualOpen === "boolean") setManualOpen(s.manualOpen);

    if (typeof s.seriesTitle === "string") setSeriesTitle(s.seriesTitle || "");

    if (typeof s.episodeNo === "number") setEpisodeNo(Math.max(1, Math.floor(s.episodeNo)));
    else if (s.episodeNo === null) setEpisodeNo(null);
    if (typeof s.episodeHeader === "string") setEpisodeHeader(s.episodeHeader || "");

    if (typeof s.subtitle === "string") setSubtitle(s.subtitle || "");
    if (typeof s.translatedSubtitle === "string") setTranslatedSubtitle(s.translatedSubtitle || "");

    if (typeof s.source === "string") setSource(s.source);
    if (typeof s.resultBody === "string") setResultBody(s.resultBody);
    if (typeof s.showHeader === "boolean") setShowHeader(s.showHeader);

    if (typeof s.currentHistoryId === "string" || s.currentHistoryId === null)
      setCurrentHistoryId(s.currentHistoryId ?? null);
  }, []);

  // ✅ 세션 자동 저장
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const payload: AppSession = {
        url,
        manualOpen,
        seriesTitle,
        episodeNo,
        episodeHeader,
        subtitle,
        translatedSubtitle,
        source,
        resultBody,
        showHeader,
        currentHistoryId,
      };
      saveSession(payload);
    } catch {}
  }, [
    url,
    manualOpen,
    seriesTitle,
    episodeNo,
    episodeHeader,
    subtitle,
    translatedSubtitle,
    source,
    resultBody,
    showHeader,
    currentHistoryId,
  ]);

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

  function buildFolderTree(
    parentId: string | null,
    depth = 0
  ): Array<{ f: HistoryFolder; depth: number }> {
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

    const ok = confirm(
      `폴더 "${f.name}" 를 삭제할까요?\n하위 폴더/그 안의 항목도 함께 삭제됩니다.`
    );
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

    const nextFiltered =
      selectedFolderId === null
        ? next
        : next.filter((h) => (h.folderId || null) === selectedFolderId);
    const nextTotalPages = Math.max(1, Math.ceil(nextFiltered.length / PAGE_SIZE));
    setHistoryPage((p) => Math.min(p, nextTotalPages));

    if (currentHistoryId && ids.includes(currentHistoryId)) {
      setCurrentHistoryId(next[0]?.id ?? null);
      if (!next[0]) {
        setSource("");
        setResultBody("");
        setTranslatedSubtitle("");
        setSubtitle("");
        setEpisodeNo(null);
      }
    }

    disableSelectMode();
  }

  function loadHistoryItem(it: HistoryItem) {
    setSeriesTitle(it.seriesTitle || "");
    setEpisodeNo(it.episodeNo ?? null);
    setSubtitle(it.subtitle || "");
    setTranslatedSubtitle(it.translatedSubtitle || "");
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
    episodeNo: number | null;
    subtitle: string;
    translatedSubtitle: string;
    showHeader: boolean;
  }) {
    const item: HistoryItem = {
      id: uid(),
      createdAt: Date.now(),
      seriesTitle: params.seriesTitle.trim() || "", // ✅ 자동 기본값 금지
      episodeNo: params.episodeNo, // ✅ 없으면 null 유지
      subtitle: params.subtitle.trim(),
      translatedSubtitle: params.translatedSubtitle.trim(),
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
  async function runTranslation(
    rawText: string,
    opts?: { mode: "manual" | "url"; sourceUrl?: string }
  ) {
    if (!rawText.trim()) return;

    const mode = opts?.mode ?? "manual";

    setIsLoading(true);
    setError("");
    setResultBody("");
    setProgress(null);

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // ✅ 작업용 변수 (원문에서 추출 못하면 null 유지)
    let workingText = rawText;
    let nextEpisodeNo: number | null = null; // 🔥 임의 1화 생성 금지
    let nextSubtitle = "";
    let nextTranslatedSubtitle = "";

    // 추출 성공 여부 플래그
    let extractedEpisode = false;
    let extractedSubtitle = false;

    try {
      // ✅ Pixiv 프리셋: 수동 번역(읽기모드 복사)에서도 적용
      if (settings.pixivPresetEnabled) {
        const r = applyPixivPreset(workingText, !!settings.pixivStripMeta);
        if (r.cleanedText.trim()) workingText = r.cleanedText;

        if (typeof r.episodeNo === "number" && Number.isFinite(r.episodeNo)) {
          nextEpisodeNo = Math.max(1, Math.floor(r.episodeNo));
          extractedEpisode = true;
          setEpisodeNo(nextEpisodeNo);
        } else {
          nextEpisodeNo = null;
          extractedEpisode = false;
          setEpisodeNo(null);
        }

        if (typeof r.subtitle === "string" && r.subtitle.trim()) {
          nextSubtitle = r.subtitle.trim();
          extractedSubtitle = true;
          setSubtitle(nextSubtitle);

          // ✅ 부제목도 번역해서 표시용으로 저장
          try {
            const subKo = await translateChunk(nextSubtitle, controller.signal);
            nextTranslatedSubtitle = subKo.trim();
            setTranslatedSubtitle(nextTranslatedSubtitle);
          } catch {
            // 부제목 번역 실패해도 본문 번역은 진행
            nextTranslatedSubtitle = nextSubtitle;
            setTranslatedSubtitle(nextTranslatedSubtitle);
          }
        } else {
          extractedSubtitle = false;
          nextSubtitle = "";
          nextTranslatedSubtitle = "";
          setSubtitle("");
          setTranslatedSubtitle("");
        }
      } else {
        // 프리셋 OFF면 헤더 관련 값은 유지하지 않음
        setEpisodeNo(null);
        setSubtitle("");
        setTranslatedSubtitle("");
      }

      const chunks = chunkText(workingText, 4500);
      if (chunks.length > 80)
        throw new Error(`너무 길어서 자동 처리 부담이 큽니다. (분할 ${chunks.length}조각)`);

      setProgress({ current: 0, total: chunks.length });

      let out = "";
      for (let i = 0; i < chunks.length; i++) {
        setProgress({ current: i, total: chunks.length });
        const t = await translateChunk(chunks[i], controller.signal);
        out += (out ? "\n\n" : "") + t.trim();
      }

      setResultBody(out);
      setProgress({ current: chunks.length, total: chunks.length });

      // ✅ 헤더는 “프리셋 ON + (원문에서 회차/부제목을 실제로 뽑았을 때만)”
      const hasRealHeader =
        settings.pixivPresetEnabled && (extractedEpisode || (extractedSubtitle && !!nextTranslatedSubtitle.trim()));

      const nextShowHeader = hasRealHeader;
      setShowHeader(!!nextShowHeader);

      autoSaveToHistory({
        sourceText: rawText.trim(),
        translatedBody: out,
        url: opts?.sourceUrl,
        seriesTitle: seriesTitle.trim() || "", // ✅ 자동 기본값 금지
        episodeNo: extractedEpisode ? nextEpisodeNo : null,
        subtitle: extractedSubtitle ? nextSubtitle : "",
        translatedSubtitle: extractedSubtitle ? nextTranslatedSubtitle : "",
        showHeader: !!nextShowHeader,
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

      // title은 사이트 메타일 수 있어서, 자동으로 “헤더”에 쓰지 않음.
      // 필요하면 seriesTitle에만 반영(표시 여부는 별도).
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
     현재 설정 기반 배경 스타일
  ========================= */
  const appBg = hsl(settings.appBgH, settings.appBgS, settings.appBgL);
  const cardBg = hsl(settings.cardBgH, settings.cardBgS, settings.cardBgL);
  const textColor = hsl(settings.textH, settings.textS, settings.textL);

  // ✅ 공통 카드: “카드 1겹” 규칙
  const cardShellStyle: React.CSSProperties = {
    border: "1px solid rgba(0,0,0,0.18)",
    borderRadius: settings.viewerRadius,
    background: cardBg,
    padding: 14,
  };

  // ✅ 카드 안에 들어가는 입력요소: 테두리/배경 없음(레이아웃 고정)
  const innerInputBase: React.CSSProperties = {
    width: "100%",
    border: "none",
    outline: "none",
    background: "transparent",
    color: textColor,
    fontFamily: settings.fontFamily,
    fontSize: 15,
  };

  return (
    <div
      style={{
        minHeight: "100vh",
        background: appBg,
        color: textColor,
        position: "relative",
        fontFamily: settings.fontFamily,
      }}
    >
      {/* ✅ 페이지 전체 배경 패턴 (있을 때만) */}
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
              background: `linear-gradient(0deg, rgba(0,0,0,${
                settings.bgPatternBlend * 0.06
              }) 0%, rgba(0,0,0,0) 70%)`,
            }}
          />
        </>
      )}

      <main
        style={{
          maxWidth: 860,
          margin: "0 auto",
          padding: 24,
          paddingBottom: 86,
          position: "relative",
        }}
      >
        {/* 상단바 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            marginBottom: 14,
          }}
        >
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 900, margin: 0, color: textColor }}>
              Parody Translator
            </h1>
            <div style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>
              자동 저장: ☰ 목록에 시간순으로 쌓임
            </div>
          </div>

          {/* ✅ 히스토리 + 설정(아이콘) */}
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
              onClick={openSettings}
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

        {/* ✅ URL 입력 (카드 1겹 + input 무테/무배경) */}
        <div style={{ ...cardShellStyle, marginBottom: 12 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="URL 붙여넣기"
              style={{
                ...innerInputBase,
                flex: 1,
                padding: "10px 10px",
              }}
            />

            <button
              onClick={fetchFromUrl}
              disabled={isFetchingUrl || !url.trim()}
              style={{
                height: 40,
                padding: "0 12px",
                borderRadius: 10,
                border: "1px solid rgba(0,0,0,0.18)",
                cursor: isFetchingUrl || !url.trim() ? "not-allowed" : "pointer",
                fontWeight: 900,
                background: "#fff",
                opacity: isFetchingUrl || !url.trim() ? 0.6 : 1,
                whiteSpace: "nowrap",
              }}
            >
              {isFetchingUrl ? "불러오는 중…" : "본문 불러오기"}
            </button>
          </div>
        </div>

        {/* 텍스트 직접 번역 */}
        <details
          open={manualOpen}
          onToggle={(e) => setManualOpen((e.target as HTMLDetailsElement).open)}
          style={{ marginBottom: 12 }}
        >
          <summary style={{ cursor: "pointer", fontWeight: 900, opacity: 0.85 }}>
            텍스트 직접 번역
          </summary>

          {/* ✅ 직접 번역 카드 1겹 */}
          <div style={{ marginTop: 10, ...cardShellStyle }}>
            <textarea
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="원문을 직접 붙여넣기"
              style={{
                ...innerInputBase,
                height: 220,
                overflowY: "auto",
                resize: "none",
                padding: 10,
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
                  border: "1px solid rgba(0,0,0,0.18)",
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
                    border: "1px solid rgba(0,0,0,0.18)",
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

            {/* ✅ 프리셋 상태 표시(가볍게) */}
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
              Pixiv 프리셋: <b>{settings.pixivPresetEnabled ? "ON" : "OFF"}</b>
              {settings.pixivPresetEnabled
                ? " · 수동 번역에도 회차/부제목 정리 + 헤더 적용(원문에서 추출된 경우만)"
                : ""}
            </div>
          </div>
        </details>

        {error && (
          <div style={{ color: "#c00", marginTop: 8, fontWeight: 700, whiteSpace: "pre-wrap" }}>
            {error}
          </div>
        )}

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
              fontFamily: settings.fontFamily,
            }}
          >
            {!resultBody.trim() ? (
              <div style={{ opacity: 0.55 }}>번역 결과가 여기에 표시됩니다.</div>
            ) : (
              <>
                {showHeader && (
                  <>
                    {/* ✅ 큰 제목: 회차만 (없으면 표시 X) */}
                    {!!headerPreview.epLine && (
                      <div style={{ fontSize: 28, fontWeight: 900, marginBottom: 10 }}>
                        {headerPreview.epLine}
                      </div>
                    )}

                    {/* ✅ 작은 줄: 번역된 부제목만 (없으면 표시 X) */}
                    {headerPreview.subLine && (
                      <div style={{ fontSize: 14, opacity: 0.7, marginBottom: 28 }}>
                        {headerPreview.subLine}
                      </div>
                    )}
                  </>
                )}
                <div>{resultBody}</div>
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
                  <div style={{ fontSize: 18, fontWeight: 900 }}>설정</div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                    변경 후 <b>저장</b>을 눌러야 유지돼. {settingsDirty ? "· 변경됨" : "· 저장됨"}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    onClick={undoDraft}
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
                    되돌리기
                  </button>

                  <button
                    onClick={saveDraft}
                    disabled={!settingsDirty}
                    style={{
                      height: 36,
                      padding: "0 12px",
                      borderRadius: 10,
                      border: "1px solid rgba(0,0,0,0.18)",
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
              </div>

              {/* ✅ 프리셋 */}
              <details style={{ marginTop: 10 }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>프리셋</summary>

                <div style={{ marginTop: 10 }}>
                  <label style={{ display: "flex", gap: 10, alignItems: "center", fontWeight: 900 }}>
                    <input
                      type="checkbox"
                      checked={draftSettings.pixivPresetEnabled}
                      onChange={(e) => updateDraft({ pixivPresetEnabled: e.target.checked })}
                      style={{ width: 18, height: 18 }}
                    />
                    Pixiv 소설(읽기모드 복사) 정리 + 헤더 적용
                  </label>

                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                    ON이면 수동 번역에서도 회차/부제목을 추출하고, 결과 상단에{" "}
                    <b>제○화(큰 제목) + 번역된 부제목(작은 줄)</b>로 표시해.{" "}
                    <b>단, 원문에서 실제로 추출된 경우에만</b> 헤더가 생겨. <br />
                    또한 <b>Side / Side Fate / Side out</b>은 부제목 후보에서 제외해.
                  </div>

                  <div style={{ height: 10 }} />

                  <label style={{ display: "flex", gap: 10, alignItems: "center", fontWeight: 900 }}>
                    <input
                      type="checkbox"
                      checked={draftSettings.pixivStripMeta}
                      onChange={(e) => updateDraft({ pixivStripMeta: e.target.checked })}
                      style={{ width: 18, height: 18 }}
                      disabled={!draftSettings.pixivPresetEnabled}
                    />
                    날짜/시간/작가명 라인 제거
                  </label>

                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                    (권장) 읽기모드로 복사하면 상단에 날짜/시간이 붙는 경우가 많아서, 이 옵션이 있으면 더 깔끔해져.
                  </div>
                </div>
              </details>

              {/* ✅ 서식 편집 */}
              <details open style={{ marginTop: 14 }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>서식 편집</summary>

                <div style={{ marginTop: 10 }}>
                  {/* ✅ 폰트 선택 */}
                  <div style={{ fontWeight: 900, opacity: 0.85, marginTop: 6 }}>폰트</div>
                  <div style={{ marginTop: 8 }}>
                    <select
                      value={draftSettings.fontFamily}
                      onChange={(e) => updateDraft({ fontFamily: e.target.value })}
                      style={{
                        width: "100%",
                        height: 40,
                        borderRadius: 10,
                        border: "1px solid rgba(0,0,0,0.18)",
                        padding: "0 10px",
                        fontWeight: 800,
                      }}
                    >
                      <option
                        value={
                          'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif'
                        }
                      >
                        시스템(기본)
                      </option>
                      <option
                        value={
                          '"Noto Sans KR", system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif'
                        }
                      >
                        Noto Sans KR
                      </option>
                      <option value={'"Noto Serif KR", "Nanum Myeongjo", serif'}>
                        Noto Serif KR / 명조
                      </option>
                      <option
                        value={'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans KR", sans-serif'}
                      >
                        산세리프(가독)
                      </option>
                      <option value={'ui-serif, "Noto Serif KR", "Nanum Myeongjo", serif'}>
                        세리프(소설 느낌)
                      </option>
                      <option
                        value={'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'}
                      >
                        고정폭(모노)
                      </option>
                    </select>
                  </div>

                  {/* ✅ 미리보기 */}
                  <div style={{ fontWeight: 900, opacity: 0.85, marginTop: 12 }}>미리보기</div>
                  <div
                    style={{
                      marginTop: 8,
                      border: "1px solid rgba(0,0,0,0.18)",
                      borderRadius: draftSettings.viewerRadius,
                      padding: draftSettings.viewerPadding,
                      background: hsl(draftSettings.cardBgH, draftSettings.cardBgS, draftSettings.cardBgL),
                      color: hsl(draftSettings.textH, draftSettings.textS, draftSettings.textL),
                      lineHeight: draftSettings.lineHeight,
                      fontSize: draftSettings.fontSize,
                      fontFamily: draftSettings.fontFamily,
                    }}
                  >
                    <div style={{ fontWeight: 900, fontSize: 22 }}>제 1화</div>
                    <div style={{ opacity: 0.72, marginTop: 6 }}>번역된 부제목(있을 때만 표시)</div>
                    <div style={{ marginTop: 14, whiteSpace: "pre-wrap" }}>
                      비는 새벽부터 계속 내리고 있었다.
                      {"\n\n"}
                      폰트/글자크기/줄간격/여백/둥글기를 지금 값으로 확인할 수 있어.
                    </div>
                  </div>

                  <LabeledSlider
                    label="글자 크기"
                    value={draftSettings.fontSize}
                    min={12}
                    max={30}
                    onChange={(v) => updateDraft({ fontSize: v })}
                    suffix="px"
                  />
                  <LabeledSlider
                    label="줄간격"
                    value={draftSettings.lineHeight}
                    min={1.2}
                    max={2.4}
                    step={0.05}
                    onChange={(v) => updateDraft({ lineHeight: v })}
                  />
                  <LabeledSlider
                    label="결과 여백"
                    value={draftSettings.viewerPadding}
                    min={8}
                    max={42}
                    onChange={(v) => updateDraft({ viewerPadding: v })}
                    suffix="px"
                  />
                  <LabeledSlider
                    label="모서리 둥글기"
                    value={draftSettings.viewerRadius}
                    min={6}
                    max={28}
                    onChange={(v) => updateDraft({ viewerRadius: v })}
                    suffix="px"
                  />
                </div>
              </details>

              {/* ✅ 배경 편집 */}
              <details style={{ marginTop: 14 }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>배경 편집</summary>

                <div style={{ marginTop: 10 }}>
                  {/* ✅ 배경 미리보기: sticky */}
                  <div
                    style={{
                      position: "sticky",
                      top: 0,
                      zIndex: 2,
                      background: "#fff",
                      paddingBottom: 10,
                      marginBottom: 10,
                      borderBottom: "1px solid #eee",
                    }}
                  >
                    <div style={{ fontWeight: 900, opacity: 0.85 }}>미리보기</div>

                    <div
                      style={{
                        marginTop: 8,
                        border: "1px solid rgba(0,0,0,0.18)",
                        borderRadius: 14,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          position: "relative",
                          height: 260,
                          background: hsl(draftSettings.appBgH, draftSettings.appBgS, draftSettings.appBgL),
                        }}
                      >
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
                                background: `linear-gradient(0deg, rgba(0,0,0,${
                                  draftSettings.bgPatternBlend * 0.06
                                }) 0%, rgba(0,0,0,0) 70%)`,
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
                              fontFamily: draftSettings.fontFamily,
                            }}
                          >
                            <div style={{ fontWeight: 900 }}>배경 미리보기</div>
                            <div style={{ marginTop: 8, opacity: 0.8 }}>
                              페이지 배경 + 패턴 + 카드 배경이 이렇게 보일 거야.
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* 페이지 배경 */}
                  <div style={{ fontWeight: 900, opacity: 0.85, marginTop: 4 }}>페이지 배경 색상</div>
                  <LabeledSlider label="Hue" value={draftSettings.appBgH} min={0} max={360} onChange={(v) => updateDraft({ appBgH: v })} />
                  <LabeledSlider label="Saturation" value={draftSettings.appBgS} min={0} max={100} onChange={(v) => updateDraft({ appBgS: v })} />
                  <LabeledSlider label="Lightness" value={draftSettings.appBgL} min={0} max={100} onChange={(v) => updateDraft({ appBgL: v })} />

                  {/* 카드 배경 */}
                  <div style={{ fontWeight: 900, opacity: 0.85, marginTop: 14 }}>결과 카드 배경 색상</div>
                  <LabeledSlider label="Hue" value={draftSettings.cardBgH} min={0} max={360} onChange={(v) => updateDraft({ cardBgH: v })} />
                  <LabeledSlider label="Saturation" value={draftSettings.cardBgS} min={0} max={100} onChange={(v) => updateDraft({ cardBgS: v })} />
                  <LabeledSlider label="Lightness" value={draftSettings.cardBgL} min={0} max={100} onChange={(v) => updateDraft({ cardBgL: v })} />

                  {/* 글자 색 */}
                  <div style={{ fontWeight: 900, opacity: 0.85, marginTop: 14 }}>글자 색상</div>
                  <LabeledSlider label="Hue" value={draftSettings.textH} min={0} max={360} onChange={(v) => updateDraft({ textH: v })} />
                  <LabeledSlider label="Saturation" value={draftSettings.textS} min={0} max={100} onChange={(v) => updateDraft({ textS: v })} />
                  <LabeledSlider label="Lightness" value={draftSettings.textL} min={0} max={100} onChange={(v) => updateDraft({ textL: v })} />

                  {/* 패턴 */}
                  <div style={{ fontWeight: 900, opacity: 0.85, marginTop: 14 }}>빈티지 배경 무늬(선택)</div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
                    오래된 종이 같은 무늬를 쓰고 싶으면 패턴 이미지 URL을 넣어줘. (없으면 비워두면 됨)
                  </div>

                  <div style={{ marginTop: 8, display: "flex", gap: 8, alignItems: "center" }}>
                    <input
                      value={draftSettings.bgPatternUrl}
                      onChange={(e) => updateDraft({ bgPatternUrl: e.target.value })}
                      placeholder="배경 패턴 이미지 URL"
                      style={{ flex: 1, padding: 10, borderRadius: 10, border: "1px solid rgba(0,0,0,0.18)" }}
                    />
                    <button
                      onClick={() => updateDraft({ bgPatternUrl: "" })}
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

                  <LabeledSlider label="무늬 투명도" value={draftSettings.bgPatternOpacity} min={0} max={1} step={0.01} onChange={(v) => updateDraft({ bgPatternOpacity: v })} />
                  <LabeledSlider label="무늬 크기" value={draftSettings.bgPatternSize} min={120} max={1600} step={10} onChange={(v) => updateDraft({ bgPatternSize: v })} suffix="px" />
                  <LabeledSlider label="무늬 강조" value={draftSettings.bgPatternBlend} min={0} max={1} step={0.01} onChange={(v) => updateDraft({ bgPatternBlend: v })} />
                </div>
              </details>

              {/* ✅ Pixiv 쿠키 등록 */}
              <details style={{ marginTop: 14 }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>Pixiv 쿠키</summary>

                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>
                    Pixiv 본문 추출이 막히면, 여기 쿠키를 넣고 저장한 뒤 다시 시도해줘.
                  </div>

                  <textarea
                    value={draftSettings.pixivCookie}
                    onChange={(e) => updateDraft({ pixivCookie: e.target.value })}
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
                      onClick={() => updateDraft({ pixivCookie: "" })}
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
                border: "1px solid rgba(0,0,0,0.18)",
                padding: 14,
                position: "relative",
                color: "#111",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* 헤더 */}
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
                  <div style={{ fontSize: 18, fontWeight: 900 }}>목록</div>

                  {/* 상태줄 */}
                  <div
                    style={{
                      fontSize: 12,
                      opacity: 0.7,
                      marginTop: 4,
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      flexWrap: "wrap",
                    }}
                  >
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
                          border: "1px solid rgba(0,0,0,0.18)",
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
                    border: "1px solid rgba(0,0,0,0.18)",
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
                    border: "1px solid rgba(0,0,0,0.18)",
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
                          border: "1px solid rgba(0,0,0,0.18)",
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
                      const label = it.episodeNo != null ? `${it.episodeNo}화` : "회차 없음";
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
                            <div style={{ fontWeight: 900 }}>
                              {label}
                              {it.translatedSubtitle
                                ? ` · ${it.translatedSubtitle}`
                                : it.subtitle
                                ? ` · ${it.subtitle}`
                                : ""}
                            </div>
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
                              border: "1px solid rgba(0,0,0,0.18)",
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
                              border: "1px solid rgba(0,0,0,0.18)",
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
                        border: "1px solid rgba(0,0,0,0.18)",
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
                        border: "1px solid rgba(0,0,0,0.18)",
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
                    border: "1px solid rgba(0,0,0,0.18)",
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
                border: "1px solid rgba(0,0,0,0.18)",
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
                border: "1px solid rgba(0,0,0,0.18)",
                padding: 14,
                color: "#111",
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
                  <div style={{ fontSize: 18, fontWeight: 900 }}>어느 폴더로 옮길까?</div>
                  <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
                    선택된 항목: <b>{selectedCount}개</b> · 대상 폴더:{" "}
                    <b>{folderNameById(moveTargetFolderId)}</b>
                  </div>
                </div>

                <button
                  onClick={() => setMovePickerOpen(false)}
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

              <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 10 }}>
                <button
                  onClick={() => setMoveTargetFolderId(null)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "10px 10px",
                    borderRadius: 10,
                    border:
                      moveTargetFolderId === null
                        ? "2px solid #111"
                        : "1px solid rgba(0,0,0,0.18)",
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
                        border: active ? "2px solid #111" : "1px solid rgba(0,0,0,0.18)",
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
                    border: "1px solid rgba(0,0,0,0.18)",
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
                    border: "1px solid rgba(0,0,0,0.18)",
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
            borderTop: "1px solid rgba(0,0,0,0.18)",
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
