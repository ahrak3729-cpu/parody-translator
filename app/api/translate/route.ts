// app/api/translate/route.ts
// ✅ 프롬프트를 강하게 고정 + 최소 후처리(서식 강제)
// (기존 구현에 "prompt"만 끼워 넣는 구조로 설계)

import { NextResponse } from "next/server";
import { TRANSLATION_SYSTEM_PROMPT, buildUserPrompt } from "@/lib/translationPrompt";

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

/** ✅ “문장 끝 공백 1칸” 강제: 각 줄 끝에 공백 1칸 부여 */
function ensureTrailingSpacePerLine(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out = lines.map((l) => {
    // 빈 줄은 그대로(공백 안 붙임)
    if (l.trim() === "") return "";
    // 이미 끝이 공백이면 그대로, 아니면 공백 1칸 추가
    return l.endsWith(" ") ? l : l + " ";
  });
  // 문서 마지막도 공백 1칸 유지
  const joined = out.join("\n");
  return joined.endsWith(" ") ? joined : joined + " ";
}

export async function POST(req: Request) {
  try {
    const { text } = await req.json();
    const input = String(text ?? "").trim();
    if (!input) return NextResponse.json({ translated: "" });

    // 🔽 여기 아래는 "네가 이미 쓰고 있는 OpenAI 호출 코드"에 맞춰 붙이면 됨
    // 예시: fetch 기반(OpenAI Responses API든 Chat Completions든) — 핵심은 system/user prompt 구성.
    const openaiRes = await fetch(process.env.OPENAI_API_URL ?? "https://api.openai.com/v1/chat/completions", {
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
    });

    if (!openaiRes.ok) {
      const raw = await openaiRes.text().catch(() => "");
      return NextResponse.json(
        { error: `OpenAI error: ${openaiRes.status} ${openaiRes.statusText}\n${raw}` },
        { status: 500 }
      );
    }

    const data = await openaiRes.json();
    const translatedRaw =
      data?.choices?.[0]?.message?.content ??
      data?.output_text ?? // 혹시 Responses API 형태를 쓰는 경우 대비
      "";

    let translated = String(translatedRaw ?? "");

    // ✅ 최소 후처리(서식 강제)
    translated = normalizeDialogueSpacing(translated);
    translated = ensureTrailingSpacePerLine(translated);

    return NextResponse.json({ translated });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "translate failed" }, { status: 500 });
  }
}
