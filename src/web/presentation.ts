import type { TFunction, i18n } from "i18next";
import type { ErrorCode } from "../errors.js";
import { ApiError } from "./api.js";
import en from "./locales/en.js";

export function formatDate(
  value: string | null | undefined,
  instance: i18n,
): string {
  if (!value) return instance.t("noRecord");
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(instance.language === "en" ? "en-US" : "zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(parsed);
}
export function formatError(
  error: unknown,
  t: TFunction,
  fieldLabels: Record<string, string> = {},
): string {
  if (
    error instanceof ApiError &&
    error.code &&
    Object.hasOwn(en, `error_${error.code}`)
  ) {
    const message = t(`error_${error.code as ErrorCode}`);
    if (error.code !== "VALIDATION_ERROR") {
      const details = error.details;
      return details ? `${message}\n${JSON.stringify(details)}` : message;
    }
    const details = error.details;
    const issues =
      details &&
      typeof details === "object" &&
      "issues" in details &&
      Array.isArray(details.issues)
        ? details.issues
        : [];
    const fields = issues
      .map((issue: unknown) => {
        if (
          !issue ||
          typeof issue !== "object" ||
          !("path" in issue) ||
          !Array.isArray(issue.path)
        )
          return "";
        const path = issue.path
          .filter(
            (part: unknown) =>
              typeof part === "string" || typeof part === "number",
          )
          .join(".");
        const field = Object.hasOwn(fieldLabels, path)
          ? fieldLabels[path]
          : path;
        if ("origin" in issue && issue.origin === "string" && field) {
          if (
            "code" in issue &&
            issue.code === "too_big" &&
            "maximum" in issue &&
            typeof issue.maximum === "number"
          )
            return t("fieldTooLong", {
              field,
              limit: issue.maximum,
            });
          if (
            "code" in issue &&
            issue.code === "too_small" &&
            "minimum" in issue &&
            typeof issue.minimum === "number"
          )
            return t("fieldTooShort", {
              field,
              limit: issue.minimum,
            });
        }
        const reason =
          "message" in issue && typeof issue.message === "string"
            ? issue.message
            : t("invalidValue");
        return field ? `${field}: ${reason}` : reason;
      })
      .filter(Boolean);
    return [message, ...fields].join("\n");
  }
  const raw = error instanceof Error ? error.message : String(error);
  const details =
    error instanceof ApiError && error.details !== undefined
      ? typeof error.details === "string"
        ? error.details
        : JSON.stringify(error.details)
      : "";
  return `${t("requestFailed")}\n${raw}${details && details !== raw ? `\n${details}` : ""}`;
}
