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

function pickPixivNovelId(u: URL): string | null {
  // 대표적으로: https://www.pixiv.net/novel/show.php?id=123456
  const id = u.searchParams.get("id");
  if (id && /^\d+$/.test(id)) return id;

  // 혹시 경로에 숫자가 붙는 변형이 생겨도 대비
  const m = u.pathname.match(/(\d{5,})/);
  if (m?.[1]) return m[1];

  return null;
}

function safeJsonParse<T = any>(s: string): T | null {
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function normalizeText(s: string) {
  return (s || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// 깊게 중첩된 객체에서 "title" 후보 찾기(너무 과하게 탐색하지 않도록 제한)
function tryFindFirstString(obj: any, keys: string[], maxDepth = 6): string | null {
  const seen = new Set<any>();
  function walk(node: any, depth: number): string | null {
    if (!node || depth > maxDepth) return null;
    if (typeof node !== "object") return null;
    if (seen.has(node)) return null;
    seen.add(node);

    for (const k of keys) {
      if (typeof node?.[k] === "string" && node[k].trim()) return node[k].trim();
    }
    for (const v of Array.isArray(node) ? node : Object.values(node)) {
      const found = walk(v, depth + 1);
      if (found) return found;
    }
    return null;
  }
  return walk(obj, 0);
}

async function fetchWithTimeout(
  url: string,
  opts: RequestInit & { timeoutMs?: number } = {}
) {
  const { timeoutMs = 12000, ...rest } = opts;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

function looksLikePixivLogin(dom: JSDOM, finalUrl: string) {
  const u = (finalUrl || "").toLowerCase();
  if (u.includes("/login") || u.includes("accounts.pixiv.net")) return true;

  const title = dom.window.document.querySelector("title")?.textContent?.toLowerCase() || "";
  if (title.includes("login") || title.includes("로그인")) return true;

  // Pixiv 로그인 폼/버튼이 있을 때가 많음(완벽하진 않지만 힌트로)
  const hasLoginForm =
    !!dom.window.document.querySelector('form[action*="login"]') ||
    !!dom.window.document.querySelector('input[name="pixiv_id"]') ||
    !!dom.window.document.querySelector('input[type="password"]');
  return hasLoginForm;
}

function extractPixivPreload(dom: JSDOM) {
  // Pixiv는 meta#meta-preload-data 안에 JSON이 박혀있는 경우가 많음
  const el = dom.window.document.querySelector("#meta-preload-data");
  const content = el?.getAttribute("content") || "";
  if (!content) return null;
  return safeJsonParse<any>(content);
}

function extractPixivNovelText(preload: any, novelId: string | null) {
  if (!preload) return { title: "", text: "" };

  // Pixiv 구조는 바뀔 수 있어서, 최대한 안전하게 여러 경로를 시도
  // 흔한 케이스: preload.novel[novelId].content 또는 .text
  let title = "";
  let text = "";

  if (novelId) {
    const novelObj =
      preload?.novel?.[novelId] ||
      preload?.novels?.[novelId] ||
      preload?.["novel"]?.[novelId];

    if (novelObj) {
      title =
        (typeof novelObj.title === "string" ? novelObj.title : "") ||
        (typeof novelObj.name === "string" ? novelObj.name : "");

      text =
        (typeof novelObj.content === "string" ? novelObj.content : "") ||
        (typeof novelObj.text === "string" ? novelObj.text : "");
    }
  }

  // novelId로 못 찾았으면, preload 내부에서 그럴듯한 텍스트/제목을 탐색(최소한의 안전장치)
  if (!text) {
    text = tryFindFirstString(preload, ["content", "text", "body"], 6) || "";
  }
  if (!title) {
    title = tryFindFirstString(preload, ["title", "name"], 6) || "";
  }

  return { title: title.trim(), text: normalizeText(text) };
}

function pickTitleFallback(dom: JSDOM, readabilityTitle?: string) {
  // og:title가 Pixiv에서는 비교적 잘 들어오는 편
  const og =
    dom.window.document.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ||
    dom.window.document.querySelector('meta[name="twitter:title"]')?.getAttribute("content")?.trim() ||
    "";
  const t =
    og ||
    (readabilityTitle || "").trim() ||
    dom.window.document.querySelector("title")?.textContent?.trim() ||
    "";
  return t;
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

    const pixiv = isPixiv(parsed.toString());

    const headers: Record<string, string> = {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36",
      "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    };

    // ✅ Pixiv일 때만 Cookie 헤더 적용 (없으면 안내)
    if (pixiv) {
      const c = (cookie || "").trim();
      if (!c) {
        return NextResponse.json(
          {
            error:
              "Pixiv 본문을 불러오려면 로그인 쿠키가 필요해요.\n설정에서 Pixiv 쿠키(PHPSESSID 등)를 붙여넣고 다시 시도해줘.",
            code: "PIXIV_COOKIE_REQUIRED",
          },
          { status: 401 }
        );
      }
      headers["cookie"] = c;
      headers["referer"] = "https://www.pixiv.net/";
      headers["origin"] = "https://www.pixiv.net";
    }

    // ✅ 1차 fetch (timeout)
    let res = await fetchWithTimeout(parsed.toString(), {
      headers,
      timeoutMs: 12000,
      redirect: "follow",
    });

    // ✅ Pixiv는 가끔 429/403이 잘 나서, 상황별 메시지 분기
    if (!res.ok) {
      const status = res.status;

      if (pixiv && (status === 403 || status === 429)) {
        return NextResponse.json(
          {
            error:
              status === 429
                ? "Pixiv가 요청이 너무 많다고 차단했어요(429).\n잠깐 기다렸다가 다시 시도해줘."
                : "Pixiv 접근이 차단되었어요(403).\n쿠키 만료/권한/봇 차단 가능성이 큽니다.",
            code: status === 429 ? "PIXIV_RATE_LIMIT" : "PIXIV_FORBIDDEN",
            status,
          },
          { status }
        );
      }

      return NextResponse.json(
        { error: `가져오기 실패: ${status} ${res.statusText}`, status },
        { status: 400 }
      );
    }

    // ✅ HTML 파싱
    const html = await res.text();
    const finalUrl = (res as any)?.url || parsed.toString();
    const dom = new JSDOM(html, { url: finalUrl });

    // ✅ Pixiv 로그인 페이지로 튄 경우 감지 → 쿠키 문제로 안내
    if (pixiv && looksLikePixivLogin(dom, finalUrl)) {
      return NextResponse.json(
        {
          error:
            "Pixiv 페이지가 로그인 화면으로 열렸어요.\n쿠키가 만료됐거나(로그아웃), 쿠키 형식이 잘못 붙여넣어진 경우가 많아.\n설정의 Pixiv 쿠키를 새로 갱신해서 다시 시도해줘.",
          code: "PIXIV_LOGIN_REDIRECT",
        },
        { status: 401 }
      );
    }

    // ✅ Pixiv 전용: preload JSON에서 소설 본문 우선 추출
    let title = "";
    let text = "";

    if (pixiv) {
      const preload = extractPixivPreload(dom);
      const novelId = pickPixivNovelId(new URL(finalUrl));
      const fromPreload = extractPixivNovelText(preload, novelId);

      title = fromPreload.title;
      text = fromPreload.text;
    }

    // ✅ 2차: Readability
    if (!text) {
      const reader = new Readability(dom.window.document);
      const article = reader.parse();

      const readabilityText = normalizeText(article?.textContent ?? "");
      const readabilityTitle = (article?.title ?? "").trim();

      if (readabilityText) text = readabilityText;
      title = title || pickTitleFallback(dom, readabilityTitle);
    } else {
      // preload로 text가 잡혔으면 title도 fallback 보강
      title = title || pickTitleFallback(dom);
    }

    // ✅ 3차: 마지막 fallback (body text)
    if (!text) {
      text = normalizeText(dom.window.document.body?.textContent || "");
      title = title || pickTitleFallback(dom);
    }

    // ✅ 그래도 비면 친절한 메시지
    if (!text) {
      if (pixiv) {
        return NextResponse.json(
          {
            error:
              "본문을 추출하지 못했어요.\n가능한 원인:\n- 쿠키 만료/로그아웃\n- 성인/비공개/팔로워 한정 등 권한 제한\n- Pixiv 구조 변경/봇 차단\n\n해결 팁:\n1) 쿠키를 새로 갱신해서 다시 시도\n2) 그래도 안 되면 '텍스트 직접 번역'에 붙여넣기 사용",
            code: "PIXIV_EXTRACT_EMPTY",
          },
          { status: 400 }
        );
      }

      return NextResponse.json(
        {
          error:
            "본문을 추출하지 못했어요.\n사이트 구조/권한 문제일 수 있어요.\n텍스트 직접 붙여넣기로 시도해줘.",
          code: "EXTRACT_EMPTY",
        },
        { status: 400 }
      );
    }

    return NextResponse.json({ title: title || "", text });
  } catch (e: any) {
    // AbortError(타임아웃)도 여기로 들어옴
    const msg =
      e?.name === "AbortError"
        ? "가져오기가 시간 초과로 중단됐어요. (사이트가 느리거나 차단 상태일 수 있어요)"
        : e?.message || "알 수 없는 오류";

    return NextResponse.json({ error: msg, code: e?.name === "AbortError" ? "FETCH_TIMEOUT" : "UNKNOWN" }, { status: 500 });
  }
}
