import { NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** -------------------------
 *  Helpers
 *  ------------------------- */
function isPixiv(url: string) {
  try {
    const u = new URL(url);
    return u.hostname === "www.pixiv.net" || u.hostname.endsWith(".pixiv.net");
  } catch {
    return false;
  }
}

function isPixivNovelShow(u: URL) {
  return u.hostname.includes("pixiv.net") && u.pathname === "/novel/show.php" && !!u.searchParams.get("id");
}

function buildCommonHeaders() {
  // 너무 과하게 헤더를 넣는 건 오히려 역효과일 때도 있어서 "필수+무난"만
  return {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
    "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
  } as Record<string, string>;
}

async function safeReadJsonWithMeta(res: Response) {
  const contentType = res.headers.get("content-type") || "";
  const raw = await res.text();

  if (!raw.trim()) {
    return {
      okJson: false,
      data: null,
      meta: { contentType, raw: "", notJson: true },
    };
  }

  try {
    const data = JSON.parse(raw);
    return { okJson: true, data, meta: { contentType, raw: "", notJson: false } };
  } catch {
    // JSON이 아닌 경우(대개 HTML 차단 페이지)
    return {
      okJson: false,
      data: null,
      meta: {
        contentType,
        raw: raw.slice(0, 800), // 너무 길게는 안 줌
        notJson: true,
      },
    };
  }
}

function normalizeText(s: string) {
  return (s || "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** -------------------------
 *  Pixiv Novel Extract (AJAX)
 *  ------------------------- */
async function extractPixivNovel(u: URL, cookie: string) {
  const novelId = u.searchParams.get("id")!;
  const headers = buildCommonHeaders();

  const c = (cookie || "").trim();
  if (!c) {
    return {
      ok: false as const,
      status: 401,
      body: {
        error: "Pixiv 본문을 불러오려면 로그인 쿠키가 필요해요.\n설정에서 Pixiv 쿠키를 붙여넣고 다시 시도해줘.",
        code: "PIXIV_COOKIE_REQUIRED",
      },
    };
  }

  headers["cookie"] = c;
  headers["referer"] = `https://www.pixiv.net/novel/show.php?id=${encodeURIComponent(novelId)}`;
  headers["origin"] = "https://www.pixiv.net";

  // AJAX쪽은 accept를 명확히
  const ajaxHeaders = {
    ...headers,
    accept: "application/json, text/plain, */*",
    "x-requested-with": "XMLHttpRequest",
  };

  // 1) meta
  const metaRes = await fetch(`https://www.pixiv.net/ajax/novel/${encodeURIComponent(novelId)}`, {
    headers: ajaxHeaders,
  });

  const metaRead = await safeReadJsonWithMeta(metaRes);
  if (!metaRes.ok || !metaRead.okJson) {
    return {
      ok: false as const,
      status: metaRes.status || 400,
      body: {
        error:
          `Pixiv 메타 요청 실패 (${metaRes.status} ${metaRes.statusText})\n` +
          `- content-type: ${metaRead.meta.contentType || "unknown"}\n` +
          (metaRead.meta.notJson
            ? "Pixiv가 JSON 대신 HTML을 반환했어요(차단/캡차/로그인 유도 가능).\n"
            : ""),
        code: metaRead.meta.notJson ? "PIXIV_RETURNED_NON_JSON_META" : "PIXIV_META_FETCH_FAILED",
        debug: metaRead.meta.notJson ? metaRead.meta.raw : undefined,
      },
    };
  }

  const metaJson: any = metaRead.data;
  const title =
    String(metaJson?.body?.title ?? "").trim() ||
    String(metaJson?.body?.novelTitle ?? "").trim() ||
    "";

  // 2) pages
  const pagesRes = await fetch(`https://www.pixiv.net/ajax/novel/${encodeURIComponent(novelId)}/pages`, {
    headers: ajaxHeaders,
  });

  const pagesRead = await safeReadJsonWithMeta(pagesRes);
  if (!pagesRes.ok || !pagesRead.okJson) {
    return {
      ok: false as const,
      status: pagesRes.status || 400,
      body: {
        error:
          `Pixiv pages 요청 실패 (${pagesRes.status} ${pagesRes.statusText})\n` +
          `- content-type: ${pagesRead.meta.contentType || "unknown"}\n` +
          (pagesRead.meta.notJson
            ? "Pixiv가 JSON 대신 HTML을 반환했어요(서버 IP 차단/봇 체크/캡차 가능).\n"
            : ""),
        code: pagesRead.meta.notJson ? "PIXIV_RETURNED_NON_JSON_PAGES" : "PIXIV_PAGES_FETCH_FAILED",
        debug: pagesRead.meta.notJson ? pagesRead.meta.raw : undefined,
      },
    };
  }

  const pagesJson: any = pagesRead.data;
  const body = pagesJson?.body;

  let text = "";

  if (Array.isArray(body)) {
    const parts = body
      .map((p: any) => (p?.text ?? p?.content ?? "").toString())
      .map((s: string) => normalizeText(s))
      .filter(Boolean);
    text = parts.join("\n\n");
  } else if (body && Array.isArray(body.pages)) {
    const parts = body.pages
      .map((p: any) => (p?.text ?? p?.content ?? "").toString())
      .map((s: string) => normalizeText(s))
      .filter(Boolean);
    text = parts.join("\n\n");
  } else if (body?.content) {
    text = normalizeText(String(body.content || ""));
  } else if (body?.text) {
    text = normalizeText(String(body.text || ""));
  }

  if (!text) {
    return {
      ok: false as const,
      status: 400,
      body: {
        error:
          "Pixiv pages 응답은 받았는데 본문이 비어있어요.\n" +
          "- 권한/차단/구조변경 가능\n" +
          "- 또는 pages 응답 구조가 예상과 달라졌을 수 있어요.",
        code: "PIXIV_EXTRACT_EMPTY",
      },
    };
  }

  return { ok: true as const, status: 200, body: { title, text } };
}

/** -------------------------
 *  Generic Extract (Readability)
 *  ------------------------- */
async function extractGeneric(url: string) {
  const headers = buildCommonHeaders();
  const res = await fetch(url, { headers });

  if (!res.ok) {
    return {
      ok: false as const,
      status: 400,
      body: { error: `가져오기 실패: ${res.status} ${res.statusText}` },
    };
  }

  const html = await res.text();
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  const text =
    normalizeText(article?.textContent ?? "") ||
    normalizeText(dom.window.document.body?.textContent ?? "") ||
    "";

  const title =
    String(article?.title ?? "").trim() ||
    dom.window.document.querySelector("title")?.textContent?.trim() ||
    "";

  if (!text) {
    return {
      ok: false as const,
      status: 400,
      body: {
        error:
          "본문을 추출하지 못했어요.\n- 사이트가 JS로 렌더링되거나\n- 차단/권한 문제이거나\n- 구조가 Readability로는 잡히지 않을 수 있어요.",
        code: "EXTRACT_EMPTY",
      },
    };
  }

  return { ok: true as const, status: 200, body: { title, text } };
}

/** -------------------------
 *  Route
 *  ------------------------- */
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

    // Pixiv novel/show.php?id=... 은 AJAX로
    if (isPixiv(parsed.toString()) && isPixivNovelShow(parsed)) {
      const r = await extractPixivNovel(parsed, cookie || "");
      return NextResponse.json(r.body, { status: r.status });
    }

    // others
    const r = await extractGeneric(parsed.toString());
    return NextResponse.json(r.body, { status: r.status });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "알 수 없는 오류" }, { status: 500 });
  }
}
