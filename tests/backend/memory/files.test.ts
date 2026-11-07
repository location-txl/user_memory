import { expect, test } from "vitest";
import type { MemoryMeta } from "../../../src/contracts.js";
import {
  decodeMemory,
  encodeMemory,
  scrub,
} from "../../../src/memory/files.js";

const marker = "[已隐去凭据]";
const at = "2026-11-07T00:00:00.000Z";
const meta: MemoryMeta = {
  id: "example",
  title: "运行约束",
  scope: "project",
  projectId: "project-1",
  kind: "constraint",
  status: "active",
  revision: 2,
  createdAt: at,
  updatedAt: at,
  sources: [
    {
      id: "e1",
      role: "user",
      agent: "codex",
      excerpt: "保留来源",
      sessionId: "session-1",
      at,
    },
  ],
};

test("Markdown 往返保留元数据与多段正文，etag 区分原文变化", () => {
  const file = "example.md";
  const content = "第一段\n\n---\n\n第二段：TypeScript";
  const encoded = encodeMemory(meta, content);
  const decoded = decodeMemory(encoded, file);
  expect(decoded).toMatchObject({ ...meta, content, file });
  expect(decodeMemory(encoded, file).etag).toBe(decoded.etag);
  expect(decodeMemory(encodeMemory(meta, content + "!"), file).etag).not.toBe(
    decoded.etag,
  );
});

test.each([
  ["sk-abcdefghijklmnopqrstuvwx", marker],
  ["ghp_abcdefghijklmnopqrstuvwxyz", marker],
  ["Bearer abcdefghijklm", "Bearer " + marker],
  ["password=fixture-password", "password=" + marker],
  ["access_token=" + marker, "access_token=" + marker],
])("持久化前脱敏并保留原有标记（%#）", (input, expected) => {
  expect(scrub(input)).toBe(expected);
  const raw = encodeMemory(
    {
      ...meta,
      title: input,
      reason: input,
      sources: [{ ...meta.sources[0], excerpt: input }],
    },
    input,
  );
  expect(decodeMemory(raw, "example.md")).toMatchObject({
    title: expected,
    reason: expected,
    content: expected,
    sources: [{ ...meta.sources[0], excerpt: expected }],
  });
  if (input !== expected) expect(raw).not.toContain(input);
});
