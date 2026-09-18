# 官方桌面版兼容性证据

核查时间：2026-09-18。对象为本机 `/Applications/Kimi Code.app` 的 1.0.1 安装包。此记录只证明静态共享实现，不标记桌面运行时验收通过。

- `Contents/Resources/app.asar` SHA-256：`195b03fbf60f07849234c58474d5851d4b473d10d7c8f725dedce05921ce5d04`。
- 包内 `package.json` 为 `kimi-code-app` 1.0.1；`out/screenshot-BrrrwBa-.cjs` 的嵌入服务版本为 2.0.0。
- `out/protocol-BjhRxWFM.cjs` 的 home resolver 读取 `KIMI_CODE_HOME`，否则使用 OS home 下的 `.kimi-code`。共享 runtime 同样采用显式 home → 环境变量 → OS home 的顺序。
- `out/app-DTlWJwMi.cjs` 的 `main()` 对打包程序调用 `requestSingleInstanceLock()`；第二实例会显示原窗口并转发启动动作。因此仅添加临时 `KIMI_CODE_HOME` 不能证明第二实例隔离。
- `out/release-channel-COJfysbq.cjs` 默认执行 shell 环境探测并合并环境，提供 `KIMI_DESKTOP_NO_SHELL_ENV` 开关。即使使用临时 HOME，也必须检查 userData 和 shell probe 的独立性。
- 桌面启动还包含全局快捷键、协议、窗口和后台服务初始化。本轮没有使用未经验证的启动隔离方式运行第二实例，也没有停止或修改用户现有桌面会话。

正式桌面运行验收仍需在独立 macOS 用户会话或专用测试机执行，固定 1.0.1 安装包、全新 OS home 和 Kimi home，逐项验证 Provider、模型、插件与账号共享范围。届时记录官方界面读取结果及原生文件 hash，不能用 Web 界面提示、CLI doctor 或安装包源码代替。

`~/.kimi-code/ui-state.json`、Electron userData、Local Storage 等桌面专属状态不由本工具管理。其配置没有在 Web 表单中伪装为已支持。

参照：[官方桌面与 CLI 共享范围](https://www.kimi.com/code/docs/en/kimi-code-desktop/getting-started.html#desktop-and-the-cli-on-the-same-machine)、[固定官方 2.0 契约](kimi-code-2.0-contract.md)。
