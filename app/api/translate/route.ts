// app/api/translate/route.ts
// ✅ 프롬프트를 강하게 고정 + 최소 후처리(서식 강제)
// - 대사 위/아래 빈 줄 강제
// - 회차/부제목(헤더) 다음 본문 간격 늘리기
// - 각 줄 끝 공백 1칸 강제

import { NextResponse } from "next/server";
import { TRANSLATION_SYSTEM_PROMPT, buildUserPrompt } from "../../../lib/translationPrompt";

/** ✅ 대사 위/아래 빈 줄 강제 */
function normalizeDialogueSpacing(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  const isDialogueLine = (s: string) => {
    const t = s.trim();
    // 큰따옴표/일본식 괄호 대사까지 커버(필요 최소)
    return t.startsWith('"') || t.startsWith("「") || t.startsWith("『");
  };

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i] ?? "";
    const t = cur.trimEnd();

    if (isDialogueLine(t)) {
      // 위에 빈 줄 없으면 추가
      if (out.length > 0 && out[out.length - 1].trim() !== "") out.push("");
      out.push(t);
      // 아래 빈 줄 추가(다음이 비어있지 않으면)
      if (i < lines.length - 1 && (lines[i + 1] ?? "").trim() !== "") out.push("");
    } else {
      out.push(cur);
    }
  }

  // 연속 빈 줄 3개 이상은 2개로 축소
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
}

/** ✅ 회차/부제목/헤더 다음에 본문과 간격(빈 줄) 추가 */
function addSpacingAfterHeaders(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];

  const isHeader = (line: string) => {
    const t = line.trim();
    if (!t) return false;

    // 번호/회차류
    if (/^#\d+/.test(t)) return true;
    if (/^제?\s*\d+\s*화/.test(t)) return true;

    // 영문 타이틀(짧은 줄만): Side Fate 같은 헤더를 잡기 위함
    // (너무 넓게 잡으면 본문도 걸리니까 길이 제한)
    if (t.length <= 30 && /^[A-Za-z0-9 _\-·:]+$/.test(t)) return true;

    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const cur = lines[i] ?? "";
    out.push(cur);

    if (isHeader(cur)) {
      const next = lines[i + 1] ?? "";
      const next2 = lines[i + 2] ?? "";

      // 헤더 다음 줄이 바로 본문이면 빈 줄 2개 확보
      if (next.trim() !== "") {
        out.push("");
        out.push("");
      } else if (next.trim() === "" && next2.trim() !== "") {
        // 이미 1줄 비어있으면 +1줄만
        out.push("");
      }
    }
  }

  // 과도한 빈 줄은 정리
  return out.join("\n").replace(/\n{5,}/g, "\n\n\n\n").trimEnd();
}

/** ✅ “문장 끝 공백 1칸” 강제: 각 줄 끝에 공백 1칸 부여 */
function ensureTrailingSpacePerLine(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = lines.map((l) => {
    // 빈 줄은 그대로(공백 안 붙임)
    if (l.trim() === "") return "";
    // 이미 끝이 공백이면 그대로, 아니면 공백 1칸 추가
    return l.endsWith(" ") ? l : l + " ";
  });

  const joined = out.join("\n");
  // 문서 마지막도 공백 1칸 유지
  return joined.endsWith(" ") ? joined : joined + " ";
}

export async function POST(req: Request) {
  try {
    const { text } = await req.json();
    const input = String(text ?? "").trim();
    if (!input) return NextResponse.json({ translated: "" });

    // ✅ 네가 쓰는 방식 유지: 기본은 Chat Completions endpoint (환경변수로 변경 가능)
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

    // Chat Completions 형태 우선 + (혹시 다른 형태 대비)
    const translatedRaw =
      data?.choices?.[0]?.message?.content ??
      data?.output_text ??
      "";

    let translated = String(translatedRaw ?? "");

    // ✅ 최소 후처리(서식 강제)
    translated = normalizeDialogueSpacing(translated);
    translated = addSpacingAfterHeaders(translated);
    translated = ensureTrailingSpacePerLine(translated);

    return NextResponse.json({ translated });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "translate failed" }, { status: 500 });
  }
}
