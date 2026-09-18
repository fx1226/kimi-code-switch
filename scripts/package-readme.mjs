/** Release archives have three files; their instructions must not depend on source-tree assets. */
export function renderPackageReadme(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid package README version");
  return `# Kimi Code Switch ${version}

适用于 macOS Apple Silicon (arm64) 的本地网页配置工具。此压缩包包含自带运行时和网页资源的独立可执行文件，无需安装系统 Node.js。Kimi Code CLI 请按官方方式另行安装。

解压后，在该目录打开终端：

\`\`\`sh
./kimi-code-switch --help
./kimi-code-switch start
\`\`\`

\`start\` 在当前终端运行服务并打开浏览器；省略命令也会启动。保持服务进程运行，关闭网页不会停止服务。在另一个终端管理同一服务：

\`\`\`sh
./kimi-code-switch open
./kimi-code-switch status
./kimi-code-switch stop
\`\`\`

\`open\` 打开已运行服务的页面；没有运行中的服务时会启动服务。\`status\` 显示运行状态，\`stop\` 正常停止服务。

需要手动控制打开页面、端口或本工具的数据目录时：

\`\`\`sh
./kimi-code-switch start --no-open
./kimi-code-switch start --port 8417 --data-dir "$HOME/.kimi-code-switch-custom"
./kimi-code-switch open --data-dir "$HOME/.kimi-code-switch-custom"
./kimi-code-switch status --data-dir "$HOME/.kimi-code-switch-custom"
./kimi-code-switch stop --data-dir "$HOME/.kimi-code-switch-custom"
\`\`\`

服务仅监听本机 \`127.0.0.1\`，默认端口为 \`8417\`；端口被占用时尝试后续可用端口。\`--no-open\` 禁止自动打开浏览器，之后可用 \`open\` 打开带本地鉴权的页面。

本工具的设置、备份、历史和服务状态默认存放在 \`~/.kimi-code-switch\`。使用 \`--data-dir\` 后，启动、打开、查询和停止时应指定同一目录；它不会改变 Kimi Code 的原生配置目录。

原生配置默认来自 \`KIMI_CODE_HOME\`；未设置时使用 \`~/.kimi-code\`。也可在界面选择其他原生数据目录。对原生配置的变更会直接修改所选目录内的 Kimi Code 文件：先预览变更，再执行应用（apply）；请核对目标目录和差异。工具会检查支持的官方 CLI 版本，并对 config.toml、tui.toml 候选文件执行官方校验。

如需从启动时指定官方原生目录，先停止已有服务，再设置环境变量启动：

\`\`\`sh
KIMI_CODE_HOME="$HOME/.kimi-code-work" ./kimi-code-switch start
\`\`\`

在线说明、源码和问题反馈：[fx1226/kimi-code-switch](https://github.com/fx1226/kimi-code-switch)。许可证见包内 LICENSE。
`;
}
