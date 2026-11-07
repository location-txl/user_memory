import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import {
  MemoryMetaSchema,
  type Memory,
  type MemoryMeta,
  type MemoryEvent,
} from "../contracts.js";

export function decodeMemory(raw: string, file: string): Memory {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`${file}: Missing YAML frontmatter`);
  const meta = MemoryMetaSchema.parse(parse(match[1], { maxAliasCount: 0 }));
  return { ...meta, content: match[2].trim(), file, etag: fingerprint(raw) };
}
export function encodeMemory(meta: MemoryMeta, content: string) {
  const safe = {
    ...meta,
    title: scrub(meta.title),
    reason: meta.reason && scrub(meta.reason),
    sources: meta.sources.map((s) => ({ ...s, excerpt: scrub(s.excerpt) })),
  };
  return `---\n${stringify(MemoryMetaSchema.parse(safe)).trimEnd()}\n---\n\n${scrub(content).trim()}\n`;
}
export function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function terms(value: string) {
  const split = value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .normalize("NFKC")
    .toLowerCase();
  return [...new Intl.Segmenter("zh", { granularity: "word" }).segment(split)]
    .filter((v) => v.isWordLike)
    .map((v) => v.segment)
    .join(" ");
}
export function scrub(value: string): string {
  return (
    value
      // 工具常把 JSON 再包进 output/text 字符串；先解码字符串层，再按字段脱敏。
      .replace(
        /"(?:\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})|[^"\\\u0000-\u001f])*"/g,
        (literal) => {
          if (!literal.includes("\\")) return literal;
          const decoded = JSON.parse(literal) as string;
          const redacted = scrub(decoded);
          return redacted === decoded ? literal : JSON.stringify(redacted);
        },
      )
      .replace(
        /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
        "[已隐去凭据]",
      )
      .replace(/\b(Bearer\s+)[A-Za-z0-9._~-]{12,}/gi, "$1[已隐去凭据]")
      .replace(
        /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|secret)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[已隐去凭据\]|[^\s,;}\]]+)/gi,
        (_match, key: string, credential: string) => {
          const quote =
            credential.startsWith('"') || /"\s*[:=]\s*$/.test(key)
              ? '"'
              : credential.startsWith("'") || /'\s*[:=]\s*$/.test(key)
                ? "'"
                : "";
          return `${key}${quote}[已隐去凭据]${quote}`;
        },
      )
  );
}

export function scrubEvent(event: MemoryEvent): MemoryEvent {
  return { ...event, content: scrub(event.content) };
}

export function isMemoryData(content: string) {
  return content.includes("<user-memory-context>");
}

export function memoryData<T extends object>(data: T) {
  return { _memoryContext: "<user-memory-context>", ...data };
}
