import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import {
  MemoryMetaSchema,
  type Memory,
  type MemoryMeta,
} from "../contracts.js";

export function decodeMemory(raw: string, file: string): Memory {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`${file}: 缺少 YAML frontmatter`);
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
export function scrub(value: string) {
  return value
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g,
      "[已隐去凭据]",
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~-]{12,}/gi, "$1[已隐去凭据]")
    .replace(
      /((?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[已隐去凭据]",
    );
}
