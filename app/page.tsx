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
  translatedText: string;
  url?: string;

  folderId?: string | null;
  showHeader?: boolean;
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
const SETTINGS_KEY = "parody_translator_settings_v2";

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
   ✅ 설정(배경/서식/쿠키) 모델
========================= */
type ThemePreset = "vintage" | "minimalLight" | "inkDark" | "nightReading";
type BackgroundType = "paper" | "solid" | "gradient" | "image";

type AppSettings = {
  preset: ThemePreset;
  backgroundType: BackgroundType;

  // 배경 색(HEX로 저장하되, UI는 HSL 레인지 슬라이더)
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
  lineHeight: number; // 1.3~2.4

  // ✅ Pixiv 쿠키
  pixivCookie: string;
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

  pixivCookie: "",
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

    const s: AppSettings = { ...DEFAULT_SETTINGS, ...parsed };

    s.paperGrain = clamp(Number(s.paperGrain ?? DEFAULT_SETTINGS.paperGrain), 0, 100);
    s.vignette = clamp(Number(s.vignette ?? DEFAULT_SETTINGS.vignette), 0, 100);
    s.warmth = clamp(Number(s.warmth ?? DEFAULT_SETTINGS.warmth), 0, 100);
    s.overlay = clamp(Number(s.overlay ?? DEFAULT_SETTINGS.overlay), 0, 100);
    s.fontSize = clamp(Number(s.fontSize ?? DEFAULT_SETTINGS.fontSize), 12, 28);
    s.lineHeight = clamp(Number(s.lineHeight ?? DEFAULT_SETTINGS.lineHeight), 1.3, 2.4);

    s.pixivCookie = String(s.pixivCookie ?? "");
    s.imageUrl = String(s.imageUrl ?? "");
    s.baseColor = String(s.baseColor ?? DEFAULT_SETTINGS.baseColor);
    s.gradientFrom = String(s.gradientFrom ?? DEFAULT_SETTINGS.gradientFrom);
    s.gradientTo = String(s.gradientTo ?? DEFAULT_SETTINGS.gradientTo);

    return s;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(s: AppSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

/* =========================
   ✅ HEX <-> HSL (슬라이더용)
========================= */
type HSL = { h: number; s: number; l: number };

function hexToRgb(hex: string) {
  const x = hex.replace("#", "").trim();
  if (x.length !== 6) return null;
  const r = parseInt(x.slice(0, 2), 16);
  const g = parseInt(x.slice(2, 4), 16);
  const b = parseInt(x.slice(4, 6), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return { r, g, b };
}

function rgbToHex(r: number, g: number, b: number) {
  const to = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}

function rgbToHsl(r: number, g: number, b: number): HSL {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;

  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case rr:
        h = ((gg - bb) / d) % 6;
        break;
      case gg:
        h = (bb - rr) / d + 2;
        break;
      case bb:
        h = (rr - gg) / d + 4;
        break;
    }
    h *= 60;
    if (h < 0) h += 360;
  }

  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToRgb(h: number, s: number, l: number) {
  const ss = clamp(s, 0, 100) / 100;
  const ll = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * ll - 1)) * ss;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = ll - c / 2;

  let rr = 0,
    gg = 0,
    bb = 0;
  const hh = ((h % 360) + 360) % 360;

  if (0 <= hh && hh < 60) [rr, gg, bb] = [c, x, 0];
  else if (60 <= hh && hh < 120) [rr, gg, bb] = [x, c, 0];
  else if (120 <= hh && hh < 180) [rr, gg, bb] = [0, c, x];
  else if (180 <= hh && hh < 240) [rr, gg, bb] = [0, x, c];
  else if (240 <= hh && hh < 300) [rr, gg, bb] = [x, 0, c];
  else [rr, gg, bb] = [c, 0, x];

  return {
    r: (rr + m) * 255,
    g: (gg + m) * 255,
    b: (bb + m) * 255,
  };
}

function hexToHslSafe(hex: string): HSL {
  const rgb = hexToRgb(hex);
  if (!rgb) return { h: 40, s: 35, l: 85 };
  return rgbToHsl(rgb.r, rgb.g, rgb.b);
}

function hslToHex(hsl: HSL) {
  const { r, g, b } = hslToRgb(hsl.h, hsl.s, hsl.l);
  return rgbToHex(r, g, b);
}

/* =========================
   ✅ 배경 스타일 계산
========================= */
function withWarmth(colorHex: string, warmth: number) {
  const w = clamp(warmth, 0, 100) / 100;
  const rgb = hexToRgb(colorHex);
  if (!rgb) return colorHex;

  const rr = clamp(Math.round(rgb.r + 25 * w), 0, 255);
  const gg = clamp(Math.round(rgb.g + 10 * w), 0, 255);
  const bb = clamp(Math.round(rgb.b - 25 * w), 0, 255);
  return rgbToHex(rr, gg, bb);
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
  return {
    boxShadow: v ? `inset 0 0 ${Math.round(240 * v)}px rgba(0,0,0,${0.30 * v})` : "none",
  } as React.CSSProperties;
}

/* =========================
   ✅ HSL 슬라이더 컴포넌트
========================= */
function ColorRangeEditor(props: {
  title: string;
  hexValue: string;
  onChangeHex: (nextHex: string) => void;
}) {
  const hsl = useMemo(() => hexToHslSafe(props.hexValue), [props.hexValue]);

  return (
    <div style={{ display: "grid", gap: 10, border: "1px solid rgba(0,0,0,0.10)", borderRadius: 12, padding: 10, background: "#fff" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center" }}>
        <div style={{ fontWeight: 900 }}>{props.title}</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ width: 18, height: 18, borderRadius: 6, border: "1px solid rgba(0,0,0,0.20)", background: props.hexValue }} />
          <div style={{ fontSize: 12, opacity: 0.75 }}>{props.hexValue}</div>
        </div>
      </div>

      <label style={{ display: "grid", gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 900, opacity: 0.75 }}>H (색상)</span>
          <span style={{ fontSize: 12, opacity: 0.7 }}>{hsl.h}</span>
        </div>
        <input
          type="range"
          min={0}
          max={359}
          value={hsl.h}
          onChange={(e) => props.onChangeHex(hslToHex({ ...hsl, h: Number(e.target.value) }))}
        />
      </label>

      <label style={{ display: "grid", gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 900, opacity: 0.75 }}>S (채도)</span>
          <span style={{ fontSize: 12, opacity: 0.7 }}>{hsl.s}</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={hsl.s}
          onChange={(e) => props.onChangeHex(hslToHex({ ...hsl, s: Number(e.target.value) }))}
        />
      </label>

      <label style={{ display: "grid", gap: 6 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontWeight: 900, opacity: 0.75 }}>L (밝기)</span>
          <span style={{ fontSize: 12, opacity: 0.7 }}>{hsl.l}</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={hsl.l}
          onChange={(e) => props.onChangeHex(hslToHex({ ...hsl, l: Number(e.target.value) }))}
        />
      </label>
    </div>
  );
}

/* =========================
   Page
========================= */
export default function Page() {
  /* =========================
     ✅ Settings (즉시 반영 X: draft -> 저장 버튼으로 apply)
  ========================= */
  const [settingsOpen, setSettingsOpen] = useState(false);

  // ✅ 실제 적용되는 설정(배경/서식에 사용)
  const [settingsApplied, setSettingsApplied] = useState<AppSettings>(() => {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    return loadSettings();
  });

  // ✅ 모달에서 편집하는 임시 설정
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(settingsApplied);

  const [settingsDirty, setSettingsDirty] = useState(false);

  function openSettings() {
    setSettingsDraft(settingsApplied);
    setSettingsDirty(false);
    setSettingsOpen(true);
  }

  function closeSettingsDiscard() {
    setSettingsDraft(settingsApplied);
    setSettingsDirty(false);
    setSettingsOpen(false);
  }

  function updateDraft(patch: Partial<AppSettings>) {
    setSettingsDraft((prev) => {
      const next: AppSettings = { ...prev, ...patch };

      next.paperGrain = clamp(Number(next.paperGrain), 0, 100);
      next.vignette = clamp(Number(next.vignette), 0, 100);
      next.warmth = clamp(Number(next.warmth), 0, 100);
      next.overlay = clamp(Number(next.overlay), 0, 100);
      next.fontSize = clamp(Number(next.fontSize), 12, 28);
      next.lineHeight = clamp(Number(next.lineHeight), 1.3, 2.4);

      next.pixivCookie = String(next.pixivCookie ?? "");
      next.imageUrl = String(next.imageUrl ?? "");
      next.baseColor = String(next.baseColor ?? DEFAULT_SETTINGS.baseColor);
      next.gradientFrom = String(next.gradientFrom ?? DEFAULT_SETTINGS.gradientFrom);
      next.gradientTo = String(next.gradientTo ?? DEFAULT_SETTINGS.gradientTo);

      return next;
    });
    setSettingsDirty(true);
  }

  function saveDraftToApplied() {
    const next = settingsDraft;
    setSettingsApplied(next);
    try {
      saveSettings(next);
    } catch {}
    setSettingsDirty(false);
    setSettingsOpen(false);
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

  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);

  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<{ right: number; bottom: number } | null>(null);

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});

  const [movePickerOpen, setMovePickerOpen] = useState(false);
  const [moveTargetFolderId, setMoveTargetFolderId] = useState<string | null>(null);

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
     ✅ Pixiv 쿠키를 설정에서 받아서 함께 전달
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
          cookie: settingsApplied.pixivCookie || "",
        }),
      });

      const data: any = await safeReadJson(res);

      if (!res.ok) {
        const msg = data?.error || data?.message || "본문 불러오기 실패";
        throw new Error(String(msg));
      }

      if (data?.__notJson) {
        throw new Error(
          "본문을 JSON으로 받지 못했어요. Pixiv는 로그인/봇 차단 때문에 서버에서 본문 추출이 실패할 수 있어요.\n(쿠키 설정을 확인하거나, 텍스트 직접 붙여넣기로 먼저 확인해줘)"
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

  function openMenuFromButton(e: React.MouseEvent<HTMLButtonElement>) {
    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
    const right = Math.max(12, window.innerWidth - rect.right);
    const bottom = Math.max(12, window.innerHeight - rect.top);
    setMenuAnchor({ right, bottom });
    setMenuOpen(true);
  }

  /* =========================
     ✅ 배경/뷰어 스타일 적용 (Applied 기준)
  ========================= */
  const bgCss = useMemo(() => buildBackgroundCss(settingsApplied), [settingsApplied]);
  const vignetteCss = useMemo(() => buildVignetteStyle(settingsApplied.vignette), [settingsApplied.vignette]);

  const isDarkBg = useMemo(() => {
    const c = settingsApplied.baseColor.replace("#", "");
    if (c.length !== 6) return false;
    const r = parseInt(c.slice(0, 2), 16);
    const g = parseInt(c.slice(2, 4), 16);
    const b = parseInt(c.slice(4, 6), 16);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luma < 80;
  }, [settingsApplied.baseColor]);

  const textColor = isDarkBg ? "#F3F3F3" : "#151515";
  const mutedColor = isDarkBg ? "rgba(243,243,243,0.65)" : "rgba(0,0,0,0.55)";
  const cardBg = isDarkBg ? "rgba(20,20,20,0.75)" : "rgba(255,255,255,0.78)";
  const cardBorder = isDarkBg ? "1px solid rgba(255,255,255,0.10)" : "1px solid rgba(0,0,0,0.10)";

  /* =========================
     설정 미리보기(모달 안)도 Draft 기반으로 별도 계산
  ========================= */
  const previewBgCss = useMemo(() => buildBackgroundCss(settingsDraft), [settingsDraft]);
  const previewVignetteCss = useMemo(() => buildVignetteStyle(settingsDraft.vignette), [settingsDraft.vignette]);

  return (
    <div style={{ minHeight: "100vh", position: "relative", ...bgCss }}>
      <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none", ...vignetteCss }} />

      <main style={{ maxWidth: 860, margin: "0 auto", padding: 24, paddingBottom: 86, position: "relative", color: textColor }}>
        {/* 상단바 */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <div>
            <h1 style={{ fontSize: 28, fontWeight: 900, margin: 0 }}>Parody Translator</h1>
            <div style={{ fontSize: 13, opacity: 0.85, marginTop: 6, color: mutedColor }}>자동 저장: ☰ 목록에 시간순으로 쌓임</div>
          </div>

          {/* 히스토리 + 설정 */}
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
              onClick={openSettings}
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

        {error && <div style={{ color: "#FF4D4D", marginTop: 8, fontWeight: 700, whiteSpace: "pre-wrap" }}>{error}</div>}

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
              lineHeight: settingsApplied.lineHeight,
              fontSize: settingsApplied.fontSize,
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
            onClick={() => {
              // 바깥 클릭 = 취소(폐기)
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
                border: "1px solid rgba(0,0,0,0.12)",
                padding: 14,
                color: "#111",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 900 }}>설정</div>
                  <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                    변경사항은 <b>저장</b>을 눌러야 적용돼. {settingsDirty ? "· (변경됨)" : ""}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    onClick={closeSettingsDiscard}
                    style={{
                      height: 36,
                      padding: "0 12px",
                      borderRadius: 10,
                      border: "1px solid rgba(0,0,0,0.15)",
                      cursor: "pointer",
                      fontWeight: 900,
                      background: "#fff",
                    }}
                    title="변경 취소"
                  >
                    취소
                  </button>

                  <button
                    onClick={saveDraftToApplied}
                    disabled={!settingsDirty}
                    style={{
                      height: 36,
                      padding: "0 12px",
                      borderRadius: 10,
                      border: "1px solid rgba(0,0,0,0.15)",
                      cursor: settingsDirty ? "pointer" : "not-allowed",
                      fontWeight: 900,
                      background: settingsDirty ? "#111" : "#eee",
                      color: settingsDirty ? "#fff" : "#999",
                      opacity: settingsDirty ? 1 : 0.9,
                    }}
                    title="저장(적용)"
                  >
                    저장
                  </button>
                </div>
              </div>

              {/* ✅ 배경 편집 */}
              <details open style={{ border: "1px solid rgba(0,0,0,0.10)", borderRadius: 14, padding: 12, background: "#FAFAFA" }}>
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
                        const active = settingsDraft.preset === (p.key as ThemePreset);
                        return (
                          <button
                            key={p.key}
                            onClick={() => {
                              const patch = applyPreset(p.key as ThemePreset);
                              updateDraft(patch);
                            }}
                            style={{
                              height: 34,
                              padding: "0 12px",
                              borderRadius: 999,
                              border: "1px solid rgba(0,0,0,0.15)",
                              cursor: "pointer",
                              fontWeight: 900,
                              background: active ? "#111" : "#fff",
                              color: active ? "#fff" : "#111",
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
                        const active = settingsDraft.backgroundType === (t.key as BackgroundType);
                        return (
                          <button
                            key={t.key}
                            onClick={() => updateDraft({ backgroundType: t.key as BackgroundType })}
                            style={{
                              height: 34,
                              padding: "0 12px",
                              borderRadius: 999,
                              border: "1px solid rgba(0,0,0,0.15)",
                              cursor: "pointer",
                              fontWeight: 900,
                              background: active ? "#111" : "#fff",
                              color: active ? "#fff" : "#111",
                            }}
                          >
                            {t.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* 색상 레인지 */}
                  {(settingsDraft.backgroundType === "solid" || settingsDraft.backgroundType === "paper") && (
                    <ColorRangeEditor
                      title="바탕색"
                      hexValue={settingsDraft.baseColor}
                      onChangeHex={(hex) => updateDraft({ baseColor: hex })}
                    />
                  )}

                  {settingsDraft.backgroundType === "gradient" && (
                    <div style={{ display: "grid", gap: 10 }}>
                      <ColorRangeEditor
                        title="그라데이션 시작"
                        hexValue={settingsDraft.gradientFrom}
                        onChangeHex={(hex) => updateDraft({ gradientFrom: hex })}
                      />
                      <ColorRangeEditor
                        title="그라데이션 끝"
                        hexValue={settingsDraft.gradientTo}
                        onChangeHex={(hex) => updateDraft({ gradientTo: hex })}
                      />
                    </div>
                  )}

                  {settingsDraft.backgroundType === "image" && (
                    <div style={{ display: "grid", gap: 8 }}>
                      <div style={{ fontWeight: 900, opacity: 0.85 }}>배경 이미지 URL</div>
                      <input
                        value={settingsDraft.imageUrl}
                        onChange={(e) => updateDraft({ imageUrl: e.target.value })}
                        placeholder='예) https://.../paper.jpg'
                        style={{
                          width: "100%",
                          padding: "10px 12px",
                          borderRadius: 10,
                          border: "1px solid rgba(0,0,0,0.15)",
                          background: "#fff",
                          color: "#111",
                          outline: "none",
                        }}
                      />
                      <div style={{ fontSize: 12, opacity: 0.75 }}>
                        사이트가 CORS/403을 걸면 이미지가 안 뜰 수 있어. 그땐 다른 이미지 주소를 쓰거나 종이/단색으로 바꿔줘.
                      </div>
                    </div>
                  )}

                  {/* 종이 느낌/가독성 */}
                  <div style={{ display: "grid", gap: 10 }}>
                    <div style={{ fontWeight: 900, opacity: 0.85 }}>종이 느낌 / 가독성</div>

                    <div style={{ display: "grid", gap: 10 }}>
                      <label style={{ display: "grid", gap: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontWeight: 900, opacity: 0.8 }}>종이결</span>
                          <span style={{ fontSize: 12, opacity: 0.75 }}>{settingsDraft.paperGrain}</span>
                        </div>
                        <input type="range" min={0} max={100} value={settingsDraft.paperGrain} onChange={(e) => updateDraft({ paperGrain: Number(e.target.value) })} />
                      </label>

                      <label style={{ display: "grid", gap: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontWeight: 900, opacity: 0.8 }}>비네팅</span>
                          <span style={{ fontSize: 12, opacity: 0.75 }}>{settingsDraft.vignette}</span>
                        </div>
                        <input type="range" min={0} max={100} value={settingsDraft.vignette} onChange={(e) => updateDraft({ vignette: Number(e.target.value) })} />
                      </label>

                      <label style={{ display: "grid", gap: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontWeight: 900, opacity: 0.8 }}>따뜻함(세피아)</span>
                          <span style={{ fontSize: 12, opacity: 0.75 }}>{settingsDraft.warmth}</span>
                        </div>
                        <input type="range" min={0} max={100} value={settingsDraft.warmth} onChange={(e) => updateDraft({ warmth: Number(e.target.value) })} />
                      </label>

                      <label style={{ display: "grid", gap: 6 }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontWeight: 900, opacity: 0.8 }}>가독성 오버레이</span>
                          <span style={{ fontSize: 12, opacity: 0.75 }}>{settingsDraft.overlay}</span>
                        </div>
                        <input type="range" min={0} max={100} value={settingsDraft.overlay} onChange={(e) => updateDraft({ overlay: Number(e.target.value) })} />
                      </label>
                    </div>
                  </div>
                </div>
              </details>

              {/* ✅ 서식 편집 (미리보기 포함) */}
              <details style={{ marginTop: 12, border: "1px solid rgba(0,0,0,0.10)", borderRadius: 14, padding: 12, background: "#FAFAFA" }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>서식 편집</summary>

                <div style={{ marginTop: 12, display: "grid", gap: 12 }}>
                  <label style={{ display: "grid", gap: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontWeight: 900, opacity: 0.8 }}>글자 크기</span>
                      <span style={{ fontSize: 12, opacity: 0.75 }}>{settingsDraft.fontSize}px</span>
                    </div>
                    <input type="range" min={12} max={28} value={settingsDraft.fontSize} onChange={(e) => updateDraft({ fontSize: Number(e.target.value) })} />
                  </label>

                  <label style={{ display: "grid", gap: 6 }}>
                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                      <span style={{ fontWeight: 900, opacity: 0.8 }}>줄간격</span>
                      <span style={{ fontSize: 12, opacity: 0.75 }}>{settingsDraft.lineHeight.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min={1.3}
                      max={2.4}
                      step={0.01}
                      value={settingsDraft.lineHeight}
                      onChange={(e) => updateDraft({ lineHeight: Number(e.target.value) })}
                    />
                  </label>

                  {/* ✅ 미리보기(서식 전용 느낌이라 여기로 이동) */}
                  <div>
                    <div style={{ fontWeight: 900, opacity: 0.85, marginBottom: 8 }}>미리보기</div>

                    <div style={{ border: "1px solid rgba(0,0,0,0.10)", borderRadius: 14, padding: 12, background: "#fff", position: "relative", overflow: "hidden" }}>
                      <div style={{ position: "absolute", inset: 0, ...previewBgCss }} />
                      <div aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none", ...previewVignetteCss }} />

                      <div style={{ position: "relative", border: "1px solid rgba(0,0,0,0.12)", borderRadius: 14, padding: 16, background: "rgba(255,255,255,0.78)" }}>
                        <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 8 }}>패러디 소설 제목</div>
                        <div style={{ fontSize: 13, opacity: 0.75, marginBottom: 18 }}>제 1화 · 부제목 예시</div>
                        <div style={{ fontSize: settingsDraft.fontSize, lineHeight: settingsDraft.lineHeight }}>
                          이건 미리보기 문장이다. 글자 크기/줄간격/배경을 바꾸면 여기서 바로 느낌이 보여야 한다.
                          <br />
                          <br />
                          실제 적용은 저장 버튼을 눌렀을 때만 된다.
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </details>

              {/* ✅ Pixiv 쿠키 등록 */}
              <details style={{ marginTop: 12, border: "1px solid rgba(0,0,0,0.10)", borderRadius: 14, padding: 12, background: "#FAFAFA" }}>
                <summary style={{ cursor: "pointer", fontWeight: 900 }}>Pixiv 쿠키</summary>

                <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                  <div style={{ fontSize: 12, opacity: 0.75 }}>
                    쿠키는 이 브라우저(이 기기)에 저장돼. 공용 PC에서는 비추천.
                  </div>

                  <textarea
                    value={settingsDraft.pixivCookie}
                    onChange={(e) => updateDraft({ pixivCookie: e.target.value })}
                    placeholder="여기에 Pixiv 쿠키 문자열을 붙여넣기 (예: PHPSESSID=...; device_token=...; ...)"
                    style={{
                      width: "100%",
                      minHeight: 120,
                      padding: 12,
                      borderRadius: 10,
                      border: "1px solid rgba(0,0,0,0.15)",
                      background: "#fff",
                      outline: "none",
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                      fontSize: 12,
                      whiteSpace: "pre-wrap",
                    }}
                  />

                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(settingsDraft.pixivCookie || "");
                          alert("쿠키가 복사되었습니다.");
                        } catch {
                          alert("복사 실패(브라우저 권한 확인)");
                        }
                      }}
                      style={{
                        height: 36,
                        padding: "0 12px",
                        borderRadius: 10,
                        border: "1px solid rgba(0,0,0,0.15)",
                        cursor: "pointer",
                        fontWeight: 900,
                        background: "#fff",
                      }}
                    >
                      쿠키 복사
                    </button>

                    <button
                      onClick={() => updateDraft({ pixivCookie: "" })}
                      style={{
                        height: 36,
                        padding: "0 12px",
                        borderRadius: 10,
                        border: "1px solid rgba(0,0,0,0.15)",
                        cursor: "pointer",
                        fontWeight: 900,
                        background: "#fff",
                      }}
                      title="입력값만 지움(저장해야 반영)"
                    >
                      지우기
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
                border: "1px solid #ddd",
                padding: 14,
                position: "relative",
              }}
              onClick={(e) => e.stopPropagation()}
            >
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

        {/* Bottom Nav */}
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
