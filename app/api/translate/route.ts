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

    if (isDialogueLine(cur)) {
      if (out.length && out[out.length - 1].trim() !== "") out.push("");
      out.push(cur);
      if (i < lines.length - 1 && lines[i + 1].trim() !== "") out.push("");
    } else {
      out.push(cur);
    }
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** ✅ 줄 끝 공백 1칸 유지 */
function ensureTrailingSpacePerLine(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : line.endsWith(" ") ? line : line + " "))
    .join("\n");
}

/** ✅ 원문에 헤더가 있으면, 번역 결과의 '자동 생성 헤더(제 N화)' 제거 */
function removeAutoHeaderIfSourceHasHeader(source: string, translated: string) {
  const src = source.replace(/\r\n/g, "\n");
  const hasSourceHeader =
    /^#\d+/m.test(src) ||            // #1 같은 회차
    /^Side\s+/im.test(src) ||        // Side Fate
    /^第?\s*\d+\s*(話|话)/m.test(src) || // 일본어/중국어 회차
    /^제\s*\d+\s*화/m.test(src);     // 혹시 원문이 한국어인 경우도

  if (!hasSourceHeader) return translated;

  // 번역 결과 맨 앞부분에 자동으로 붙은 "제 N화"만 제거 (원문 헤더는 남김)
  // - 맨 위에 있는 경우에만 제거
  // - "제 1화." 같은 변형도 커버
  const lines = translated.replace(/\r\n/g, "\n").split("\n");

  // 앞쪽 공백 라인 스킵
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;

  // 첫 비어있지 않은 줄이 "제 N화"면 제거
  if (i < lines.length && /^제\s*\d+\s*화[.\s]*$/i.test(lines[i].trim())) {
    lines.splice(i, 1);
    // 제거 후 바로 이어지는 공백 1~2줄도 정리(과하게 뚫려 보이면)
    while (i < lines.length && lines[i].trim() === "") {
      // 한 줄은 남겨도 되지만, 아래 spacing 함수가 다시 정리하므로 여기선 모두 제거
      lines.splice(i, 1);
    }
  }

  return lines.join("\n").trimStart();
}

/** ✅ 헤더 블록(회차/부제목 등)과 본문 사이 공백을 더 넓게(빈 줄 2개) */
function widenHeaderBlockSpacing(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  const isHeaderLine = (line: string) => {
    const t = line.trim();
    if (!t) return false;
    return (
      /^#\d+/.test(t) ||           // #1
      /^제\s*\d+\s*화/.test(t) ||  // 제 1화
      /^Side\s+/i.test(t) ||       // Side Fate / Side 페이트
      /^第?\s*\d+\s*(話|화)/.test(t) // 第1話 같은 것까지
    );
  };

  // 1) 문서 상단에서 연속된 헤더 라인(중간 공백 포함)을 "헤더 블록"으로 간주
  let idx = 0;
  while (idx < lines.length && lines[idx].trim() === "") idx++;

  let end = idx;
  let seenHeader = false;

  while (end < lines.length) {
    const t = lines[end].trim();
    if (t === "") {
      end++;
      continue;
    }
    if (isHeaderLine(lines[end])) {
      seenHeader = true;
      end++;
      continue;
    }
    break; // 헤더가 아닌 첫 본문 줄
  }

  if (!seenHeader) return text;

  // 2) 헤더 블록 끝(end) 직전에 공백 정리 후, 본문 시작 전 빈 줄 2개 보장
  // 헤더 블록과 본문 사이 위치 = end 직전/직후 경계
  // end 앞쪽의 빈줄은 일단 싹 정리하고, 정확히 2줄만 넣음
  // (헤더 블록 내부의 빈 줄은 그대로 둠)
  // end 위치 앞에서부터 연속 공백 제거
  while (end > 0 && lines[end - 1].trim() === "") {
    lines.splice(end - 1, 1);
    end--;
  }

  // 본문이 존재하면 end 위치에 빈 줄 2개 삽입
  if (end < lines.length) {
    lines.splice(end, 0, "", "");
  }

  return lines.join("\n").replace(/\n{5,}/g, "\n\n\n\n").trimEnd();
}

export async function POST(req: Request) {
  try {
    const { text } = await req.json();
    const input = String(text ?? "");
    if (!input.trim()) return NextResponse.json({ translated: "" });

    const res = await fetch(
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

    const data = await res.json();
    let translated = data?.choices?.[0]?.message?.content ?? "";

    // ✅ ① 헤더 중복 제거(원문에 헤더가 있으면 "제 N화" 자동 헤더만 제거)
    translated = removeAutoHeaderIfSourceHasHeader(input, translated);

    // ✅ ② 서식 후처리
    translated = normalizeDialogueSpacing(translated);
    translated = widenHeaderBlockSpacing(translated);
    translated = ensureTrailingSpacePerLine(translated);

    return NextResponse.json({ translated });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "translate failed" }, { status: 500 });
  }
}
