"use client";

import { useState } from "react";

export default function Page() {
  const [source, setSource] = useState("");
  const [result, setResult] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleTranslate() {
    if (!source.trim()) return;

    setIsLoading(true);
    setResult("");
    setError("");

    try {
      const res = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: source }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || "번역 중 오류가 발생했어요.");
      }

      setResult(data.translated || "");
    } catch (e: any) {
      setError(e?.message || "알 수 없는 오류");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 900, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 8 }}>
        Parody Translator
      </h1>
      <p style={{ opacity: 0.7, marginBottom: 20 }}>
        텍스트를 넣고 번역을 눌러보세요.
      </p>

      <div style={{ display: "grid", gap: 12 }}>
        <textarea
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="여기에 원문을 붙여넣기…"
          style={{
            width: "100%",
            minHeight: 180,
            padding: 12,
            fontSize: 14,
            borderRadius: 10,
            border: "1px solid #ddd",
            outline: "none",
          }}
        />

        <button
          onClick={handleTranslate}
          disabled={isLoading}
          style={{
            height: 44,
            borderRadius: 10,
            border: "1px solid #ddd",
            cursor: isLoading ? "not-allowed" : "pointer",
            fontWeight: 600,
          }}
        >
          {isLoading ? "번역 중..." : "번역하기"}
        </button>

        {error && (
          <div style={{ color: "#c00", fontSize: 14 }}>
            {error}
          </div>
        )}

        <textarea
          value={result}
          readOnly
          placeholder="번역 결과가 여기 표시됩니다…"
          style={{
            width: "100%",
            minHeight: 220,
            padding: 12,
            fontSize: 14,
            borderRadius: 10,
            border: "1px solid #ddd",
            outline: "none",
            background: "#fafafa",
          }}
        />
      </div>
    </main>
  );
}
