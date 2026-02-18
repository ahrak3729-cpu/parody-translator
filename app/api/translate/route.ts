// app/api/translate/route.ts

import { NextResponse } from "next/server";
import { TRANSLATION_SYSTEM_PROMPT, buildUserPrompt } from "../../../lib/translationPrompt";

/** ✅ 대사 위/아래 빈 줄 강제 */
function normalizeDialogueSpacing(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  const isDialogueLine = (s: string) => {
    const t = s.trim();
    return t.startsWith('"') || t.startsWith("「") || t.startsWith("『");
  };

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i] ?? "";
    const t = cur.trimEnd();

    if (isDialogueLine(t)) {
      if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
      out.push(t);
      if (i < lines.length - 1 && (lines[i + 1] ?? "").trim() !== "") out.push("");
    } else {
      out.push(cur);
    }
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** ✅ “문장 끝 공백 1칸” 강제 */
function ensureTrailingSpacePerLine(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  return lines
    .map((l) => {
      if (l.trim() === "") return "";
      return l.endsWith(" ") ? l : l + " ";
    })
    .join("\n");
}

/** ✅ 원문 상단에서 회차 표식 추출: "#1/#01" 또는 "第1話" */
function extractLeadingEpisodeMarker(source: string) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const t = (lines[i] ?? "").trim();
    if (!t) continue;

    const mHash = t.match(/^#(\d{1,4})$/); // #1, #01
    if (mHash) return { kind: "hash" as const, n: parseInt(mHash[1], 10), raw: t };

    const mJp = t.match(/^第\s*(\d+)\s*話$/); // 第1話
    if (mJp) return { kind: "jp" as const, n: parseInt(mJp[1], 10), raw: t };

    break; // 첫 의미있는 줄이 회차가 아니면 중단
  }
  return null;
}

/** ✅ 번역 결과에서 회차 라인 판별 */
function parseEpisodeHeaderLine(line: string) {
  const t = line.trim();
  if (!t) return null;

  const mHash = t.match(/^#(\d{1,4})$/);
  if (mHash) return { kind: "hash" as const, n: parseInt(mHash[1], 10), raw: t };

  const mKo = t.match(/^제\s*(\d+)\s*화$/);
  if (mKo) return { kind: "ko" as const, n: parseInt(mKo[1], 10), raw: t };

  const mJp = t.match(/^第\s*(\d+)\s*話$/);
  if (mJp) return { kind: "jp" as const, n: parseInt(mJp[1], 10), raw: t };

  const mBare = t.match(/^(\d+)\s*화$/);
  if (mBare) return { kind: "bare" as const, n: parseInt(mBare[1], 10), raw: t };

  return null;
}

function toKoreanEpisodeHeader(n: number) {
  return `제 ${n}화`;
}

/**
 * ✅ 핵심 후처리(너가 원하는 규칙 그대로)
 * - 원문이 "#1/#01"이면: 번역 결과 상단의 회차는 반드시 "#1/#01" 그대로 유지
 *   + 모델이 "제 1화"를 추가로 만들어도 같은 숫자면 제거(중복 방지)
 * - 원문이 "第1話"이면: 번역 결과 상단 회차는 "제 1화"로 통일
 *   + 중복 회차(제 1화가 두 번 등) 제거
 */
function normalizeEpisodeBySource(source: string, translated: string) {
  const src = extractLeadingEpisodeMarker(source);
  if (!src || !Number.isFinite(src.n)) return translated;

  const lines = translated.replace(/\r\n/g, "\n").split("\n");

  // 상단 공백 스킵
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;

  // 상단에서 회차 라인을 최대 3개까지 수집(중복 제거용)
  const idxs: number[] = [];
  for (let k = i; k < Math.min(lines.length, i + 5); k++) {
    const p = parseEpisodeHeaderLine(lines[k] ?? "");
    if (p && p.n === src.n) idxs.push(k);
  }

  // --- CASE A: 원문이 #1/#01 => 결과도 첫 회차는 반드시 "#1/#01" ---
  if (src.kind === "hash") {
    // 1) 첫 의미있는 줄이 회차면 "#..."로 강제
    const firstParsed = i < lines.length ? parseEpisodeHeaderLine(lines[i]) : null;
    if (firstParsed && firstParsed.n === src.n) {
      if (lines[i].trim() !== src.raw) lines[i] = src.raw;
    } else {
      // 첫 줄이 회차가 아니면 맨 위에 삽입(원문이 회차로 시작했는데 모델이 날린 케이스 대비)
      lines.splice(i, 0, src.raw);
    }

    // 2) 같은 숫자의 다른 회차 표식("제 1화"/"第1話"/"1화"/또는 중복 "#1") 제거
    //    단, 첫 줄(#...)은 남기고 그 아래 동일 회차 라인들 삭제
    let removed = 0;
    for (let k = i + 1; k < Math.min(lines.length, i + 8); k++) {
      const p = parseEpisodeHeaderLine(lines[k] ?? "");
      if (p && p.n === src.n) {
        // 중복 삭제
        lines.splice(k, 1);
        k--;
        removed++;
        if (removed >= 3) break;
      }
    }

    return lines.join("\n").trimStart();
  }

  // --- CASE B: 원문이 第1話 => 결과 상단을 "제 1화"로 통일 ---
  if (src.kind === "jp") {
    const target = toKoreanEpisodeHeader(src.n);

    // 첫 의미있는 줄이 회차면 표준화
    const firstParsed = i < lines.length ? parseEpisodeHeaderLine(lines[i]) : null;
    if (firstParsed && firstParsed.n === src.n) {
      if (lines[i].trim() !== target) lines[i] = target;
    } else {
      // 원문이 회차로 시작했는데 모델이 날린 경우 대비
      lines.splice(i, 0, target);
    }

    // 중복 회차 제거(같은 숫자)
    let removed = 0;
    for (let k = i + 1; k < Math.min(lines.length, i + 8); k++) {
      const p = parseEpisodeHeaderLine(lines[k] ?? "");
      if (p && p.n === src.n) {
        lines.splice(k, 1);
        k--;
        removed++;
        if (removed >= 3) break;
      }
    }

    return lines.join("\n").trimStart();
  }

  return translated;
}

/** ✅ 헤더(회차/부제목)와 본문 사이 간격 넓히기: 빈 줄 2개 보장 */
function widenHeaderToBodyGap(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  const isHeaderLike = (line: string) => {
    const t = line.trim();
    if (!t) return false;

    // 회차 라인
    if (parseEpisodeHeaderLine(t)) return true;

    // 부제목 후보: 짧고 종결부호로 끝나지 않으면 헤더 취급
    if (t.length <= 40 && !/[。.!?]$/.test(t)) return true;

    return false;
  };

  // 상단 공백 스킵
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;

  // 헤더 블록(최대 6라인) 끝 찾기
  let end = i;
  let headerCount = 0;
  while (end < lines.length && headerCount < 6) {
    const t = (lines[end] ?? "").trim();
    if (t === "") {
      end++;
      continue;
    }
    if (isHeaderLike(lines[end])) {
      headerCount++;
      end++;
      continue;
    }
    break;
  }

  if (headerCount === 0 || end >= lines.length) return text;

  // 헤더 끝 직전의 공백은 제거
  while (end > 0 && lines[end - 1].trim() === "") {
    lines.splice(end - 1, 1);
    end--;
  }

  // 본문 앞에 빈 줄 2개(간격 확실히 넓힘)
  lines.splice(end, 0, "", "");

  return lines.join("\n").replace(/\n{5,}/g, "\n\n\n\n").trimEnd();
}

export async function POST(req: Request) {
  try {
    const { text } = await req.json();
    const input = String(text ?? "");
    if (!input.trim()) return NextResponse.json({ translated: "" });

    const openaiRes = await fetch(
      process.env.OPENAI_API_URL ?? "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
          temperature: 0.1, // ✅ 번역 흔들림 줄이기(오류 체감 줄어듦)
          messages: [
            { role: "system", content: TRANSLATION_SYSTEM_PROMPT },
            { role: "user", content: buildUserPrompt(input) },
          ],
        }),
      }
    );

    if (!openaiRes.ok) {
      const raw = await openaiRes.text().catch(() => "");
      return NextResponse.json(
        { error: `OpenAI error: ${openaiRes.status} ${openaiRes.statusText}\n${raw}` },
        { status: 500 }
      );
    }

    const data = await openaiRes.json();
    let translated =
      data?.choices?.[0]?.message?.content ??
      data?.output_text ??
      "";

    translated = String(translated ?? "");

    // ✅ 1) 회차 표식 규칙 적용 + 중복 제거
    translated = normalizeEpisodeBySource(input, translated);

    // ✅ 2) 서식 후처리
    translated = normalizeDialogueSpacing(translated);
    translated = widenHeaderToBodyGap(translated);
    translated = ensureTrailingSpacePerLine(translated);

    return NextResponse.json({ translated });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "translate failed" }, { status: 500 });
  }
}
