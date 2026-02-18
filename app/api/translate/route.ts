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

/** ✅ 원문 상단 회차 표식 추출: "#1/#01", "第1話", "제 1화" */
function extractLeadingEpisodeMarker(source: string) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const t = (lines[i] ?? "").trim();
    if (!t) continue;

    // "#1" "#01"
    const mHash = t.match(/^#(\d{1,4})$/);
    if (mHash) return { kind: "hash" as const, n: parseInt(mHash[1], 10), raw: t };

    // "第1話"
    const mJp = t.match(/^第\s*(\d+)\s*話$/);
    if (mJp) return { kind: "jp" as const, n: parseInt(mJp[1], 10), raw: t };

    // "제 1화"
    const mKo = t.match(/^제\s*(\d+)\s*화$/);
    if (mKo) return { kind: "ko" as const, n: parseInt(mKo[1], 10), raw: t };

    // 첫 의미있는 줄이 회차가 아니면 중단
    break;
  }
  return null;
}

function toKoreanEpisodeHeader(n: number) {
  return `제 ${n}화`;
}

/** ✅ "제 N화" / "第N話" / "#N" 라인 판별 */
function parseEpisodeHeaderLine(line: string) {
  const t = line.trim();
  if (!t) return null;

  const mKo = t.match(/^제\s*(\d+)\s*화$/);
  if (mKo) return { kind: "ko" as const, n: parseInt(mKo[1], 10), raw: t };

  const mJp = t.match(/^第\s*(\d+)\s*話$/);
  if (mJp) return { kind: "jp" as const, n: parseInt(mJp[1], 10), raw: t };

  const mHash = t.match(/^#(\d{1,4})$/);
  if (mHash) return { kind: "hash" as const, n: parseInt(mHash[1], 10), raw: t };

  const mBare = t.match(/^(\d+)\s*화$/);
  if (mBare) return { kind: "bare" as const, n: parseInt(mBare[1], 10), raw: t };

  return null;
}

/**
 * ✅ 핵심 후처리:
 * - 원문이 "#1/#01"이면 결과 상단 회차는 "제 1화"로 통일
 * - 결과에 "#1"과 "제 1화"가 같이 있으면 "#1" 제거(중복 방지)
 * - 원문이 第1話/제1화여도 결과는 "제 1화"로 유지(중복 제거만)
 */
function normalizeEpisodeHeaderBySource(source: string, translated: string) {
  const src = extractLeadingEpisodeMarker(source);
  if (!src || !Number.isFinite(src.n)) return translated;

  const targetHeader = toKoreanEpisodeHeader(src.n);

  const lines = translated.replace(/\r\n/g, "\n").split("\n");

  // 상단 공백 스킵
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;

  // 상단 1~4줄 정도에서 회차 라인들을 모아서 중복 정리
  // 케이스:
  // 1) ["제 1화", "#1", ...] -> "#1" 제거
  // 2) ["#1", "제 1화", ...] -> "#1" 제거 + "제 1화" 유지
  // 3) ["#1", ...] -> "#1"을 "제 1화"로 치환
  // 4) ["第1話", ...] -> "제 1화"로 치환

  // 첫 회차 라인 찾기
  const first = i < lines.length ? parseEpisodeHeaderLine(lines[i]) : null;
  const second = i + 1 < lines.length ? parseEpisodeHeaderLine(lines[i + 1]) : null;

  // (A) 첫 줄이 회차면 표준화
  if (first && first.n === src.n) {
    // "#1" or "第1話" or "1화" -> "제 1화"
    if (lines[i].trim() !== targetHeader) {
      lines[i] = targetHeader;
    }

    // (B) 다음 줄이 같은 회차를 또 가지고 있으면 제거
    if (second && second.n === src.n) {
      // 두 번째가 "#1" 같은 중복이면 제거
      lines.splice(i + 1, 1);
      // 뒤 공백 정리(최대 2개)
      let k = i + 1;
      let removed = 0;
      while (k < lines.length && lines[k].trim() === "" && removed < 2) {
        lines.splice(k, 1);
        removed++;
      }
    }

    return lines.join("\n").trimStart();
  }

  // (C) 첫 줄이 회차가 아니지만, 두 번째 줄이 회차인 경우도 보정(드물게 앞에 빈줄/기타가 끼는 케이스)
  if (!first && second && second.n === src.n) {
    lines[i + 1] = targetHeader;
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

    // 회차
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

  // end 직전 공백 제거
  while (end > 0 && lines[end - 1].trim() === "") {
    lines.splice(end - 1, 1);
    end--;
  }

  // 본문 앞에 빈 줄 2개(간격 넓힘)
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
          temperature: 0.2,
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

    // ✅ 1) 회차 헤더를 "원문 규칙"에 맞춰 정규화 + 중복 제거
    translated = normalizeEpisodeHeaderBySource(input, translated);

    // ✅ 2) 서식 후처리
    translated = normalizeDialogueSpacing(translated);
    translated = widenHeaderToBodyGap(translated);
    translated = ensureTrailingSpacePerLine(translated);

    return NextResponse.json({ translated });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "translate failed" }, { status: 500 });
  }
}
