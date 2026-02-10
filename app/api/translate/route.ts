import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { text } = await req.json();

    if (!text || typeof text !== "string" || !text.trim()) {
      return NextResponse.json({ translated: "" }, { status: 200 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is not set" },
        { status: 500 }
      );
    }

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Translate input into natural Korean. Preserve line breaks. Output only the translation.",
          },
          { role: "user", content: text },
        ],
        temperature: 0.2
      }),
    });

    const rawText = await r.text(); // ✅ 일단 텍스트로 받아서 파싱
    let data: any = null;
    try {
      data = JSON.parse(rawText);
    } catch {
      return NextResponse.json(
        { error: "OpenAI returned non-JSON", raw: rawText },
        { status: 500 }
      );
    }

    if (!r.ok) {
      return NextResponse.json(
        { error: data?.error?.message ?? "OpenAI API error", raw: data },
        { status: 500 }
      );
    }

    const translated = data?.choices?.[0]?.message?.content ?? "";

    if (!translated.trim()) {
      return NextResponse.json(
        { error: "Empty translation from OpenAI", raw: data },
        { status: 500 }
      );
    }

    return NextResponse.json({ translated }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}
