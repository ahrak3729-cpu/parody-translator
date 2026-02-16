import { NextResponse } from "next/server";

export const runtime = "nodejs";

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
    return {
      okJson: false,
      data: null,
      meta: {
        contentType,
        raw: raw.slice(0, 1200), // 디버그용 미리보기
        notJson: true,
      },
    };
  }
}

function extractTitleFromHtml(html: string) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return (m?.[1] || "").replace(/\s+/g, " ").trim();
}

// 아주 단순한 텍스트 추출(스크립트/스타일 제거 + 태그 제거)
function extractTextFromHtml(html: string) {
  let s = html;

  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  // 태그 제거
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n\n");
  s = s.replace(/<\/div>/gi, "\n");
  s = s.replace(/<[^>]+>/g, " ");

  // HTML 엔티티 일부만 최소 치환
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  return normalizeText(s);
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
        error:
          "Pixiv 본문을 불러오려면 로그인 쿠키가 필요해요.\n설정에서 Pixiv 쿠키를 붙여넣고 다시 시도해줘.",
        code: "PIXIV_COOKIE_REQUIRED",
      },
    };
  }

  headers["cookie"] = c;
  headers["referer"] = `https://www.pixiv.net/novel/show.php?id=${encodeURIComponent(novelId)}`;
  headers["origin"] = "https://www.pixiv.net";

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
          `Pixiv 메타 정보를 불러오지 못했어요.\n` +
          `- status: ${metaRes.status} ${metaRes.statusText}\n` +
          `- content-type: ${metaRead.meta.contentType || "unknown"}\n` +
          (metaRead.meta.notJson
            ? "Pixiv가 JSON 대신 HTML을 반환했어요(차단/캡차/로그인유도 가능).\n"
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
  const pagesRes = await fetch(
    `https://www.pixiv.net/ajax/novel/${encodeURIComponent(novelId)}/pages`,
    { headers: ajaxHeaders }
  );
  const pagesRead = await safeReadJsonWithMeta(pagesRes);

  if (!pagesRes.ok || !pagesRead.okJson) {
    return {
      ok: false as const,
      status: pagesRes.status || 400,
      body: {
        error:
          `Pixiv pages 정보를 불러오지 못했어요.\n` +
          `- status: ${pagesRes.status} ${pagesRes.statusText}\n` +
          `- content-type: ${pagesRead.meta.contentType || "unknown"}\n` +
          (pagesRead.meta.notJson
            ? "Pixiv가 JSON 대신 HTML을 반환했어요(서버 IP 차단/봇체크/캡차 가능).\n"
            : ""),
        code: pagesRead.meta.notJson ? "PIXIV_RETURNED_NON_JSON_PAGES" : "PIXIV_PAGES_FETCH_FAILED",
        debug: pagesRead.meta.notJson ? pagesRead.meta.raw : undefined,
      },
    };
  }

  const pagesJson: any = pagesRead.data;
  const body = pagesJson?.body;

  let text = "";

  // Pixiv 응답 구조는 바뀔 수 있어서 여러 케이스 대응
  if (Array.isArray(body)) {
    const parts = body
      .map((p: any) => (p?.text ?? p?.content ?? "").toString())
      .map(normalizeText)
      .filter(Boolean);
    text = parts.join("\n\n");
  } else if (body && Array.isArray(body.pages)) {
    const parts = body.pages
      .map((p: any) => (p?.text ?? p?.content ?? "").toString())
      .map(normalizeText)
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
        debug: JSON.stringify(pagesJson)?.slice(0, 1200),
      },
    };
  }

  return { ok: true as const, status: 200, body: { title, text } };
}

/** -------------------------
 *  Generic Extract (No JSDOM)
 *  ------------------------- */
async function extractGeneric(url: string) {
  const headers = buildCommonHeaders();
  const res = await fetch(url, { headers });

  const ct = res.headers.get("content-type") || "";
  const html = await res.text();

  if (!res.ok) {
    return {
      ok: false as const,
      status: 400,
      body: {
        error: `가져오기 실패: ${res.status} ${res.statusText}`,
        code: "FETCH_FAILED",
        debug: html.slice(0, 1200),
      },
    };
  }

  const title = extractTitleFromHtml(html);
  const text = extractTextFromHtml(html);

  if (!text) {
    return {
      ok: false as const,
      status: 400,
      body: {
        error:
          "본문을 추출하지 못했어요.\n- 사이트가 JS 렌더링이거나\n- 차단/권한 문제이거나\n- 이 단순 추출 방식으로는 잡히지 않을 수 있어요.",
        code: "EXTRACT_EMPTY",
        debug: `content-type: ${ct}\n` + html.slice(0, 1200),
      },
    };
  }

  return { ok: true as const, status: 200, body: { title, text } };
}

/** -------------------------
 *  Route handlers
 *  ------------------------- */
export async function GET() {
  // ✅ GET으로 들어오면 친절하게 안내만 하고 200으로 응답(로그에서 덜 헷갈림)
  return NextResponse.json(
    { error: "허용되지 않는 메서드입니다. POST 방식을 사용하세요.", code: "METHOD_NOT_ALLOWED" },
    { status: 200 }
  );
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

    // Pixiv novel/show.php?id=... 은 AJAX로
    if (isPixiv(parsed.toString()) && isPixivNovelShow(parsed)) {
      const r = await extractPixivNovel(parsed, cookie || "");
      return NextResponse.json(r.body, { status: r.status });
    }

    // others
    const r = await extractGeneric(parsed.toString());
    return NextResponse.json(r.body, { status: r.status });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "알 수 없는 오류", code: "INTERNAL_ERROR" },
      { status: 500 }
    );
  }
}
