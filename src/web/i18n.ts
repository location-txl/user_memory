import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.js";
import zhCN from "./locales/zh-CN.js";

declare module "i18next" {
  interface CustomTypeOptions {
    keySeparator: false;
    nsSeparator: false;
    resources: { translation: typeof en };
  }
}

export const storageKey = "umem-language";
export function initialLanguage(storage?: Pick<Storage, "getItem">) {
  try {
    return storage?.getItem(storageKey) === "zh-CN" ? "zh-CN" : "en";
  } catch {
    return "en";
  }
}

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    "zh-CN": { translation: zhCN },
  },
  lng: initialLanguage(
    typeof localStorage === "undefined" ? undefined : localStorage,
  ),
  fallbackLng: "en",
  supportedLngs: ["en", "zh-CN"],
  initAsync: false,
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
});

export default i18n;
