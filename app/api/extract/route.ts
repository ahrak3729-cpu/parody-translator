import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** -------------------------
 * Helpers
 * ------------------------- */
function isPixiv(url: string) {
  try {
    const u = new URL(url);
    return u.hostname === "www.pixiv.net" || u.hostname.endsWith(".pixiv.net");
  } catch {
    return false;
  }
}

function isPixivNovelShow(u: URL) {
  return (
    u.hostname.includes("pixiv.net") &&
    u.pathname === "/novel/show.php" &&
    !!u.searchParams.get("id")
  );
}

function buildCommonHeaders() {
  return {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
    "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
  } as Record<string, string>;
}

function normalizeText(s: string) {
  return (s || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function safeReadJson(res: Response) {
  const text = await res.text();
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, raw: text.slice(0, 800) };
  }
}

/** -------------------------
 * Pixiv Novel Extract (AJAX)
 * ------------------------- */
async function extractPixivNovel(u: URL, cookie: string) {
  const novelId = u.searchParams.get("id")!;
  const headers = buildCommonHeaders();

  const c = (cookie || "").trim();
  if (!c) {
    return {
      status: 401,
      body: {
        error:
          "Pixiv 본문을 불러오려면 로그인 쿠키가 필요해요.\n설정에서 Pixiv 쿠키를 붙여넣고 다시 시도해줘.",
        code: "PIXIV_COOKIE_REQUIRED",
      },
    };
  }

  headers["cookie"] = c;
  headers["referer"] = `https://www.pixiv.net/novel/show.php?id=${novelId}`;
  headers["origin"] = "https://www.pixiv.net";

  const ajaxHeaders = {
    ...headers,
    accept: "application/json, text/plain, */*",
    "x-requested-with": "XMLHttpRequest",
  };

  // 1) meta
  const metaRes = await fetch(
    `https://www.pixiv.net/ajax/novel/${novelId}`,
    { headers: ajaxHeaders }
  );
  const meta = await safeReadJson(metaRes);

  if (!metaRes.ok || !meta.ok) {
    return {
      status: 400,
      body: {
        error:
          "Pixiv 메타 정보를 불러오지 못했어요.\n" +
          "로그인 차단 / 캡차 / 서버 구조 변경 가능성이 있어요.",
        debug: meta.ok ? undefined : meta.raw,
      },
    };
  }

  const title =
    String(meta.json?.body?.title ?? meta.json?.body?.novelTitle ?? "").trim();

  // 2) pages
  const pagesRes = await fetch(
    `https://www.pixiv.net/ajax/novel/${novelId}/pages`,
    { headers: ajaxHeaders }
  );
  const pages = await safeReadJson(pagesRes);

  if (!pagesRes.ok || !pages.ok) {
    return {
      status: 400,
      body: {
        error:
          "Pixiv 본문 페이지를 불러오지 못했어요.\n" +
          "서버 IP 차단 또는 구조 변경 가능성이 있어요.",
        debug: pages.ok ? undefined : pages.raw,
      },
    };
  }

  const body = pages.json?.body;
  let text = "";

  if (Array.isArray(body)) {
    text = body
      .map((p: any) => normalizeText(p?.text ?? p?.content ?? ""))
      .filter(Boolean)
      .join("\n\n");
  } else if (body?.pages) {
    text = body.pages
      .map((p: any) => normalizeText(p?.text ?? p?.content ?? ""))
      .filter(Boolean)
      .join("\n\n");
  } else if (body?.content) {
    text = normalizeText(body.content);
  }

  if (!text) {
    return {
      status: 400,
      body: {
        error:
          "Pixiv 응답은 받았지만 본문이 비어 있어요.\n" +
          "권한 문제 또는 Pixiv 구조 변경 가능성이 있어요.",
        code: "PIXIV_EMPTY",
      },
    };
  }

  return { status: 200, body: { title, text } };
}

/** -------------------------
 * Generic Extract (Readability)
 * ※ jsdom / readability는 반드시 동적 import
 * ------------------------- */
async function extractGeneric(url: string) {
  const headers = buildCommonHeaders();
  const res = await fetch(url, { headers });

  if (!res.ok) {
    return {
      status: 400,
      body: { error: `가져오기 실패: ${res.status} ${res.statusText}` },
    };
  }

  const html = await res.text();

  // ✅ ESM 충돌 방지를 위한 동적 import
  const { JSDOM } = await import("jsdom");
  const { Readability } = await import("@mozilla/readability");

  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  const text =
    normalizeText(article?.textContent ?? "") ||
    normalizeText(dom.window.document.body?.textContent ?? "");

  const title =
    String(article?.title ?? "").trim() ||
    dom.window.document.querySelector("title")?.textContent?.trim() ||
    "";

  if (!text) {
    return {
      status: 400,
      body: {
        error:
          "본문을 추출하지 못했어요.\n" +
          "JS 렌더링 사이트이거나 구조가 맞지 않을 수 있어요.",
      },
    };
  }

  return { status: 200, body: { title, text } };
}

/** -------------------------
 * Route
 * ------------------------- */
export async function POST(req: Request) {
  try {
    const { url, cookie } = (await req.json()) as {
      url?: string;
      cookie?: string;
    };

    if (!url) {
      return NextResponse.json({ error: "url이 비어 있어요." }, { status: 400 });
    }

    const parsed = new URL(url);

    // Pixiv 소설
    if (isPixiv(url) && isPixivNovelShow(parsed)) {
      const r = await extractPixivNovel(parsed, cookie || "");
      return NextResponse.json(r.body, { status: r.status });
    }

    // 일반 사이트
    const r = await extractGeneric(parsed.toString());
    return NextResponse.json(r.body, { status: r.status });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "알 수 없는 서버 오류" },
      { status: 500 }
    );
  }
}

/** -------------------------
 * GET 방지 (브라우저 직접 접근용)
 * ------------------------- */
export async function GET() {
  return NextResponse.json(
    { error: "Method Not Allowed. Use POST." },
    { status: 405 }
  );
}
