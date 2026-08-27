import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Bug, Check, ExternalLink, FileText, Github, LoaderCircle, Mail, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";

import { compareReleaseVersions, normalizeReleaseVersion } from "@shared/versionUtils";
import type { Locale } from "@shared/types";

import { t } from "./i18n";
import { toTraditionalChinese } from "./localeText";
import { MarkdownView } from "./markdownView";
import { extractReleaseNotes, getBundledChangelog } from "./releaseNotes";
import logoLight from "./assets/logo-light.png";
import logoDark from "./assets/logo-dark.png";

type InstallSource = "homebrew" | "manual" | "development";
type UpdateDialogPreviewKind = "error" | "available-homebrew" | "available-manual" | "current";

interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseUrl: string;
  releaseName: string;
  releaseBody: string;
  publishedAt: string;
  homebrewCommand: string;
  installSource?: InstallSource;
  errorMessage?: string;
}

export const ABOUT_INFO = {
  version: "2.2.5",
  author: "Hulk Sun",
  license: "MIT",
  repositoryUrl: "https://github.com/fx1226/kimi-code-switch-gui",
  issuesUrl: "https://github.com/fx1226/kimi-code-switch-gui/issues",
  authorBlogUrl: "https://www.crazy-coder.cn",
  contactEmail: "sunhao.java@gmail.com",
};

/** F2：官方契约验证基线（对齐 plan 第 1.1 节固定基线；升级时更新）。 */
export const OFFICIAL_BASELINE = {
  version: "0.38.0",
  commit: "0999454bdcb5ddd98f39bffee434dcf0a810f394",
  releaseDate: "2026-08-20",
};

/** F2：能力五档分类（支持 / 只透传 / 只读 / 委托 TUI / 未支持）。 */
export const CAPABILITY_TIERS: Array<{
  key: string;
  tier: "supported" | "passthrough" | "readonly" | "delegated-tui" | "unsupported";
  i18nKey: string;
}> = [
  { key: "config", tier: "supported", i18nKey: "aboutCompatConfig" },
  { key: "mcp", tier: "supported", i18nKey: "aboutCompatMcp" },
  { key: "tui", tier: "supported", i18nKey: "aboutCompatTui" },
  { key: "skills", tier: "supported", i18nKey: "aboutCompatSkills" },
  { key: "plugins", tier: "readonly", i18nKey: "aboutCompatPlugins" },
  { key: "providers", tier: "supported", i18nKey: "aboutCompatProviders" },
  { key: "agents", tier: "passthrough", i18nKey: "aboutCompatAgents" },
  { key: "pluginLifecycle", tier: "delegated-tui", i18nKey: "aboutCompatPluginLifecycle" },
  { key: "oauth", tier: "delegated-tui", i18nKey: "aboutCompatOauth" },
];

const PENDING_UPDATE_VERSION_STORAGE_KEY = "kimi-switch.pending-update-version";
const UPDATE_CHECK_COOLDOWN_MS = 30 * 1000;

/** F2：兼容性状态页文案（独立字典，避免污染全局 i18n；6 语言齐全）。 */
const COMPAT_STRINGS: Record<string, Record<Locale, string>> = {
  compatTitle: {
    "zh-CN": "官方兼容性状态",
    "zh-TW": toTraditionalChinese("官方兼容性状态"),
    "en-US": "Official Compatibility Status",
    "ja-JP": "公式互換性ステータス",
    "de-DE": "Offizieller Kompatibilitätsstatus",
    "es-ES": "Estado de compatibilidad oficial",
  },
  compatCapability: {
    "zh-CN": "能力", "zh-TW": toTraditionalChinese("能力"), "en-US": "Capability", "ja-JP": "機能", "de-DE": "Fähigkeit", "es-ES": "Capacidad",
  },
  compatStatus: {
    "zh-CN": "状态", "zh-TW": toTraditionalChinese("状态"), "en-US": "Status", "ja-JP": "状態", "de-DE": "Status", "es-ES": "Estado",
  },
  compatBaseline: {
    "zh-CN": "已验证基线：Kimi Code {version}（{commit}，发布于 {date}）",
    "zh-TW": toTraditionalChinese("已验证基线：Kimi Code {version}（{commit}，发布于 {date}）"),
    "en-US": "Verified baseline: Kimi Code {version} ({commit}, released {date})",
    "ja-JP": "検証済みベースライン: Kimi Code {version}（{commit}、{date} リリース）",
    "de-DE": "Verifizierte Basis: Kimi Code {version} ({commit}, veröffentlicht {date})",
    "es-ES": "Base verificada: Kimi Code {version} ({commit}, publicado {date})",
  },
  compatLocal: {
    "zh-CN": "本机 Kimi Code 版本：{version}",
    "zh-TW": toTraditionalChinese("本机 Kimi Code 版本：{version}"),
    "en-US": "Local Kimi Code version: {version}",
    "ja-JP": "ローカルの Kimi Code バージョン: {version}",
    "de-DE": "Lokale Kimi Code-Version: {version}",
    "es-ES": "Versión local de Kimi Code: {version}",
  },
  compatNone: {
    "zh-CN": "未检测到（见总览页）",
    "zh-TW": toTraditionalChinese("未检测到（见总览页）"),
    "en-US": "Not detected (see overview)",
    "ja-JP": "検出されません（概要ページ参照）",
    "de-DE": "Nicht erkannt (siehe Übersicht)",
    "es-ES": "No detectada (ver resumen)",
  },
  compatRiskTitle: {
    "zh-CN": "版本高于基线时的风险提示",
    "zh-TW": toTraditionalChinese("版本高于基线时的风险提示"),
    "en-US": "Risk when the local version is newer than the baseline",
    "ja-JP": "ローカル版がベースラインより新しい場合のリスク",
    "de-DE": "Risiko, wenn die lokale Version neuer als die Basis ist",
    "es-ES": "Riesgo si la versión local es más nueva que la base",
  },
  compatRiskBody: {
    "zh-CN": "本机 Kimi Code 版本高于本 GUI 已验证的 0.38.0 基线时，配置/MCP/TUI/Skills/插件契约可能已变化；「支持」状态仅为 0.38 验证结论。升级前请参考升级 SOP。",
    "zh-TW": toTraditionalChinese("本机 Kimi Code 版本高于本 GUI 已验证的 0.38.0 基线时，配置/MCP/TUI/Skills/插件契约可能已变化；「支持」状态仅为 0.38 验证结论。升级前请参考升级 SOP。"),
    "en-US": "When the local Kimi Code version is newer than the verified 0.38.0 baseline, config/MCP/TUI/Skills/plugin contracts may have changed; \"Supported\" only reflects the 0.38 verification. Follow the upgrade SOP before upgrading.",
    "ja-JP": "ローカルの Kimi Code バージョンが検証済み 0.38.0 より新しい場合、config/MCP/TUI/Skills/プラグイン契約が変わっている可能性があります。「対応」は 0.38 検証の結果です。アップグレード前は SOP に従ってください。",
    "de-DE": "Wenn die lokale Kimi Code-Version neuer als die verifizierte 0.38.0-Basis ist, können sich config/MCP/TUI/Skills/Plugin-Verträge geändert haben; \"Unterstützt\" spiegelt nur die 0.38-Verifikation wider. Befolgen Sie vor dem Upgrade die SOP.",
    "es-ES": "Cuando la versión local de Kimi Code es más nueva que la base verificada 0.38.0, los contratos de config/MCP/TUI/Skills/plugins pueden cambiar; \"Compatible\" solo refleja la verificación 0.38. Siga el SOP de actualización antes de actualizar.",
  },
  compatTierSupported: {
    "zh-CN": "支持", "zh-TW": toTraditionalChinese("支持"), "en-US": "Supported", "ja-JP": "対応", "de-DE": "Unterstützt", "es-ES": "Compatible",
  },
  compatTierPassthrough: {
    "zh-CN": "只透传", "zh-TW": toTraditionalChinese("只透传"), "en-US": "Passthrough", "ja-JP": "透過のみ", "de-DE": "Nur Durchreichen", "es-ES": "Solo paso directo",
  },
  compatTierReadonly: {
    "zh-CN": "只读", "zh-TW": toTraditionalChinese("只读"), "en-US": "Read-only", "ja-JP": "読み取り専用", "de-DE": "Schreibgeschützt", "es-ES": "Solo lectura",
  },
  compatTierDelegatedTui: {
    "zh-CN": "委托 TUI", "zh-TW": toTraditionalChinese("委托 TUI"), "en-US": "Delegated to TUI", "ja-JP": "TUI 委任", "de-DE": "An TUI delegiert", "es-ES": "Delegado a TUI",
  },
  compatTierUnsupported: {
    "zh-CN": "未支持", "zh-TW": toTraditionalChinese("未支持"), "en-US": "Unsupported", "ja-JP": "未対応", "de-DE": "Nicht unterstützt", "es-ES": "No compatible",
  },
  compatConfig: {
    "zh-CN": "config.toml 结构化管理", "zh-TW": toTraditionalChinese("config.toml 结构化管理"), "en-US": "config.toml structured management", "ja-JP": "config.toml 構造化管理", "de-DE": "config.toml strukturierte Verwaltung", "es-ES": "Gestión estructurada de config.toml",
  },
  compatMcp: {
    "zh-CN": "MCP 配置/测试", "zh-TW": toTraditionalChinese("MCP 配置/测试"), "en-US": "MCP config/testing", "ja-JP": "MCP 設定/テスト", "de-DE": "MCP-Konfiguration/-Test", "es-ES": "Config/pruebas de MCP",
  },
  compatTui: {
    "zh-CN": "TUI 设置", "zh-TW": toTraditionalChinese("TUI 设置"), "en-US": "TUI settings", "ja-JP": "TUI 設定", "de-DE": "TUI-Einstellungen", "es-ES": "Ajustes de TUI",
  },
  compatSkills: {
    "zh-CN": "Skills 发现/预览", "zh-TW": toTraditionalChinese("Skills 发现/预览"), "en-US": "Skills discovery/preview", "ja-JP": "Skills 検出/プレビュー", "de-DE": "Skills-Erkennung/-Vorschau", "es-ES": "Descubrimiento/vista previa de skills",
  },
  compatPlugins: {
    "zh-CN": "插件清单（只读）", "zh-TW": toTraditionalChinese("插件清单（只读）"), "en-US": "Plugin inventory (read-only)", "ja-JP": "プラグイン一覧（読み取り専用）", "de-DE": "Plugin-Inventar (schreibgeschützt)", "es-ES": "Inventario de plugins (solo lectura)",
  },
  compatProviders: {
    "zh-CN": "Provider/Model 管理", "zh-TW": toTraditionalChinese("Provider/Model 管理"), "en-US": "Provider/Model management", "ja-JP": "Provider/Model 管理", "de-DE": "Provider/Model-Verwaltung", "es-ES": "Gestión de providers/modelos",
  },
  compatAgents: {
    "zh-CN": "Agents 目录/extra_agent_dirs", "zh-TW": toTraditionalChinese("Agents 目录/extra_agent_dirs"), "en-US": "Agents dirs / extra_agent_dirs", "ja-JP": "Agents ディレクトリ / extra_agent_dirs", "de-DE": "Agents-Verzeichnisse / extra_agent_dirs", "es-ES": "Dirs de agents / extra_agent_dirs",
  },
  compatPluginLifecycle: {
    "zh-CN": "Plugin 生命周期", "zh-TW": toTraditionalChinese("Plugin 生命周期"), "en-US": "Plugin lifecycle", "ja-JP": "プラグインライフサイクル", "de-DE": "Plugin-Lebenszyklus", "es-ES": "Ciclo de vida de plugins",
  },
  compatOauth: {
    "zh-CN": "MCP/账号 OAuth", "zh-TW": toTraditionalChinese("MCP/账号 OAuth"), "en-US": "MCP/account OAuth", "ja-JP": "MCP/アカウント OAuth", "de-DE": "MCP/Konto-OAuth", "es-ES": "OAuth de MCP/cuentas",
  },
};

function compatText(locale: Locale, key: string, values: Record<string, string | number> = {}): string {
  const template = COMPAT_STRINGS[key]?.[locale] ?? COMPAT_STRINGS[key]?.["en-US"] ?? key;
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(values[name] ?? `{${name}}`));
}

function aboutText(
  locale: Locale,
  key: string,
  values: Record<string, string | number> = {},
): string {
  const dictionary: Record<string, Record<Locale, string>> = {
    installManual: {
      "zh-CN": "手动安装",
      "zh-TW": toTraditionalChinese("手动安装"),
      "en-US": "Manual",
      "ja-JP": "手動インストール",
      "de-DE": "Manuell",
      "es-ES": "Manual",
    },
    installDevelopment: {
      "zh-CN": "开发构建",
      "zh-TW": toTraditionalChinese("开发构建"),
      "en-US": "Development",
      "ja-JP": "開発ビルド",
      "de-DE": "Entwicklungsbuild",
      "es-ES": "Compilación de desarrollo",
    },
    installDetecting: {
      "zh-CN": "检测中",
      "zh-TW": toTraditionalChinese("检测中"),
      "en-US": "Detecting",
      "ja-JP": "検出中",
      "de-DE": "Wird erkannt",
      "es-ES": "Detectando",
    },
    aboutDescription: {
      "zh-CN": "用于管理 kimi-code-cli 配置的桌面工具。",
      "zh-TW": toTraditionalChinese("用于管理 kimi-code-cli 配置的桌面工具。"),
      "en-US": "Desktop app for managing kimi-code-cli configuration.",
      "ja-JP": "kimi-code-cli の設定を管理するデスクトップアプリです。",
      "de-DE": "Desktop-App zum Verwalten der kimi-code-cli-Konfiguration.",
      "es-ES": "Aplicación de escritorio para gestionar la configuración de kimi-code-cli.",
    },
    aboutMeta: {
      "zh-CN": "作者：{author} · 许可证：{license} · 安装来源：{source}",
      "zh-TW": toTraditionalChinese("作者：{author} · 许可证：{license} · 安装来源：{source}"),
      "en-US": "Author: {author} · License: {license} · Source: {source}",
      "ja-JP": "作者: {author} · ライセンス: {license} · インストール元: {source}",
      "de-DE": "Autor: {author} · Lizenz: {license} · Quelle: {source}",
      "es-ES": "Autor: {author} · Licencia: {license} · Origen: {source}",
    },
    updatePreviewTitle: {
      "zh-CN": "更新弹框预览",
      "zh-TW": toTraditionalChinese("更新弹框预览"),
      "en-US": "Update Dialog Preview",
      "ja-JP": "更新ダイアログのプレビュー",
      "de-DE": "Update-Dialog Vorschau",
      "es-ES": "Vista previa del diálogo de actualización",
    },
    updatePreviewDescription: {
      "zh-CN": "不依赖真实网络结果，直接查看几种典型状态下的弹框效果。",
      "zh-TW": toTraditionalChinese("不依赖真实网络结果，直接查看几种典型状态下的弹框效果。"),
      "en-US": "Open representative dialog states without relying on the live network result.",
      "ja-JP": "実際のネットワーク結果に依存せず、代表的な状態のダイアログを確認できます。",
      "de-DE": "Zeigt typische Dialogzustände ohne Live-Netzwerkergebnis an.",
      "es-ES": "Abre estados representativos del diálogo sin depender del resultado real de red.",
    },
    previewFailure: {
      "zh-CN": "预览失败态",
      "zh-TW": toTraditionalChinese("预览失败态"),
      "en-US": "Preview Failure",
      "ja-JP": "失敗状態をプレビュー",
      "de-DE": "Fehlerzustand anzeigen",
      "es-ES": "Vista de fallo",
    },
    previewHomebrewUpdate: {
      "zh-CN": "预览 Homebrew 更新",
      "zh-TW": toTraditionalChinese("预览 Homebrew 更新"),
      "en-US": "Preview Homebrew Update",
      "ja-JP": "Homebrew 更新をプレビュー",
      "de-DE": "Homebrew-Update anzeigen",
      "es-ES": "Vista de actualización Homebrew",
    },
    previewManualUpdate: {
      "zh-CN": "预览手动更新",
      "zh-TW": toTraditionalChinese("预览手动更新"),
      "en-US": "Preview Manual Update",
      "ja-JP": "手動更新をプレビュー",
      "de-DE": "Manuelles Update anzeigen",
      "es-ES": "Vista de actualización manual",
    },
    previewCurrent: {
      "zh-CN": "预览已最新",
      "zh-TW": toTraditionalChinese("预览已最新"),
      "en-US": "Preview Up To Date",
      "ja-JP": "最新状態をプレビュー",
      "de-DE": "Aktuellen Zustand anzeigen",
      "es-ES": "Vista de versión actualizada",
    },
    projectLinks: {
      "zh-CN": "项目链接",
      "zh-TW": toTraditionalChinese("项目链接"),
      "en-US": "Project Links",
      "ja-JP": "プロジェクトリンク",
      "de-DE": "Projektlinks",
      "es-ES": "Enlaces del proyecto",
    },
    currentReleaseNotes: {
      "zh-CN": "当前版本变更",
      "zh-TW": toTraditionalChinese("当前版本变更"),
      "en-US": "Release Notes",
      "ja-JP": "リリースノート",
      "de-DE": "Versionshinweise",
      "es-ES": "Notas de la versión",
    },
    viewAllVersions: {
      "zh-CN": "查看全部版本",
      "zh-TW": toTraditionalChinese("查看全部版本"),
      "en-US": "All releases",
      "ja-JP": "すべてのリリース",
      "de-DE": "Alle Versionen",
      "es-ES": "Todas las versiones",
    },
    currentReleaseNotesEmpty: {
      "zh-CN": "未在 CHANGELOG 中找到当前版本的变更说明。",
      "zh-TW": toTraditionalChinese("未在 CHANGELOG 中找到当前版本的变更说明。"),
      "en-US": "No CHANGELOG entry found for the current version.",
      "ja-JP": "現在のバージョンの CHANGELOG が見つかりません。",
      "de-DE": "Kein CHANGELOG-Eintrag für die aktuelle Version gefunden.",
      "es-ES": "No se encontraron notas en CHANGELOG para la versión actual.",
    },
    newReleaseNotes: {
      "zh-CN": "新版本变更",
      "zh-TW": toTraditionalChinese("新版本变更"),
      "en-US": "What's New",
      "ja-JP": "新着情報",
      "de-DE": "Neuerungen",
      "es-ES": "Novedades",
    },
    githubLink: {
      "zh-CN": "GitHub 地址",
      "zh-TW": toTraditionalChinese("GitHub 地址"),
      "en-US": "GitHub",
      "ja-JP": "GitHub",
      "de-DE": "GitHub",
      "es-ES": "GitHub",
    },
    reportIssues: {
      "zh-CN": "提 Issue",
      "zh-TW": toTraditionalChinese("提 Issue"),
      "en-US": "Report Issues",
      "ja-JP": "Issue を報告",
      "de-DE": "Issues melden",
      "es-ES": "Reportar incidencias",
    },
    authorBlog: {
      "zh-CN": "作者博客",
      "zh-TW": toTraditionalChinese("作者博客"),
      "en-US": "Author Blog",
      "ja-JP": "作者ブログ",
      "de-DE": "Autorenblog",
      "es-ES": "Blog del autor",
    },
    contactEmail: {
      "zh-CN": "联系邮箱",
      "zh-TW": toTraditionalChinese("联系邮箱"),
      "en-US": "Contact Email",
      "ja-JP": "連絡先メール",
      "de-DE": "Kontakt-E-Mail",
      "es-ES": "Correo de contacto",
    },
    previewRateLimitError: {
      "zh-CN": "GitHub 请求已被限流，已切换到手动查看模式。",
      "zh-TW": toTraditionalChinese("GitHub 请求已被限流，已切换到手动查看模式。"),
      "en-US": "GitHub API rate limit exceeded. Please check the release page manually.",
      "ja-JP": "GitHub API のレート制限に達しました。Release ページを手動で確認してください。",
      "de-DE": "GitHub-API-Rate-Limit überschritten. Bitte prüfe die Release-Seite manuell.",
      "es-ES": "Se superó el límite de la API de GitHub. Revisa la página de releases manualmente.",
    },
    updateFailedTitle: {
      "zh-CN": "检查更新失败",
      "zh-TW": toTraditionalChinese("检查更新失败"),
      "en-US": "Update Check Failed",
      "ja-JP": "更新確認に失敗",
      "de-DE": "Update-Prüfung fehlgeschlagen",
      "es-ES": "Error al buscar actualizaciones",
    },
    updateAvailableTitle: {
      "zh-CN": "发现新版本",
      "zh-TW": toTraditionalChinese("发现新版本"),
      "en-US": "Update Available",
      "ja-JP": "新しいバージョンがあります",
      "de-DE": "Update verfügbar",
      "es-ES": "Actualización disponible",
    },
    updateCurrentTitle: {
      "zh-CN": "当前已是最新版本",
      "zh-TW": toTraditionalChinese("当前已是最新版本"),
      "en-US": "You're Up to Date",
      "ja-JP": "最新バージョンです",
      "de-DE": "Du bist auf dem neuesten Stand",
      "es-ES": "Ya tienes la última versión",
    },
    statusFailed: {
      "zh-CN": "状态: 检查失败",
      "zh-TW": toTraditionalChinese("状态: 检查失败"),
      "en-US": "Status: Check Failed",
      "ja-JP": "状態: 確認失敗",
      "de-DE": "Status: Prüfung fehlgeschlagen",
      "es-ES": "Estado: comprobación fallida",
    },
    statusAvailable: {
      "zh-CN": "状态: 可更新",
      "zh-TW": toTraditionalChinese("状态: 可更新"),
      "en-US": "Status: Update Available",
      "ja-JP": "状態: 更新可能",
      "de-DE": "Status: Update verfügbar",
      "es-ES": "Estado: actualización disponible",
    },
    statusCurrent: {
      "zh-CN": "状态: 已最新",
      "zh-TW": toTraditionalChinese("状态: 已最新"),
      "en-US": "Status: Up To Date",
      "ja-JP": "状態: 最新",
      "de-DE": "Status: Aktuell",
      "es-ES": "Estado: actualizado",
    },
    updateRecommended: {
      "zh-CN": "建议更新",
      "zh-TW": toTraditionalChinese("建议更新"),
      "en-US": "Update Recommended",
      "ja-JP": "更新推奨",
      "de-DE": "Update empfohlen",
      "es-ES": "Actualización recomendada",
    },
    manualCheckNeeded: {
      "zh-CN": "需要人工处理",
      "zh-TW": toTraditionalChinese("需要人工处理"),
      "en-US": "Manual Check Needed",
      "ja-JP": "手動確認が必要",
      "de-DE": "Manuelle Prüfung nötig",
      "es-ES": "Comprobación manual necesaria",
    },
    currentVersion: {
      "zh-CN": "当前版本",
      "zh-TW": toTraditionalChinese("当前版本"),
      "en-US": "Current",
      "ja-JP": "現在",
      "de-DE": "Aktuell",
      "es-ES": "Actual",
    },
    latestVersion: {
      "zh-CN": "最新版本",
      "zh-TW": toTraditionalChinese("最新版本"),
      "en-US": "Latest",
      "ja-JP": "最新",
      "de-DE": "Neueste",
      "es-ES": "Última",
    },
    homebrewCommand: {
      "zh-CN": "Homebrew 更新命令",
      "zh-TW": toTraditionalChinese("Homebrew 更新命令"),
      "en-US": "Homebrew Upgrade Command",
      "ja-JP": "Homebrew 更新コマンド",
      "de-DE": "Homebrew-Update-Befehl",
      "es-ES": "Comando de actualización de Homebrew",
    },
    manualReleaseTip: {
      "zh-CN": "你也可以直接打开 GitHub Release 页面手动查看最新版本。",
      "zh-TW": toTraditionalChinese("你也可以直接打开 GitHub Release 页面手动查看最新版本。"),
      "en-US": "You can also open the GitHub Releases page and check manually.",
      "ja-JP": "GitHub Releases ページを開いて手動で最新バージョンを確認することもできます。",
      "de-DE": "Du kannst auch die GitHub-Releases-Seite öffnen und manuell prüfen.",
      "es-ES": "También puedes abrir la página de GitHub Releases y comprobarlo manualmente.",
    },
    copiedCommand: {
      "zh-CN": "已复制命令",
      "zh-TW": toTraditionalChinese("已复制命令"),
      "en-US": "Copied",
      "ja-JP": "コピーしました",
      "de-DE": "Kopiert",
      "es-ES": "Copiado",
    },
    copyHomebrewCommand: {
      "zh-CN": "复制 Homebrew 命令",
      "zh-TW": toTraditionalChinese("复制 Homebrew 命令"),
      "en-US": "Copy Homebrew Command",
      "ja-JP": "Homebrew コマンドをコピー",
      "de-DE": "Homebrew-Befehl kopieren",
      "es-ES": "Copiar comando de Homebrew",
    },
    releaseUrlCopied: {
      "zh-CN": "已复制 Release 链接",
      "zh-TW": toTraditionalChinese("已复制 Release 链接"),
      "en-US": "Release URL Copied",
      "ja-JP": "Release リンクをコピーしました",
      "de-DE": "Release-URL kopiert",
      "es-ES": "URL de Release copiada",
    },
    openGithubRelease: {
      "zh-CN": "打开 GitHub Release",
      "zh-TW": toTraditionalChinese("打开 GitHub Release"),
      "en-US": "Open GitHub Release",
      "ja-JP": "GitHub Release を開く",
      "de-DE": "GitHub Release öffnen",
      "es-ES": "Abrir GitHub Release",
    },
    checking: {
      "zh-CN": "检查中",
      "zh-TW": toTraditionalChinese("检查中"),
      "en-US": "Checking",
      "ja-JP": "確認中",
      "de-DE": "Prüfe",
      "es-ES": "Comprobando",
    },
    retryIn: {
      "zh-CN": "{seconds}s 后重试",
      "zh-TW": toTraditionalChinese("{seconds}s 后重试"),
      "en-US": "Retry in {seconds}s",
      "ja-JP": "{seconds}s 後に再試行",
      "de-DE": "Erneut in {seconds}s",
      "es-ES": "Reintentar en {seconds}s",
    },
    checkUpdates: {
      "zh-CN": "检查更新",
      "zh-TW": toTraditionalChinese("检查更新"),
      "en-US": "Check Updates",
      "ja-JP": "更新を確認",
      "de-DE": "Updates prüfen",
      "es-ES": "Buscar actualizaciones",
    },
    updateCheckFailedDescription: {
      "zh-CN": "当前版本 v{currentVersion}。检查更新时发生错误：{errorMessage}",
      "zh-TW": toTraditionalChinese("当前版本 v{currentVersion}。检查更新时发生错误：{errorMessage}"),
      "en-US": "You're on v{currentVersion}. The update check failed: {errorMessage}",
      "ja-JP": "現在のバージョンは v{currentVersion} です。更新確認でエラーが発生しました: {errorMessage}",
      "de-DE": "Du verwendest v{currentVersion}. Die Update-Prüfung ist fehlgeschlagen: {errorMessage}",
      "es-ES": "Estás en v{currentVersion}. La comprobación de actualización falló: {errorMessage}",
    },
    noUpdateDescription: {
      "zh-CN": "当前版本 v{currentVersion}，未检测到更新。",
      "zh-TW": toTraditionalChinese("当前版本 v{currentVersion}，未检测到更新。"),
      "en-US": "You're on v{currentVersion}. No newer release was found.",
      "ja-JP": "現在のバージョンは v{currentVersion} です。新しいリリースは見つかりませんでした。",
      "de-DE": "Du verwendest v{currentVersion}. Es wurde kein neueres Release gefunden.",
      "es-ES": "Estás en v{currentVersion}. No se encontró una versión más reciente.",
    },
    homebrewUpdateDescription: {
      "zh-CN": "当前版本 v{currentVersion}，最新版本 {releaseName}。建议通过 Homebrew 更新。",
      "zh-TW": toTraditionalChinese("当前版本 v{currentVersion}，最新版本 {releaseName}。建议通过 Homebrew 更新。"),
      "en-US": "You're on v{currentVersion}. The latest release is {releaseName}. Update via Homebrew.",
      "ja-JP": "現在のバージョンは v{currentVersion}、最新は {releaseName} です。Homebrew での更新を推奨します。",
      "de-DE": "Du verwendest v{currentVersion}. Das neueste Release ist {releaseName}. Aktualisiere über Homebrew.",
      "es-ES": "Estás en v{currentVersion}. La última versión es {releaseName}. Actualiza con Homebrew.",
    },
    developmentUpdateDescription: {
      "zh-CN": "当前版本 v{currentVersion}，最新版本 {releaseName}。当前是开发构建，请前往 GitHub Release 页面查看正式版本。",
      "zh-TW": toTraditionalChinese("当前版本 v{currentVersion}，最新版本 {releaseName}。当前是开发构建，请前往 GitHub Release 页面查看正式版本。"),
      "en-US": "You're on v{currentVersion}. The latest release is {releaseName}. This is a development build, so check the GitHub release page for the packaged app.",
      "ja-JP": "現在のバージョンは v{currentVersion}、最新は {releaseName} です。これは開発ビルドのため、GitHub Release ページで正式版を確認してください。",
      "de-DE": "Du verwendest v{currentVersion}. Das neueste Release ist {releaseName}. Dies ist ein Entwicklungsbuild; prüfe die GitHub-Release-Seite für die paketierte App.",
      "es-ES": "Estás en v{currentVersion}. La última versión es {releaseName}. Esta es una compilación de desarrollo; revisa la página de GitHub Releases para la app empaquetada.",
    },
    manualUpdateDescription: {
      "zh-CN": "当前版本 v{currentVersion}，最新版本 {releaseName}。请前往 GitHub Release 页面下载安装包。",
      "zh-TW": toTraditionalChinese("当前版本 v{currentVersion}，最新版本 {releaseName}。请前往 GitHub Release 页面下载安装包。"),
      "en-US": "You're on v{currentVersion}. The latest release is {releaseName}. Download the installer from the GitHub release page.",
      "ja-JP": "現在のバージョンは v{currentVersion}、最新は {releaseName} です。GitHub Release ページからインストーラーをダウンロードしてください。",
      "de-DE": "Du verwendest v{currentVersion}. Das neueste Release ist {releaseName}. Lade den Installer von der GitHub-Release-Seite herunter.",
      "es-ES": "Estás en v{currentVersion}. La última versión es {releaseName}. Descarga el instalador desde la página de GitHub Releases.",
    },
  };
  const template = dictionary[key]?.[locale] ?? dictionary[key]?.["en-US"] ?? key;
  return template.replace(/\{(\w+)\}/g, (_, valueKey: string) => String(values[valueKey] ?? ""));
}

function getApi() {
  return typeof window !== "undefined" ? window.kimiSwitch : undefined;
}

function loadPendingUpdateVersion(): string {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(PENDING_UPDATE_VERSION_STORAGE_KEY) ?? "";
}

function savePendingUpdateVersion(version: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const normalizedVersion = normalizeReleaseVersion(version);
  if (!normalizedVersion) {
    window.localStorage.removeItem(PENDING_UPDATE_VERSION_STORAGE_KEY);
    return;
  }

  const storedVersion = loadPendingUpdateVersion();
  const nextVersion =
    storedVersion && compareReleaseVersions(storedVersion, normalizedVersion) > 0
      ? storedVersion
      : normalizedVersion;

  window.localStorage.setItem(PENDING_UPDATE_VERSION_STORAGE_KEY, nextVersion);
}

function clearPendingUpdateVersion(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(PENDING_UPDATE_VERSION_STORAGE_KEY);
}

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the selection-based copy path.
    }
  }

  if (typeof document === "undefined") {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.left = "-1000px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

function useDialogEscape(onClose: () => void): void {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
}

function formatInstallSource(locale: Locale, source: InstallSource | "unknown"): string {
  if (source === "homebrew") {
    return "Homebrew";
  }
  if (source === "manual") {
    return aboutText(locale, "installManual");
  }
  if (source === "development") {
    return aboutText(locale, "installDevelopment");
  }
  return aboutText(locale, "installDetecting");
}

function getUpdateDescription(locale: Locale, result: UpdateCheckResult, hasUpdate: boolean, hasError: boolean): string {
  const values = {
    currentVersion: result.currentVersion,
    releaseName: result.releaseName,
    errorMessage: result.errorMessage ?? "",
  };
  if (hasError) {
    return aboutText(locale, "updateCheckFailedDescription", values);
  }

  if (!hasUpdate) {
    return aboutText(locale, "noUpdateDescription", values);
  }

  if (result.installSource === "homebrew") {
    return aboutText(locale, "homebrewUpdateDescription", values);
  }
  if (result.installSource === "development") {
    return aboutText(locale, "developmentUpdateDescription", values);
  }
  return aboutText(locale, "manualUpdateDescription", values);
}

function createPreviewUpdateResult(locale: Locale, kind: UpdateDialogPreviewKind): UpdateCheckResult {
  const baseResult: UpdateCheckResult = {
    currentVersion: ABOUT_INFO.version,
    latestVersion: "1.2.0",
    hasUpdate: true,
    releaseUrl: `${ABOUT_INFO.repositoryUrl}/releases/tag/v1.2.0`,
    releaseName: "v1.2.0",
    releaseBody: "### 新增\n\n- 示例：演示用 release notes 渲染。\n\n### 修复\n\n- 示例：演示项。",
    publishedAt: "",
    homebrewCommand: "brew upgrade --cask kimi-code-switch-gui",
    installSource: "manual",
  };

  if (kind === "current") {
    return {
      ...baseResult,
      latestVersion: ABOUT_INFO.version,
      hasUpdate: false,
      releaseUrl: `${ABOUT_INFO.repositoryUrl}/releases/tag/v${ABOUT_INFO.version}`,
      releaseName: `v${ABOUT_INFO.version}`,
      releaseBody: "",
    };
  }

  if (kind === "available-homebrew") {
    return {
      ...baseResult,
      installSource: "homebrew",
    };
  }

  if (kind === "error") {
    return {
      ...baseResult,
      latestVersion: "",
      hasUpdate: false,
      releaseUrl: `${ABOUT_INFO.repositoryUrl}/releases`,
      releaseName: "",
      releaseBody: "",
      errorMessage: aboutText(locale, "previewRateLimitError"),
    };
  }

  return baseResult;
}

function UpdateDialog(props: {
  locale: Locale;
  result: UpdateCheckResult;
  copiedCommand: boolean;
  copiedReleaseUrl: boolean;
  onCopyCommand: () => void;
  onOpenRelease: () => void;
  onClose: () => void;
}): JSX.Element {
  useDialogEscape(props.onClose);

  const hasError = Boolean(props.result.errorMessage);
  const hasUpdate = props.result.hasUpdate || compareReleaseVersions(props.result.latestVersion, props.result.currentVersion) > 0;
  const isUpToDate = !hasError && !hasUpdate;
  const title = hasError
    ? aboutText(props.locale, "updateFailedTitle")
    : hasUpdate
      ? aboutText(props.locale, "updateAvailableTitle")
      : aboutText(props.locale, "updateCurrentTitle");
  const description = getUpdateDescription(props.locale, props.result, hasUpdate, hasError);
  const showHomebrewCommand = hasUpdate && props.result.installSource === "homebrew";

  return createPortal(
    <div
      className="confirm-dialog-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          props.onClose();
        }
      }}
    >
      <section
        className={[
          "confirm-dialog",
          "update-dialog",
          "glass-panel",
          isUpToDate ? "update-dialog-compact update-dialog-current" : "",
          hasError ? "update-dialog-error" : "",
          hasUpdate ? "update-dialog-available" : "",
        ].filter(Boolean).join(" ")}
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
      >
        <div className="update-dialog-topline" aria-hidden="true">
          <span className="update-dialog-topline-label">
            {hasError
              ? aboutText(props.locale, "statusFailed")
              : hasUpdate
                ? aboutText(props.locale, "statusAvailable")
                : aboutText(props.locale, "statusCurrent")}
          </span>
          {!isUpToDate ? (
            <span className="update-dialog-topline-version">
              v{props.result.currentVersion}
            </span>
          ) : null}
        </div>
        <div className="confirm-dialog-header update-dialog-header">
          <div
            className={[
              "confirm-dialog-icon",
              "update-dialog-icon",
              isUpToDate ? "update-dialog-icon-current" : "",
              hasError ? "update-dialog-icon-error" : "",
            ].filter(Boolean).join(" ")}
          >
            {isUpToDate ? <Check size={22} strokeWidth={2.6} /> : <RefreshCw size={20} />}
          </div>
          <div className="confirm-dialog-copy update-dialog-copy">
            <div className="update-dialog-title-row">
              <h3 id="update-dialog-title">{title}</h3>
              {hasUpdate ? (
                <span className="update-dialog-badge">
                  {aboutText(props.locale, "updateRecommended")}
                </span>
              ) : null}
              {hasError ? (
                <span className="update-dialog-badge update-dialog-badge-error">
                  {aboutText(props.locale, "manualCheckNeeded")}
                </span>
              ) : null}
            </div>
            {hasUpdate ? (
              <div className="update-dialog-version-row">
                <div className="update-dialog-version-card">
                  <span>{aboutText(props.locale, "currentVersion")}</span>
                  <strong>v{props.result.currentVersion}</strong>
                </div>
                <div className="update-dialog-version-separator" aria-hidden="true">
                  →
                </div>
                <div className="update-dialog-version-card">
                  <span>{aboutText(props.locale, "latestVersion")}</span>
                  <strong>v{props.result.latestVersion}</strong>
                </div>
              </div>
            ) : null}
            <div className="update-dialog-body">
              <p>{description}</p>
            </div>
            {showHomebrewCommand ? (
              <div className="update-dialog-command-block">
                <span className="update-dialog-command-label">
                  {aboutText(props.locale, "homebrewCommand")}
                </span>
                <code>{props.result.homebrewCommand}</code>
              </div>
            ) : null}
            {hasError ? (
              <div className="update-dialog-error-tip">
                {aboutText(props.locale, "manualReleaseTip")}
              </div>
            ) : null}
            {hasUpdate && props.result.releaseBody ? (
              <div className="update-dialog-release-notes">
                <div className="update-dialog-release-notes-title">
                  {aboutText(props.locale, "newReleaseNotes")} · {props.result.releaseName}
                </div>
                <MarkdownView content={props.result.releaseBody} locale={props.locale} />
              </div>
            ) : null}
          </div>
        </div>
        <div className="confirm-dialog-actions update-dialog-actions">
          {showHomebrewCommand ? (
            <button className="action-button update-dialog-button update-dialog-button-secondary" type="button" onClick={props.onCopyCommand}>
              {props.copiedCommand ? aboutText(props.locale, "copiedCommand") : aboutText(props.locale, "copyHomebrewCommand")}
            </button>
          ) : null}
          {hasUpdate || hasError ? (
            <button className="action-button update-dialog-button update-dialog-button-primary" type="button" onClick={props.onOpenRelease}>
              {props.copiedReleaseUrl
                ? aboutText(props.locale, "releaseUrlCopied")
                : aboutText(props.locale, "openGithubRelease")}
            </button>
          ) : null}
          <button
            className={isUpToDate ? "action-button update-dialog-button update-dialog-button-primary" : "action-button update-dialog-button update-dialog-button-ghost"}
            type="button"
            onClick={props.onClose}
          >
            {t(props.locale, "close")}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function useChangelogForCurrentVersion(locale: Locale): string {
  const bundledNotes = useMemo(
    () => extractReleaseNotes(getBundledChangelog(locale), ABOUT_INFO.version),
    [locale],
  );
  const [notes, setNotes] = useState<string>(bundledNotes);

  useEffect(() => {
    setNotes(bundledNotes);
    let cancelled = false;
    void window.kimiSwitch?.readChangelog?.(locale).then((cached) => {
      if (cancelled || !cached) {
        return;
      }
      const extracted = extractReleaseNotes(cached, ABOUT_INFO.version);
      if (extracted) {
        setNotes(extracted);
      }
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [locale, bundledNotes]);

  return notes;
}

export function AboutPage(props: {
  locale: Locale;
  embedded?: boolean;
}): JSX.Element {
  const isDev = import.meta.env.DEV;
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [updateCheckCooldownUntil, setUpdateCheckCooldownUntil] = useState(0);
  const [cooldownRemainingSeconds, setCooldownRemainingSeconds] = useState(0);
  const [updateDialog, setUpdateDialog] = useState<UpdateCheckResult | null>(null);
  const [copiedUpdateCommand, setCopiedUpdateCommand] = useState(false);
  const [copiedReleaseUrl, setCopiedReleaseUrl] = useState(false);
  const [installSource, setInstallSource] = useState<InstallSource | "unknown">("unknown");
  const [pendingUpdateVersion, setPendingUpdateVersion] = useState(() => loadPendingUpdateVersion());
  const [localCliVersion, setLocalCliVersion] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    void window.kimiSwitch?.getCliVersion?.({ target: "kimi-code" })
      .then((result) => {
        if (!cancelled && result?.installed && result.version) {
          setLocalCliVersion(result.version);
        }
      })
      .catch(() => { /* 忽略，兼容性仍可展示基线 */ });
    return () => { cancelled = true; };
  }, []);
  const currentReleaseNotes = useChangelogForCurrentVersion(props.locale);
  const links = [
    {
      icon: Github,
      label: aboutText(props.locale, "githubLink"),
      value: ABOUT_INFO.repositoryUrl,
    },
    {
      icon: Bug,
      label: aboutText(props.locale, "reportIssues"),
      value: ABOUT_INFO.issuesUrl,
    },
    {
      icon: ExternalLink,
      label: aboutText(props.locale, "authorBlog"),
      value: ABOUT_INFO.authorBlogUrl,
    },
    {
      icon: Mail,
      label: aboutText(props.locale, "contactEmail"),
      value: `mailto:${ABOUT_INFO.contactEmail}`,
      displayValue: ABOUT_INFO.contactEmail,
    },
  ];
  const hasPendingUpdate =
    pendingUpdateVersion.length > 0 && compareReleaseVersions(pendingUpdateVersion, ABOUT_INFO.version) > 0;
  const isCheckOnCooldown = cooldownRemainingSeconds > 0;
  const updateDialogPreviewItems: Array<{ kind: UpdateDialogPreviewKind; label: string }> = [
    { kind: "error", label: aboutText(props.locale, "previewFailure") },
    { kind: "available-homebrew", label: aboutText(props.locale, "previewHomebrewUpdate") },
    { kind: "available-manual", label: aboutText(props.locale, "previewManualUpdate") },
    { kind: "current", label: aboutText(props.locale, "previewCurrent") },
  ];

  useEffect(() => {
    const api = getApi();
    if (!api?.getInstallSource) {
      return;
    }

    void api.getInstallSource()
      .then((source) => setInstallSource(source))
      .catch(() => setInstallSource("unknown"));
  }, []);

  useEffect(() => {
    if (!updateCheckCooldownUntil) {
      setCooldownRemainingSeconds(0);
      return;
    }

    const updateRemaining = (): void => {
      const remaining = Math.max(0, Math.ceil((updateCheckCooldownUntil - Date.now()) / 1000));
      setCooldownRemainingSeconds(remaining);
      if (remaining <= 0) {
        setUpdateCheckCooldownUntil(0);
      }
    };

    updateRemaining();
    const intervalId = window.setInterval(updateRemaining, 250);
    return () => window.clearInterval(intervalId);
  }, [updateCheckCooldownUntil]);

  useEffect(() => {
    if (!pendingUpdateVersion) {
      return;
    }

    if (compareReleaseVersions(pendingUpdateVersion, ABOUT_INFO.version) <= 0) {
      clearPendingUpdateVersion();
      setPendingUpdateVersion("");
    }
  }, [pendingUpdateVersion]);

  const openRelease = (url: string): void => {
    const api = getApi();
    const openTask = api?.openExternal ? api.openExternal(url) : Promise.reject(new Error("Open external unavailable"));
    void openTask.catch(() => {
      void copyText(url).then((copied) => {
        if (!copied) {
          return;
        }
        setCopiedReleaseUrl(true);
        window.setTimeout(() => setCopiedReleaseUrl(false), 1800);
      });
    });
  };

  const handleCheckUpdates = (): void => {
    const api = getApi();
    if (!api?.checkForUpdates || isCheckingUpdate || isCheckOnCooldown) {
      return;
    }

    setIsCheckingUpdate(true);
    setUpdateCheckCooldownUntil(Date.now() + UPDATE_CHECK_COOLDOWN_MS);
    void api.checkForUpdates()
      .then((result) => {
        const shouldMarkPending = result.hasUpdate || compareReleaseVersions(result.latestVersion, result.currentVersion) > 0;

        setInstallSource(result.installSource ?? installSource);
        if (shouldMarkPending) {
          savePendingUpdateVersion(result.latestVersion);
          setPendingUpdateVersion((current) => {
            if (!current || compareReleaseVersions(result.latestVersion, current) > 0) {
              return normalizeReleaseVersion(result.latestVersion);
            }
            return current;
          });
        }
        setCopiedUpdateCommand(false);
        setCopiedReleaseUrl(false);
        setUpdateDialog(result);
      })
      .catch((error) => {
        const rawMessage = error instanceof Error ? error.message : String(error);
        const message = rawMessage.includes("GitHub API rate limit exceeded")
          ? aboutText(props.locale, "previewRateLimitError")
          : rawMessage;
        setUpdateDialog({
          currentVersion: ABOUT_INFO.version,
          latestVersion: "",
          hasUpdate: false,
          releaseUrl: `${ABOUT_INFO.repositoryUrl}/releases`,
          releaseName: "",
          publishedAt: "",
          homebrewCommand: "brew upgrade --cask kimi-code-switch-gui",
          installSource: installSource === "unknown" ? undefined : installSource,
          errorMessage: message,
        });
      })
      .finally(() => {
        setIsCheckingUpdate(false);
      });
  };

  const openPreviewDialog = (kind: UpdateDialogPreviewKind): void => {
    setCopiedUpdateCommand(false);
    setCopiedReleaseUrl(false);
    setUpdateDialog(createPreviewUpdateResult(props.locale, kind));
  };
  const className = props.embedded ? "about-page about-page-embedded" : "glass-panel about-page";

  return (
    <section className={className}>
      <div className="about-hero">
        <div className="about-logo">
          <img className="brand-logo brand-logo-light" src={logoLight} alt="Kimi Code Switch" />
          <img className="brand-logo brand-logo-dark" src={logoDark} alt="Kimi Code Switch" />
        </div>
        <div>
          <h2>Kimi Code Switch GUI</h2>
          <p>{aboutText(props.locale, "aboutDescription")}</p>
          <p className="about-meta-summary">
            {aboutText(props.locale, "aboutMeta", {
              author: ABOUT_INFO.author,
              license: ABOUT_INFO.license,
              source: formatInstallSource(props.locale, installSource),
            })}
          </p>
        </div>
        <div className="about-version-actions">
          <span className="about-version-wrap">
            <span className={hasPendingUpdate ? "about-version has-update" : "about-version"}>
              <span>v{ABOUT_INFO.version}</span>
              {hasPendingUpdate ? <span className="about-version-status-dot" aria-hidden="true" /> : null}
            </span>
          </span>
          <button
            className={isCheckingUpdate ? "action-button compact is-loading" : "action-button compact"}
            type="button"
            onClick={handleCheckUpdates}
            disabled={isCheckingUpdate || isCheckOnCooldown}
          >
            {isCheckingUpdate ? <LoaderCircle size={14} className="button-spinner" /> : <RefreshCw size={14} />}
            <span>
              {isCheckingUpdate
                ? aboutText(props.locale, "checking")
                : isCheckOnCooldown
                  ? aboutText(props.locale, "retryIn", { seconds: cooldownRemainingSeconds })
                  : aboutText(props.locale, "checkUpdates")}
            </span>
          </button>
        </div>
      </div>

      <section className="about-section about-section-wide about-compat">
        <div className="section-title about-section-title">
          <ShieldCheck size={16} />
          <span>{compatText(props.locale, "compatTitle")}</span>
        </div>
        <p className="about-compat-baseline">
          {compatText(props.locale, "compatBaseline", {
            version: OFFICIAL_BASELINE.version,
            commit: OFFICIAL_BASELINE.commit,
            date: OFFICIAL_BASELINE.releaseDate,
          })}
        </p>
        <p className="about-compat-local">
          {localCliVersion
            ? compatText(props.locale, "compatLocal", { version: localCliVersion })
            : compatText(props.locale, "compatNone")}
        </p>
        <table className="about-compat-table">
          <thead>
            <tr>
              <th>{compatText(props.locale, "compatCapability")}</th>
              <th>{compatText(props.locale, "compatStatus")}</th>
            </tr>
          </thead>
          <tbody>
            {CAPABILITY_TIERS.map((capability) => (
              <tr key={capability.key}>
                <td className="about-compat-capability">{compatText(props.locale, capability.i18nKey)}</td>
                <td>
                  <span className={`status-pill ${capability.tier === "supported" ? "on" : capability.tier === "passthrough" ? "" : "off"}`}>
                    {compatText(props.locale, `compatTier${capability.tier.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("")}`)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="about-compat-risk">
          <TriangleAlert size={15} />
          <strong>{compatText(props.locale, "compatRiskTitle")}</strong>
          <p>{compatText(props.locale, "compatRiskBody")}</p>
        </div>
      </section>

      {isDev ? (
        <section className="about-preview-panel">
          <div className="section-title about-section-title">
            <RefreshCw size={16} />
            <span>{aboutText(props.locale, "updatePreviewTitle")}</span>
          </div>
          <div className="about-preview-copy">
            <span>{aboutText(props.locale, "updatePreviewDescription")}</span>
          </div>
          <div className="about-preview-actions">
            {updateDialogPreviewItems.map((item) => (
              <button
                key={item.kind}
                className="action-button compact about-preview-button"
                type="button"
                onClick={() => openPreviewDialog(item.kind)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="about-section about-section-wide">
        <div className="section-title about-section-title">
          <ExternalLink size={16} />
          <span>{aboutText(props.locale, "projectLinks")}</span>
        </div>
        <div className="about-link-grid">
          {links.map(({ icon: Icon, label, value }) => (
            <button
              key={label}
              className="about-link-item"
              type="button"
              title={label}
              aria-label={label}
              onClick={() => openRelease(value)}
            >
              <span className="about-link-icon"><Icon size={28} /></span>
              <strong>{label}</strong>
            </button>
          ))}
        </div>
      </section>

      <section className="about-section about-release-notes">
        <div className="section-title about-section-title about-release-notes-header">
          <div className="about-release-notes-heading">
            <FileText size={16} />
            <span>{aboutText(props.locale, "currentReleaseNotes")} · v{ABOUT_INFO.version}</span>
          </div>
          <button
            className="about-release-notes-link"
            type="button"
            onClick={() => openRelease(`${ABOUT_INFO.repositoryUrl}/releases`)}
          >
            <span>{aboutText(props.locale, "viewAllVersions")}</span>
            <ExternalLink size={13} />
          </button>
        </div>
        {currentReleaseNotes ? (
          <MarkdownView content={currentReleaseNotes} locale={props.locale} />
        ) : (
          <p className="about-release-notes-empty">{aboutText(props.locale, "currentReleaseNotesEmpty")}</p>
        )}
      </section>

      {updateDialog ? (
        <UpdateDialog
          locale={props.locale}
          result={updateDialog}
          copiedCommand={copiedUpdateCommand}
          copiedReleaseUrl={copiedReleaseUrl}
          onCopyCommand={() => {
            void copyText(updateDialog.homebrewCommand).then((copied) => {
              if (!copied) {
                return;
              }

              setCopiedUpdateCommand(true);
              window.setTimeout(() => setCopiedUpdateCommand(false), 1800);
            });
          }}
          onOpenRelease={() => openRelease(updateDialog.releaseUrl)}
          onClose={() => {
            setCopiedUpdateCommand(false);
            setCopiedReleaseUrl(false);
            setUpdateDialog(null);
          }}
        />
      ) : null}
    </section>
  );
}
