export function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const raw = (fenced?.[1] ?? trimmed).trim();
  return JSON.parse(raw) as unknown;
}
