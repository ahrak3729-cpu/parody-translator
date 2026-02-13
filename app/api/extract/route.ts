import { NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export const runtime = "nodejs";

function isPixiv(url: string) {
  try {
    const u = new URL(url);
    return u.hostname === "www.pixiv.net" || u.hostname.endsWith(".pixiv.net");
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  try {
    const { url, cookie } = (await req.json()) as { url?: string; cookie?: string };
    if (!url) return NextResponse.json({ error: "url이 비어 있어요." }, { status: 400 });

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return NextResponse.json({ error: "올바른 URL 형식이 아니에요." }, { status: 400 });
    }

    const headers: Record<string, string> = {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
      "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
    };

    // ✅ Pixiv일 때만 Cookie 헤더 적용 (없으면 안내)
    if (isPixiv(parsed.toString())) {
      const c = (cookie || "").trim();

      if (!c) {
        return NextResponse.json(
          {
            error:
              "Pixiv 본문을 불러오려면 로그인 쿠키가 필요해요.\n설정에서 Pixiv 쿠키를 붙여넣고 다시 시도해줘.",
            code: "PIXIV_COOKIE_REQUIRED",
          },
          { status: 401 }
        );
      }

      headers["cookie"] = c;
      headers["referer"] = "https://www.pixiv.net/";
      headers["origin"] = "https://www.pixiv.net";
    }

    const res = await fetch(parsed.toString(), { headers });

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

    // Pixiv은 Readability가 실패할 때가 많아서, 실패 메시지를 더 친절하게
    if (!text) {
      return NextResponse.json(
        {
          error:
            "본문을 추출하지 못했어요.\n- 쿠키가 만료됐거나\n- 성인/비공개 제한이 있거나\n- Pixiv 구조 변경으로 추출이 실패했을 수 있어요.\n텍스트 직접 붙여넣기도 함께 준비해두는 걸 추천해.",
          code: "EXTRACT_EMPTY",
        },
        { status: 400 }
      );
    }

    return NextResponse.json({ title, text });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "알 수 없는 오류" }, { status: 500 });
  }
}
