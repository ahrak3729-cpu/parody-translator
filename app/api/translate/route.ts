import { NextResponse } from "next/server";

export const runtime = "nodejs"; // 중요: Edge 말고 Node

export async function POST(req: Request) {
  try {
    const { text } = await req.json();

    if (!text || typeof text !== "string") {
      return NextResponse.json({ error: "text is required" }, { status: 400 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is not set" },
        { status: 500 }
      );
    }

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
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
              "You are a translation assistant. Translate input to natural Korean. Keep line breaks. Do not add extra commentary.",
          },
          { role: "user", content: text },
        ],
        temperature: 0.2,
      }),
    });

    const data = await resp.json();

    if (!resp.ok) {
      return NextResponse.json(
        { error: data?.error?.message ?? "OpenAI API error", raw: data },
        { status: 500 }
      );
    }

    const translated = data.choices?.[0]?.message?.content ?? "";
    return NextResponse.json({ translated });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}
