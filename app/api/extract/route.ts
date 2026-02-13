import { NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { url } = (await req.json()) as { url?: string };
    if (!url) return NextResponse.json({ error: "url이 비어 있어요." }, { status: 400 });

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return NextResponse.json({ error: "올바른 URL 형식이 아니에요." }, { status: 400 });
    }

    const res = await fetch(parsed.toString(), {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
        "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
      },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `가져오기 실패: ${res.status} ${res.statusText}` },
        { status: 400 }
      );
    }

    const html = await res.text();

    const dom = new JSDOM(html, { url: parsed.toString() });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();

    const text =
      (article?.textContent ?? "").trim() ||
      dom.window.document.body?.textContent?.replace(/\n{3,}/g, "\n\n").trim() ||
      "";

    const title =
      (article?.title ?? "").trim() ||
      dom.window.document.querySelector("title")?.textContent?.trim() ||
      "";

    if (!text) {
      return NextResponse.json(
        { error: "본문을 추출하지 못했어요. (로그인/차단/구조 특이 가능)" },
        { status: 400 }
      );
    }

    return NextResponse.json({ title, text });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "알 수 없는 오류" }, { status: 500 });
  }
}
