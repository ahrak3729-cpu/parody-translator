import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const text = String(body?.text ?? "").trim();

    if (!text) {
      return NextResponse.json({ translated: "" });
    }

    const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GOOGLE_TRANSLATE_API_KEY가 설정되지 않았습니다." },
        { status: 500 }
      );
    }

    const res = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          q: text,
          source: "ja",
          target: "ko",
          format: "text",
        }),
        cache: "no-store",
      }
    );

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      return NextResponse.json(
        {
          error:
            (data as any)?.error?.message ||
            (data as any)?.message ||
            `Google 번역 오류 (${res.status})`,
        },
        { status: res.status }
      );
    }

    const translated =
      (data as any)?.data?.translations?.[0]?.translatedText ?? "";

    return NextResponse.json({ translated: String(translated) });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "서버 번역 오류" },
      { status: 500 }
    );
  }
}
