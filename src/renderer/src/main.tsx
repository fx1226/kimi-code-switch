import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import { isDesktopRuntime } from "./runtime";
import "./styles.css";

function render(): void {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

const isUiFixturePreview = import.meta.env.DEV
  && new URLSearchParams(window.location.search).has("ui-fixture");

// 本地 Node 服务的探活窗口要足够短，避免无服务时白屏等待。
const PING_TIMEOUT_MS = 800;

async function isLocalServerAvailable(): Promise<boolean> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const response = await fetch("/api/ping", { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
}

// A fixture is available only to local development/visual capture. It never
// participates in the Tauri build and avoids putting a real local configuration
// (including profile names or endpoints) into screenshots or documentation.
if (isUiFixturePreview) {
  void import("./uiFixture").then(({ installUiFixture }) => {
    installUiFixture();
    render();
  });
// Tauri 环境下先注入 window.kimiSwitch 适配器再渲染。
} else if (isDesktopRuntime()) {
  void import("./tauri/kimiSwitch").then(({ installKimiSwitchTauri }) => {
    installKimiSwitchTauri();
    render();
  });
} else {
  // 浏览器形态：本地 Node 服务可达时注入 HTTP 适配器；否则退回纯渲染（现状）。
  void isLocalServerAvailable().then((available) => {
    if (!available) {
      render();
      return;
    }
    void import("./http/kimiSwitchHttp").then(({ installKimiSwitchHttp }) => {
      installKimiSwitchHttp();
      render();
    });
  });
}
