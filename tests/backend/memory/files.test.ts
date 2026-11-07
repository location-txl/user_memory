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

test.each([
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "client_secret",
  "password",
  "secret",
])("JSON 凭据字段 %s 脱敏后仍为合法 JSON，普通字段保持原文", (key) => {
  const secret = 'synthetic-invalid-credential with spaces "and quotes"';
  const raw = JSON.stringify({
    [key]: secret,
    message: "正常工具结果",
    count: 3,
  });
  expect(raw).toContain("synthetic-invalid-credential");
  expect(JSON.parse(scrub(raw))).toEqual({
    [key]: marker,
    message: "正常工具结果",
    count: 3,
  });
  expect(scrub(scrub(raw))).toBe(scrub(raw));
});

test.each(["", "Tool output:\n"])(
  "JSON 字符串包装中的凭据递归脱敏：%s",
  (prefix) => {
    const secret = "synthetic-nested-oauth-secret";
    const inner = JSON.stringify({ access_token: secret, message: "保留原文" });
    const wrapped = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ output: inner }) }],
    });
    const input = prefix + wrapped;
    expect(input).toContain(secret);
    const safe = scrub(input);
    expect(safe).not.toContain(secret);
    expect(safe).toContain("保留原文");
    expect(scrub(safe)).toBe(safe);
    const outer = JSON.parse(safe.slice(prefix.length));
    const middle = JSON.parse(outer.content[0].text);
    expect(JSON.parse(middle.output)).toEqual({
      access_token: marker,
      message: "保留原文",
    });
    expect(scrub(`client_secret=${secret}`)).toBe(`client_secret=${marker}`);
  },
);

test("JSON 非字符串凭据和数组边界脱敏后仍可解析", () => {
  const input = '[{"password":1234},{"access_token":null},{"secret":false}]';
  const result = scrub(input);
  expect(result).not.toContain("1234");
  expect(() => JSON.parse(result)).not.toThrow();
});
