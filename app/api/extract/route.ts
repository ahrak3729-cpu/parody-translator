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

function getPixivNovelId(u: URL): string | null {
  // 1) https://www.pixiv.net/novel/show.php?id=10461103
  const id = u.searchParams.get("id");
  if (id && /^\d+$/.test(id)) return id;

  // 2) 혹시 다른 형태가 들어오면 대비 (미래 대비용)
  //    예: /novel/show/10461103 같은 형태가 생길 수 있어서 숫자만 추출 시도
  const m = u.pathname.match(/(\d{6,})/);
  if (m?.[1]) return m[1];

  return null;
}

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

    // 공통 헤더
    const headers: Record<string, string> = {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
      "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
    };

    // =========================
    // ✅ Pixiv: AJAX API로 본문 추출 (안정)
    // =========================
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

      const novelId = getPixivNovelId(parsed);
      if (!novelId) {
        return NextResponse.json(
          { error: "Pixiv 소설 id를 URL에서 찾지 못했어요. (예: ...show.php?id=12345 형태인지 확인)" },
          { status: 400 }
        );
      }

      // Pixiv AJAX endpoint
      const apiUrl = `https://www.pixiv.net/ajax/novel/${novelId}`;

      const pixivHeaders: Record<string, string> = {
        ...headers,
        cookie: c,
        referer: "https://www.pixiv.net/",
        origin: "https://www.pixiv.net",
        accept: "application/json, text/plain, */*",
      };

      const res = await fetch(apiUrl, { headers: pixivHeaders });

      if (!res.ok) {
        return NextResponse.json(
          { error: `Pixiv AJAX 가져오기 실패: ${res.status} ${res.statusText}` },
          { status: 400 }
        );
      }

      const data: any = await safeReadJson(res);

      // Pixiv AJAX는 보통 { error: false, body: {...} } 형태
      if (!data || data.__notJson) {
        return NextResponse.json(
          {
            error:
              "Pixiv 응답을 JSON으로 받지 못했어요.\n- 쿠키 만료/차단\n- Pixiv 측 보호\n- 네트워크 문제 가능",
            code: "PIXIV_JSON_FAIL",
          },
          { status: 400 }
        );
      }

      if (data.error === true) {
        return NextResponse.json(
          {
            error: data.message || "Pixiv에서 error=true 응답이 왔어요. (비공개/연령제한/권한 문제 가능)",
            code: "PIXIV_ERROR_TRUE",
          },
          { status: 400 }
        );
      }

      const title = String(data?.body?.title ?? "").trim();

      // 핵심: 본문
      // 대부분 content에 들어옴 (개행 포함)
      const text = String(data?.body?.content ?? "").replace(/\r\n/g, "\n").trim();

      if (!text) {
        return NextResponse.json(
          {
            error:
              "Pixiv에서 본문(content)을 못 가져왔어요.\n- 성인/비공개 제한\n- 쿠키 권한 부족\n- Pixiv 구조 변경 가능",
            code: "EXTRACT_EMPTY",
          },
          { status: 400 }
        );
      }

      return NextResponse.json({ title, text });
    }

    // =========================
    // ✅ Non-Pixiv: 기존 Readability 방식
    // =========================
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

    if (!text) {
      return NextResponse.json(
        {
          error:
            "본문을 추출하지 못했어요.\n사이트 구조/권한/차단 문제일 수 있어요.\n텍스트 직접 붙여넣기도 함께 준비해두는 걸 추천해.",
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
