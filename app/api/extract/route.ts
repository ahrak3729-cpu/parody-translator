import { NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export const runtime = "nodejs";

async function safeReadJson(res: Response) {
  const contentType = res.headers.get("content-type") || "";
  const raw = await res.text();

  if (!raw.trim()) return { __raw: "", __notJson: true, __contentType: contentType };

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      return { __raw: raw, __notJson: true, __contentType: contentType };
    }
  }

  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw, __notJson: true, __contentType: contentType };
  }
}

function stripHtmlToText(html: string) {
  // content가 HTML/마커 섞여 올 수 있어서 텍스트로 정리
  const dom = new JSDOM(`<body>${html}</body>`);
  const text = dom.window.document.body.textContent || "";
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function getPixivNovelId(u: URL): string | null {
  // 1) https://www.pixiv.net/novel/show.php?id=123456
  if (u.pathname === "/novel/show.php") {
    return u.searchParams.get("id");
  }
  // 2) 혹시 다른 형태가 섞이면 여기서 확장 가능
  return null;
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { url?: string; pixivCookie?: string };
    const url = body.url?.trim();
    const pixivCookie = body.pixivCookie?.trim();

    if (!url) {
      return NextResponse.json({ error: "url이 비어 있어요." }, { status: 400 });
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return NextResponse.json({ error: "올바른 URL 형식이 아니에요." }, { status: 400 });
    }

    const isPixiv = parsed.hostname.endsWith("pixiv.net");

    /* =========================
       Pixiv 전용: novel/show.php → ajax/novel/{id}
    ========================= */
    if (isPixiv) {
      const id = getPixivNovelId(parsed);

      if (!id) {
        return NextResponse.json(
          { error: "Pixiv 소설 URL 형식을 인식하지 못했어요. (현재는 novel/show.php?id=... 만 지원)" },
          { status: 400 }
        );
      }

      const ajaxUrl = `https://www.pixiv.net/ajax/novel/${encodeURIComponent(id)}`;

      const headers: Record<string, string> = {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
        "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
        "accept": "application/json, text/plain, */*",
        "referer": parsed.toString(),
      };

      // ⚠️ 선택: 제한/비공개/연령 제한이면 쿠키가 필요할 수 있음
      // - 서버에는 저장하지 않고, 요청에만 포함
      if (pixivCookie) headers["cookie"] = pixivCookie;

      const res = await fetch(ajaxUrl, { headers });
      const data: any = await safeReadJson(res);

      if (!res.ok) {
        return NextResponse.json(
          { error: `Pixiv ajax 가져오기 실패: ${res.status} ${res.statusText}` },
          { status: 400 }
        );
      }

      if (data?.__notJson) {
        return NextResponse.json(
          { error: "Pixiv ajax 응답이 JSON이 아니에요. (차단/보안/네트워크 문제 가능)" },
          { status: 400 }
        );
      }

      if (data?.error) {
        // pixiv ajax는 error:true로 떨어지는 경우가 있음
        return NextResponse.json(
          { error: data?.message || "Pixiv에서 접근이 거부되었어요. (로그인/연령/권한 제한 가능)" },
          { status: 400 }
        );
      }

      const title = String(data?.body?.title ?? "").trim();
      const content = String(data?.body?.content ?? "");
      const description = String(data?.body?.description ?? "");

      const textParts: string[] = [];
      const descText = description ? stripHtmlToText(description) : "";
      const bodyText = content ? stripHtmlToText(content) : "";

      if (descText) textParts.push(descText);
      if (bodyText) textParts.push(bodyText);

      const text = textParts.join("\n\n").trim();

      if (!text) {
        return NextResponse.json(
          { error: "본문을 추출하지 못했어요. (권한 제한/쿠키 필요 가능)" },
          { status: 400 }
        );
      }

      return NextResponse.json({ title, text });
    }

    /* =========================
       일반 사이트: Readability
    ========================= */
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
