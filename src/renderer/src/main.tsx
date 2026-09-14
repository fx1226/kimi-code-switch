import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
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

// A fixture is available only to local development/visual capture. It never
// participates in the Tauri build and avoids putting a real local configuration
// (including profile names or endpoints) into screenshots or documentation.
if (isUiFixturePreview) {
  void import("./uiFixture").then(({ installUiFixture }) => {
    installUiFixture();
    render();
  });
// Tauri 环境下先注入 window.kimiSwitch 适配器再渲染。
} else if ("__TAURI_INTERNALS__" in window) {
  void import("./tauri/kimiSwitch").then(({ installKimiSwitchTauri }) => {
    installKimiSwitchTauri();
    render();
  });
} else {
  render();
}
