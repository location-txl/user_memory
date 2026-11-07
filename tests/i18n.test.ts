import { describe, expect, it, vi, afterEach } from "vitest";
import { api, ApiError } from "../src/web/api.js";
import i18n, { initialLanguage, storageKey } from "../src/web/i18n.js";
import en from "../src/web/locales/en.js";
import zhCN from "../src/web/locales/zh-CN.js";
import { formatDate, formatError } from "../src/web/presentation.js";

const tEn = i18n.getFixedT("en");
const tZh = i18n.getFixedT("zh-CN");

afterEach(() => vi.unstubAllGlobals());
describe("web i18n", () => {
  it("uses matching English identifiers and nonempty translations", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(key).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
      const placeholders = (value: string) =>
        [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
      expect(en[key].trim()).not.toBe("");
      expect(zhCN[key].trim()).not.toBe("");
      expect(placeholders(en[key])).toEqual(placeholders(zhCN[key]));
    }
  });
  it("defaults to English and restores only a supported saved language", () => {
    expect(initialLanguage()).toBe("en");
    expect(
      initialLanguage({
        getItem: (key) => (key === storageKey ? "zh-CN" : null),
      }),
    ).toBe("zh-CN");
    expect(initialLanguage({ getItem: () => "fr" })).toBe("en");
    expect(
      initialLanguage({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toBe("en");
  });
  it("interpolates complete templates without translating data", () => {
    expect(tEn("revisionNumber", { revision: 3 })).toBe("Revision 3");
    expect(tZh("revisionNumber", { revision: 3 })).toBe("第 3 版");
    const scope = "中文 <project> {{scope}} $t(appTitle)";
    expect(tEn("saveTo", { scope })).toBe(`Save to ${scope}`);
  });
  it("formats dates in the selected locale and handles missing/invalid dates", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(formatDate(null, i18n)).toBe("尚无记录");
    await i18n.changeLanguage("en");
    expect(formatDate(undefined, i18n)).toBe("No record");
    expect(formatDate("invalid", i18n)).toBe("invalid");
    const value = "2026-11-07T10:20:00Z";
    expect(formatDate(value, i18n)).toBe(
      new Intl.DateTimeFormat("en-US", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value)),
    );
  });
  it("localizes unknown errors without discarding raw diagnostic details", () => {
    const error = new ApiError(400, "FUTURE_CODE", "raw failure", {
      path: "/tmp/example",
    });
    expect(formatError(error, tEn)).toContain("Try again");
    expect(formatError(error, tZh)).toContain("请重试");
    expect(formatError(error, tEn)).toContain("raw failure");
    expect(formatError(error, tEn)).toContain('"path":"/tmp/example"');
  });
  it("localizes known error codes and structured validation fields", () => {
    expect(
      formatError(new ApiError(409, "MEMORY_CONFLICT", "raw conflict"), tZh),
    ).toBe("记忆已改变，请重新读取后再编辑。");
    expect(
      formatError(new ApiError(409, "MEMORY_CONFLICT", "raw conflict"), tEn),
    ).toContain("Reload");
    const error = new ApiError(400, "VALIDATION_ERROR", "Invalid request.", {
      issues: [{ path: ["title"], code: "too_small", minimum: 1 }],
    });
    expect(formatError(error, tZh)).toContain("title: 内容不符合要求");
    expect(formatError(error, tEn)).toContain("title: Invalid value");
  });
  it("retains API status, code, error and details", async () => {
    vi.stubGlobal("sessionStorage", { getItem: () => "token" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({
          code: "CONFLICT",
          error: "raw conflict",
          details: { revision: 2 },
        }),
      }),
    );
    await expect(api("/memories/id")).rejects.toMatchObject({
      status: 409,
      code: "CONFLICT",
      message: "raw conflict",
      details: { revision: 2 },
    });
  });
});
