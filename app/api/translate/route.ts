import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const text: string = body?.text ?? "";

    if (!text.trim()) {
      return NextResponse.json(
        { error: "번역할 텍스트가 없습니다." },
        { status: 400 }
      );
    }

    // 🔒 조각 단위 최대 길이 제한 (자동 분할용)
    const MAX_CHARS = 4500;
    if (text.length > MAX_CHARS) {
      return NextResponse.json(
        { error: `텍스트가 너무 깁니다. ${MAX_CHARS}자 이하로 나눠서 보내주세요.` },
        { status: 400 }
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY가 설정되지 않았습니다." },
        { status: 500 }
      );
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content: `
너는 웹소설 번역/윤문 전문가다.

규칙:
- 입력 텍스트를 자연스러운 한국어로 번역한다.
- 웹소설처럼 읽히게 문장 흐름과 리듬을 다듬는다.
- 의미를 바꾸지 말고, 원문에 없는 내용을 추가하지 말 것.
- 고유명사/호칭/말투는 가능한 한 일관되게 유지한다.
- 직역 티/오역이 의심되면 문맥에 맞게 바로잡는다.
- 줄바꿈/문단 구조는 최대한 유지한다.
- 출력은 번역 결과만. 설명/부연/메타 코멘트 금지.
            `.trim(),
          },
          {
            role: "user",
            content: text,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return NextResponse.json(
        { error: "OpenAI API 오류", detail: errText },
        { status: 500 }
      );
    }

    const data = await response.json();
    const translated =
      data?.choices?.[0]?.message?.content?.trim() ?? "";

    return NextResponse.json({ translated });
  } catch (err: any) {
    return NextResponse.json(
      { error: "서버 오류", detail: String(err) },
      { status: 500 }
    );
  }
}
