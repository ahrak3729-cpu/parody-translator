import { NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

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
  // 대표 케이스: https://www.pixiv.net/novel/show.php?id=10461103
  return u.hostname.includes("pixiv.net") && u.pathname === "/novel/show.php" && !!u.searchParams.get("id");
}

function buildCommonHeaders() {
  return {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
    "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
    // Pixiv AJAX는 이거 있으면 성공률이 약간 올라가
    "x-requested-with": "XMLHttpRequest",
  } as Record<string, string>;
}

async function safeReadJson(res: Response) {
  const contentType = res.headers.get("content-type") || "";
  const raw = await res.text();

  if (!raw.trim()) return { __raw: "", __notJson: true, __contentType: contentType };

  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: raw, __notJson: true, __contentType: contentType };
  }
}

/** -------------------------
 *  Pixiv Novel Extract (AJAX API)
 *  - 분할 소설 포함: pages를 합쳐서 반환
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

  // Pixiv AJAX는 보통 referer/origin/cookie가 중요
  headers["cookie"] = c;
  headers["referer"] = `https://www.pixiv.net/novel/show.php?id=${encodeURIComponent(novelId)}`;
  headers["origin"] = "https://www.pixiv.net";
  headers["accept"] = "application/json, text/plain, */*";

  // 1) 메타(제목 등) 가져오기
  const metaRes = await fetch(`https://www.pixiv.net/ajax/novel/${encodeURIComponent(novelId)}`, {
    headers,
  });
  const metaJson: any = await safeReadJson(metaRes);

  if (!metaRes.ok) {
    // 쿠키 만료/권한/차단 등
    return {
      ok: false as const,
      status: metaRes.status,
      body: {
        error: `Pixiv 메타 가져오기 실패: ${metaRes.status} ${metaRes.statusText}\n(쿠키 만료/권한/차단 가능)`,
        code: "PIXIV_META_FETCH_FAILED",
        detail: metaJson?.error || metaJson?.message || undefined,
      },
    };
  }

  const title =
    String(metaJson?.body?.title ?? "").trim() ||
    String(metaJson?.body?.novelTitle ?? "").trim() ||
    "";

  // 2) pages 가져오기 (페이지 분할/단일 모두 여기서 텍스트 얻는 게 제일 안정적)
  const pagesRes = await fetch(`https://www.pixiv.net/ajax/novel/${encodeURIComponent(novelId)}/pages`, {
    headers,
  });
  const pagesJson: any = await safeReadJson(pagesRes);

  if (!pagesRes.ok) {
    return {
      ok: false as const,
      status: pagesRes.status,
      body: {
        error: `Pixiv 페이지 가져오기 실패: ${pagesRes.status} ${pagesRes.statusText}\n(쿠키 만료/권한/차단 가능)`,
        code: "PIXIV_PAGES_FETCH_FAILED",
        detail: pagesJson?.error || pagesJson?.message || undefined,
      },
    };
  }

  // Pixiv 응답 구조가 바뀔 수 있어서 최대한 방어적으로 처리
  // 흔한 형태:
  // { body: [ { text: "..." }, { text: "..." } ] } 또는
  // { body: { pages: [ { text: "..." } ] } } 또는
  // { body: { content: "..." } } (단일일 때)
  let text = "";

  const body = pagesJson?.body;

  if (Array.isArray(body)) {
    // body가 배열인 경우: pages 배열로 취급
    const parts = body
      .map((p: any) => (p?.text ?? p?.content ?? "").toString())
      .map((s: string) => s.trim())
      .filter(Boolean);
    text = parts.join("\n\n");
  } else if (body && Array.isArray(body.pages)) {
    const parts = body.pages
      .map((p: any) => (p?.text ?? p?.content ?? "").toString())
      .map((s: string) => s.trim())
      .filter(Boolean);
    text = parts.join("\n\n");
  } else if (body?.content) {
    text = String(body.content || "").trim();
  } else if (body?.text) {
    text = String(body.text || "").trim();
  }

  if (!text) {
    return {
      ok: false as const,
      status: 400,
      body: {
        error:
          "Pixiv 본문을 추출하지 못했어요.\n- 쿠키가 만료됐거나\n- 비공개/연령 제한/권한 제한이 있거나\n- Pixiv 구조 변경으로 pages 응답 파싱이 실패했을 수 있어요.\n텍스트 직접 붙여넣기도 함께 준비해두는 걸 추천해.",
        code: "PIXIV_EXTRACT_EMPTY",
      },
    };
  }

  return {
    ok: true as const,
    status: 200,
    body: { title, text },
  };
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
    (article?.textContent ?? "").trim() ||
    dom.window.document.body?.textContent?.replace(/\n{3,}/g, "\n\n").trim() ||
    "";

  const title =
    (article?.title ?? "").trim() ||
    dom.window.document.querySelector("title")?.textContent?.trim() ||
    "";

  if (!text) {
    return {
      ok: false as const,
      status: 400,
      body: {
        error:
          "본문을 추출하지 못했어요.\n- 사이트가 JS로 렌더링되거나\n- 차단/권한 문제이거나\n- 구조가 Readability로는 잡히지 않을 수 있어요.\n텍스트 직접 붙여넣기로도 시도해줘.",
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

    // ✅ Pixiv 분기: novel/show.php?id=... 은 AJAX API로 처리
    if (isPixiv(parsed.toString()) && isPixivNovelShow(parsed)) {
      const r = await extractPixivNovel(parsed, cookie || "");
      return NextResponse.json(r.body, { status: r.status });
    }

    // ✅ 그 외는 일반 Readability 추출
    const r = await extractGeneric(parsed.toString());
    return NextResponse.json(r.body, { status: r.status });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "알 수 없는 오류" }, { status: 500 });
  }
}
