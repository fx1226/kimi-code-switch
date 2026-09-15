// @iarna/toml 只为包入口提供类型声明，子路径导出（parse-string.js / stringify.js）
// 缺少声明文件。这里补齐子路径模块：parse 与主入口一致；stringify 参数放宽为
// Record<string, unknown>（本项目的 TOML 文档模型均为 plain record，官方 JsonMap
// 类型未从包入口导出，无法在调用方引用）。
declare module "@iarna/toml/parse-string.js" {
  import { parse } from "@iarna/toml";
  export default parse;
}

declare module "@iarna/toml/stringify.js" {
  const stringify: (obj: Record<string, unknown>) => string;
  export default stringify;
}
