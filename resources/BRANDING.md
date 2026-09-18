# Kimi Code Switch 图标

2026-09-18 选定 D「配置小管家」方案：蓝色 Kimi 吉祥物抱着双滑块面板。保留圆润身体、白色胶囊眼睛、双手和配置面板，不增加嘴巴、齿轮或环绕箭头。

## 维护与导出

- `icon.svg` 是正式可编辑母版，1024×1024，外部透明、浅色圆角底板。
- `src/renderer/src/assets/logo-light.png` 与 `logo-dark.png` 是界面的浅色／深色版本，人物和滑块位置保持一致。
- `node scripts/build-icons.mjs` 从 SVG 母版生成 `src/renderer/public/favicon.svg`，无需 Tauri 或平台图标工具链。
- `resources/icon.png` 保留为通用预览。浏览器版本不生成 ICNS、ICO、托盘或桌面安装包资源。

## 设计来源

概念稿使用内置 ImageGen 绘制，正式母版按选定 D 方案以 SVG 重建。选定概念稿、参考图与提示词位于 `output/logo-concepts/`，生产运行不依赖该目录。

- [形象参考](https://avatar.moonshot.cn/avatar/cvbt6roh8njvmnldsfs0/1742214499819940.png)
- [配色参考](https://www.kimi.com/resources/kimi-brand)

本图标用于独立维护的 Kimi Code Switch 配置工具，不表示该工具是 Kimi 官方客户端。
