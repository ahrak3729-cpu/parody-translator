// app/api/google-translate/route.ts
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { text, source = "auto", target = "ko" } = await req.json();

    if (typeof text !== "string" || !text.trim()) {
      return NextResponse.json({ translatedText: "" });
    }

    // 비공식(무료) Google Translate endpoint
    // 막히면 429/403 등 날 수 있음
    const url =
      "https://translate.googleapis.com/translate_a/single" +
      `?client=gtx&sl=${encodeURIComponent(source)}` +
      `&tl=${encodeURIComponent(target)}` +
      `&dt=t&q=${encodeURIComponent(text)}`;

    const r = await fetch(url, {
      method: "GET",
      headers: {
        // 가끔 UA 없으면 막히는 경우가 있어서 넣어둠(완전 보장은 아님)
        "User-Agent": "Mozilla/5.0",
      },
      // next fetch 캐시 끄기(원하면)
      cache: "no-store",
    });

    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return NextResponse.json(
        { error: `Google translate failed: ${r.status}`, detail: body },
        { status: 500 }
      );
    }

    // 응답 구조: [[["번역","원문",...], ...], ...]
    const data = (await r.json()) as any;
    const translatedText =
      Array.isArray(data?.[0]) ? data[0].map((x: any) => x?.[0]).join("") : "";

    return NextResponse.json({ translatedText });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
