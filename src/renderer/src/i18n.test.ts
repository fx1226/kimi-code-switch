import { describe, expect, it } from "vitest";

import { listMessageKeys, t } from "./i18n";

describe("i18n 消息表", () => {
  it("zh-CN 与 en-US 键集合保持一致", () => {
    const zhKeys = listMessageKeys("zh-CN").sort();
    const enKeys = listMessageKeys("en-US").sort();
    expect(zhKeys).toEqual(enKeys);
  });

  it("zh-TW 由 zh-CN 派生，键集合保持一致", () => {
    const zhKeys = listMessageKeys("zh-CN").sort();
    const twKeys = listMessageKeys("zh-TW").sort();
    expect(twKeys).toEqual(zhKeys);
  });

  it("其余语言的键不超出 zh-CN 基准键集合", () => {
    const base = new Set(listMessageKeys("zh-CN"));
    for (const locale of ["ja-JP", "de-DE", "es-ES"] as const) {
      for (const key of listMessageKeys(locale)) {
        expect(base.has(key), `${locale} 存在未知键 ${key}`).toBe(true);
      }
    }
  });

  it("未知键回退为键名本身（用于暴露死引用）", () => {
    expect(t("zh-CN", "__definitely_missing_key__")).toBe("__definitely_missing_key__");
  });

  it("核心键在所有语言下均有非键名译文", () => {
    const samples = ["settings", "save", "cancel", "overview", "providers", "models", "mcp", "skillsNav"];
    for (const locale of ["zh-CN", "zh-TW", "en-US", "ja-JP", "de-DE", "es-ES"] as const) {
      for (const key of samples) {
        expect(t(locale, key), `${locale} 缺少 ${key}`).not.toBe(key);
      }
    }
  });
});
