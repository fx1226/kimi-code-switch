import type { ApiErrorPayload, WebMethod } from "@shared/webApi";
import { redactResourcePreview } from "../configuration";

// Error messages from parsers, subprocesses and upstream servers are untrusted
// data: they can contain entire input lines, tokens, URLs or response bodies.
const messages: Readonly<Record<string, string>> = {
  INVALID_INPUT: "请求参数无效，请检查输入内容。",
  INVALID_JSON: "请求内容必须是有效的 JSON。",
  UNSUPPORTED_STRUCTURE: "无法在保留原文结构与注释的前提下修改此字段，请在原生文件中编辑。",
  INVALID_CONTENT_TYPE: "请求必须使用 application/json。",
  UNKNOWN_METHOD: "此操作不存在或已不可用，请刷新页面。",
  BODY_TOO_LARGE: "请求内容超过大小限制。",
  "conflict": "文件已被其他操作修改，请重新读取并预览变更。",
  "unknown-plan": "变更计划不存在或已过期，请重新生成预览。",
  "wrong-target": "此变更计划不属于当前数据目录，请选择对应目录。",
  "recovery-required": "存在尚未完成的恢复事务，请先在恢复页面处理。",
  "unknown-recovery": "恢复记录不存在或已变化，请刷新恢复页面。",
  "recovery-export-required": "请先导出原始恢复记录，再确认保留当前文件。",
  "invalid-recovery-decision": "恢复选项无效，请刷新并重新确认。",
  "unknown-revision": "文件版本无法确认，请在恢复页面检查当前文件。",
  "archive-conflict": "恢复归档已存在不同内容，请检查归档后再重试。",
  "archive-failed": "恢复归档未完成，当前文件未被报告为保存成功。",
  "legacy-process-running": "旧版程序仍在运行，请关闭旧版后再继续。",
  "migration-pending": "请先完成旧版私有数据迁移，再执行写入操作。",
  "unverified-version": "当前 Kimi Code CLI 版本尚未验证，原生配置仅可读取。",
  "official-validation-failed": "官方 doctor 未接受候选配置，请检查字段格式。",
  "official-validation-required": "本次写入需要官方校验，请确认已安装支持的 Kimi Code CLI。",
  "invalid-document": "原生文件格式无效，请修复后再进行结构化编辑。",
  "invalid-native-value": "变更中的字段类型或引用关系无效，请检查修改内容。",
  "invalid-change": "变更格式无效，请重新生成预览。",
  "invalid-batch": "批量变更必须包含不同且受支持的资源。",
  "invalid-restore": "恢复内容无效，请重新选择备份并预览。",
  "unknown-resource": "此原生资源不受支持。",
  "missing-project": "请先为当前数据目录选择项目工作目录。",
  "invalid-context": "数据目录或项目路径无效，请重新选择。",
  "restore-only-resource": "此资源只能通过备份或历史恢复修改。",
  PERMISSION_DENIED: "无权访问此文件或目录，请检查系统权限并重新选择授权目录。",
  RESOURCE_NOT_FOUND: "所需文件或目录不存在，请刷新或重新选择。",
  RESOURCE_BUSY: "文件或目录正被占用，请稍后重试。",
  OPERATION_TIMEOUT: "操作超时，请检查本地服务或外部连接后重试。",
  MCP_REQUEST_FAILED: "MCP 操作未完成，请检查服务器配置、授权和连接状态。",
  OPERATION_FAILED: "操作未完成，请检查输入与本地资源状态后重试。",
};
const errnoCodes: Readonly<Record<string, string>> = {
  EACCES: "PERMISSION_DENIED", EPERM: "PERMISSION_DENIED", ENOENT: "RESOURCE_NOT_FOUND",
  EBUSY: "RESOURCE_BUSY", ELOCKED: "RESOURCE_BUSY", ETIMEDOUT: "OPERATION_TIMEOUT",
};
const safeMetadataMessages = new Set([
  "所选 Kimi 数据目录不存在，请重新选择。", "未知的数据目录。", "数据目录不存在。",
  "偏好设置格式无效。", "未知的界面主题。", "未知的界面语言。", "目录路径不能为空。",
  "目录必须是无上级跳转的绝对路径。", "项目工作目录不存在或不是文件夹。",
  "项目配置目录不能通过符号链接跳转到其他位置。", "数据目录名称不能为空。",
  "请使用备份预览恢复将原生配置复制到新目录；不会复制登录身份或会话。",
  "外部目录必须已存在；新建目录应位于本工具 environments 下。", "数据目录不是文件夹。",
  "此数据目录已经添加。", "至少保留一个数据目录。", "配置预设不存在。",
  "请先完成旧版私有数据迁移，再保存本工具设置。",
]);
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

/** Only predefined codes and literal messages cross the public error boundary. */
export function toPublicError(error: unknown, method?: WebMethod): ApiErrorPayload {
  let code: unknown;
  let message: unknown;
  try { if (record(error)) { code = error.code; message = error.message; } } catch { /* hostile accessors are not public data */ }
  if (typeof code === "string" && Object.hasOwn(messages, code)) return { code, message: messages[code] };
  if (typeof code === "string" && Object.hasOwn(errnoCodes, code)) {
    const mapped = errnoCodes[code];
    return { code: mapped, message: messages[mapped] };
  }
  if (typeof message === "string" && safeMetadataMessages.has(message)) return { code: "INVALID_INPUT", message };
  // The filesystem's legacy uncoded denial includes a path. Keep its meaning,
  // never its interpolated path or the rest of the exception text.
  if (typeof message === "string" && message.includes("is outside the authorized scope")) {
    return { code: "PERMISSION_DENIED", message: messages.PERMISSION_DENIED };
  }
  const fallback = method === "testMcp" || method === "listMcpTools" || method === "callMcpTool" ? "MCP_REQUEST_FAILED" : "OPERATION_FAILED";
  return { code: fallback, message: messages[fallback] };
}

const diagnosticMessages: Readonly<Record<string, string>> = {
  ...messages,
  "legacy-recovery-required": "检测到旧版未完成事务，请先处理恢复。",
  "invalid-journal": "事务记录无法解析，请导出记录后在恢复页面处理。",
  "unrecognized-journal": "无法识别事务记录，请导出原始记录后确认保留当前文件。",
  "rollback-incomplete": "事务回退未完成，请在恢复页面检查文件状态。",
  "recovered": "已检查中断事务的磁盘状态并完成恢复。",
  "kept-current": "已保留确认后的当前文件，并归档中断事务。",
  "official-validation-unavailable": "已检查本地格式，官方校验当前不可用；未声称已验证。",
  OFFICIAL_DOCTOR_PASSED: "官方 doctor 已接受候选配置；此结果不代表客户端运行时生效。",
  OFFICIAL_DOCTOR_WARNING: "官方 doctor 接受候选配置并返回警告；此结果不代表客户端运行时生效。",
  OFFICIAL_DOCTOR_REJECTED: "官方 doctor 未接受候选配置，请检查字段格式。",
  OFFICIAL_CLI_UNAVAILABLE: "官方 Kimi Code CLI 不存在或不可执行。",
  OFFICIAL_TARGET_UNSUPPORTED: "官方 doctor 不支持验证此资源。",
  OFFICIAL_VERSION_UNVERIFIED: "当前 CLI 版本未对齐，无法执行官方校验。",
  OFFICIAL_VALIDATION_IO_FAILED: "无法完成隔离候选文件校验。",
  OFFICIAL_CANDIDATE_MODIFIED: "候选文件在官方校验期间发生变化，写入已被拒绝。",
  OFFICIAL_EXECUTABLE_CHANGED: "官方可执行文件在校验期间发生变化，请重新验证。",
  OFFICIAL_DOCTOR_UNAVAILABLE: "官方 doctor 未完成校验，请检查 CLI 后重试。",
  OFFICIAL_DOCTOR_UNCONFIRMED: "官方 doctor 未明确确认候选文件的校验结果。",
};
function safeDiagnostic(value: unknown): unknown {
  if (!record(value)) return { severity: "error", message: "检查未完成，请查看对应资源的格式与权限。" };
  const knownCode = typeof value.code === "string" && Object.hasOwn(diagnosticMessages, value.code) ? value.code : undefined;
  return {
    ...(knownCode ? { code: knownCode } : {}),
    severity: ["info", "warning", "warn", "error"].includes(String(value.severity)) ? value.severity : "error",
    message: knownCode ? diagnosticMessages[knownCode] : "此资源存在格式、字段或访问问题，请检查对应文件。",
    ...(typeof value.resource === "string" && ["config", "mcp", "mcp-project", "mcp-local", "tui", "agents", "project-local", "skills-directory", "plugins-directory"].includes(value.resource) ? { resource: value.resource } : {}),
  };
}
function diagnostics(value: unknown): unknown[] { return Array.isArray(value) ? value.map(safeDiagnostic) : []; }
function safeSkillDiagnostic(value: unknown): string {
  if (typeof value === "string") {
    if (value.startsWith("Invalid YAML frontmatter:")) return "Skill 的 YAML frontmatter 格式无效，请检查源文件。";
    if (value.startsWith("Unsupported Skill type:")) return "Skill 的 type 不受支持，请使用 prompt、inline、flow 或 reference。";
    if (value === "Directory-form Skills require a name in YAML frontmatter." || value === "Directory-form Skills require a description in YAML frontmatter.") return value;
  }
  return "Skill 元数据无效，请检查名称、描述和字段格式。";
}
const skillPathReasons = new Set([
  "", "Built-in skills are documented but not scanned from disk.", "Directory not found.",
  "Loaded because merge_all_available_skills is enabled for brand directories.",
  "First existing directory in this priority group.", "Skipped because a higher-priority directory in the same group already exists.",
  "Project-level directory inside this workspace root.", "Loaded because it is listed in config.toml extra_skill_dirs.",
]);
function skillReason(value: unknown): string {
  if (typeof value === "string" && skillPathReasons.has(value)) return value;
  if (typeof value === "string" && value.startsWith("Loaded from enabled plugin ") && !value.includes("Warnings:")) return "Loaded from an enabled plugin.";
  return "技能目录扫描未完全完成，请检查目录权限及 Skill 文件格式。";
}

/** Sanitize diagnostic channels only; authorized resource content remains editable. */
export function sanitizePublicResult(method: WebMethod, result: unknown): unknown {
  if (!record(result) && !Array.isArray(result)) return result;
  if (method === "scanSkills" && record(result)) return {
    ...result,
    paths: Array.isArray(result.paths) ? result.paths.map((path) => record(path) ? { ...path, reason: skillReason(path.reason) } : path) : [],
    skills: Array.isArray(result.skills) ? result.skills.map((skill) => record(skill) ? { ...skill, diagnostics: Array.isArray(skill.diagnostics) ? skill.diagnostics.map(safeSkillDiagnostic) : [] } : skill) : [],
  };
  if (method === "listPlugins" && record(result)) return {
    ...result, diagnostics: diagnostics(result.diagnostics),
    plugins: Array.isArray(result.plugins) ? result.plugins.map((plugin) => record(plugin) ? { ...plugin, diagnostics: diagnostics(plugin.diagnostics) } : plugin) : [],
  };
  if (method === "diagnose" && record(result)) return { ...result, issues: diagnostics(result.issues) };
  if (method === "bootstrap" && record(result) && record(result.recovery)) return {
    ...result, recovery: { ...result.recovery, message: result.recovery.blocked ? messages["recovery-required"] : "" },
  };
  if (method === "previewMigration" && record(result)) return {
    ...result, ...(result.blockedReason !== undefined ? { blockedReason: "迁移暂不可执行，请关闭旧版程序并检查私有目录、目标数据库及恢复记录。" } : {}),
  };
  if (method === "testMcp" && record(result)) return { ok: result.ok === true, stdout: result.ok === true ? "MCP 连接检查已完成。" : messages.MCP_REQUEST_FAILED, stderr: "" };
  if (method === "listMcpTools" && record(result)) return { tools: Array.isArray(result.tools) ? result.tools : [] };
  if (method === "callMcpTool" && record(result)) {
    if (record(result.result) && result.result.isError === true) return { ok: false, result: { isError: true, content: [{ type: "text", text: messages.MCP_REQUEST_FAILED }] } };
    return { ok: result.ok, toolName: result.toolName, result: result.result };
  }
  const safeResult = (item: unknown): unknown => {
    if (!record(item)) return item;
    const preview = record(item.redactedPreview) ? {
      before: redactResourcePreview(typeof item.redactedPreview.before === "string" ? item.redactedPreview.before : ""),
      after: redactResourcePreview(typeof item.redactedPreview.after === "string" ? item.redactedPreview.after : ""),
    } : undefined;
    return { ...item, ...(item.diagnostics !== undefined ? { diagnostics: diagnostics(item.diagnostics) } : {}), ...(preview ? { redactedPreview: preview } : {}) };
  };
  if (["readResource", "planChange", "planPreset", "planRestore", "planHistoryRestore", "applyChange", "getOperation", "listRecoveryCases", "resolveRecovery"].includes(method)) {
    return Array.isArray(result) ? result.map(safeResult) : safeResult(result);
  }
  return result;
}
