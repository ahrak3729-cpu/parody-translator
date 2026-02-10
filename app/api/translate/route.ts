export async function POST(req: Request) {
  const { text } = await req.json();

  // 지금은 테스트용 더미 응답
  // 다음 단계에서 OpenAI 붙일 거야
  return Response.json({
    translated: `✅ (테스트) 받은 텍스트 길이: ${String(text ?? "").length}자\n\n${text}`,
  });
}
