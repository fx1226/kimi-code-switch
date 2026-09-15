// ChatGPT 订阅桥接：设置 → Kimi Code → 账号 下的独立面板。
// 依赖 Rust 宿主命令（tauri/chatgptBridge.ts）与 shared 绑定逻辑（@shared/chatgptBridge）。
import { useEffect, useState } from "react";
import { ExternalLink, LoaderCircle, LogIn, LogOut, Power, RefreshCw, Save, Trash2 } from "lucide-react";

import {
  deleteModel,
  deleteProfile,
  deleteProvider,
  upsertModel,
  upsertProvider,
} from "@shared/configStore";
import {
  buildBridgeModelConfig,
  buildBridgeProviderConfig,
  getBindingForEnvironment,
  planUnbind,
  removeBindingForEnvironment,
  setBindingForEnvironment,
} from "@shared/chatgptBridge";
import type { AppState, Locale } from "@shared/types";
import { createUniqueName } from "./appHelpers";
import { t } from "./i18n";
import { SettingsGroup } from "./formControls";
import {
  BRIDGE_OAUTH_REDIRECT_PORT,
  bridgeLogin,
  bridgeLogout,
  bridgeRefreshModels,
  bridgeStart,
  bridgeStatus,
  bridgeStop,
  bridgeWaitLogin,
  type BridgeCatalogModel,
  type BridgeStatusResult,
} from "./tauri/chatgptBridge";

interface Props {
  locale: Locale;
  state: AppState;
  updateState: (updater: (draft: AppState) => void, options?: { persist?: boolean }) => void;
  setError: (message: string) => void;
  setNotice: (message: string) => void;
}

function randomSecret(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function currentEnvironmentId(state: AppState): string {
  return state.panelSettings.active_kimi_code_environment_id ?? "default";
}

export function ChatgptBridgePanel(props: Props): JSX.Element {
  const { locale, state, updateState, setError, setNotice } = props;
  const environmentId = currentEnvironmentId(state);
  const binding = getBindingForEnvironment(state, environmentId);

  const [status, setStatus] = useState<BridgeStatusResult | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [models, setModels] = useState<BridgeCatalogModel[]>([]);
  // 未绑定时生成一次并复用：启动桥接与写入配置必须使用同一个密钥，否则 401。
  const [sessionSecret] = useState(() => randomSecret());

  const loadStatus = (): void => {
    void bridgeStatus()
      .then(setStatus)
      .catch((error: unknown) => setStatus({ running: false, port: 0, auth: { status: "signed-out" }, catalog: null, ok: false }));
  };

  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshModels = async (): Promise<BridgeCatalogModel[]> => {
    const catalog = await bridgeRefreshModels();
    const list = catalog.models ?? [];
    setModels(list);
    return list;
  };

  const handleLogin = async (): Promise<void> => {
    if (busy) return;
    setBusy("login");
    try {
      const port = binding?.bridgePort ?? 8317;
      const secret = binding?.bridgeSecret ?? sessionSecret;
      const started = await bridgeStart(port, secret);
      setStatus(started);
      if (started.auth.status === "signed-in") {
        setNotice(t(locale, "chatgptBridgeLoginOk"));
        void refreshModels().catch(() => undefined);
        return;
      }
      const { url } = await bridgeLogin(BRIDGE_OAUTH_REDIRECT_PORT);
      await window.kimiSwitch?.openExternal?.(url);
      await bridgeWaitLogin();
      setNotice(t(locale, "chatgptBridgeLoginOk"));
      loadStatus();
      void refreshModels().catch(() => undefined);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const handleApply = async (): Promise<void> => {
    if (busy) return;
    setBusy("apply");
    try {
      const catalogModels = models.length > 0 ? models : await refreshModels();
      if (catalogModels.length === 0) {
        setError(t(locale, "chatgptBridgeNoModels"));
        return;
      }
      const port = binding?.bridgePort ?? 8317;
      const secret = binding?.bridgeSecret ?? sessionSecret;
      // 已有绑定时复用其 provider 名（“重新应用/同步模型”应更新而非新建）。
      const providerName =
        binding?.providerName ?? createUniqueName("chatgpt-bridge", Object.keys(state.mainConfig.providers));
      const savedModels: string[] = [];
      updateState((draft) => {
        upsertProvider(draft, providerName, buildBridgeProviderConfig({ bridgePort: port, bridgeSecret: secret }));
        for (const entry of catalogModels) {
          const alias = `chatgpt/${entry.slug}`;
          upsertModel(draft, alias, buildBridgeModelConfig(providerName, entry.slug, entry));
          savedModels.push(alias);
        }
        setBindingForEnvironment(draft, environmentId, {
          environmentId,
          providerName,
          modelAliases: savedModels,
          bridgePort: port,
          bridgeSecret: secret,
          createdAt: new Date().toISOString(),
        });
      });
      setNotice(t(locale, "chatgptBridgeApplied"));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const handleUnbind = async (): Promise<void> => {
    if (busy || !binding) return;
    setBusy("unbind");
    try {
      const plan = planUnbind(state, binding);
      updateState((draft) => {
        for (const alias of plan.modelsToRemove) deleteModel(draft, alias);
        if (plan.providerRemovable) deleteProvider(draft, binding.providerName);
        if (plan.profileRemovable && binding.profileName) deleteProfile(draft, binding.profileName);
        removeBindingForEnvironment(draft, environmentId);
      });
      setNotice(t(locale, "chatgptBridgeUnbound"));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const handleLogout = async (): Promise<void> => {
    if (busy) return;
    setBusy("logout");
    try {
      await bridgeLogout();
      loadStatus();
      setNotice(t(locale, "chatgptBridgeLoggedOut"));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const handleStop = async (): Promise<void> => {
    if (busy) return;
    setBusy("stop");
    try {
      await bridgeStop();
      setStatus(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const signedIn = status?.auth.status === "signed-in";
  const running = status?.running === true;

  return (
    <SettingsGroup>
      <div className="chatgpt-bridge-panel">
        <div className="chatgpt-bridge-head">
          <strong>{t(locale, "chatgptBridgeTitle")}</strong>
          <span>{t(locale, "chatgptBridgeSubtitle")}</span>
        </div>
        <div className="chatgpt-bridge-status">
          <span className={`status-dot ${running ? "ok" : ""}`} />
          <em>
            {running
              ? signedIn
                ? t(locale, "chatgptBridgeStatusRunning")
                : t(locale, "chatgptBridgeStatusNoLogin")
              : t(locale, "chatgptBridgeStatusStopped")}
          </em>
          {binding ? <code>{binding.providerName}</code> : null}
        </div>
        <div className="chatgpt-bridge-actions">
          {!signedIn ? (
            <button className="action-button" type="button" disabled={busy !== null} onClick={() => void handleLogin()}>
              {busy === "login" ? <LoaderCircle size={14} className="button-spinner" /> : <LogIn size={14} />}
              <span>{t(locale, "chatgptBridgeLogin")}</span>
            </button>
          ) : null}
          {signedIn ? (
            <button className="action-button" type="button" disabled={busy !== null} onClick={() => void handleApply()}>
              {busy === "apply" ? <LoaderCircle size={14} className="button-spinner" /> : <Save size={14} />}
              <span>{binding ? t(locale, "chatgptBridgeReapply") : t(locale, "chatgptBridgeApply")}</span>
            </button>
          ) : null}
          {signedIn ? (
            <button className="action-button secondary" type="button" disabled={busy !== null} onClick={() => void handleLogout()}>
              <LogOut size={14} />
              <span>{t(locale, "chatgptBridgeLogout")}</span>
            </button>
          ) : null}
          {binding ? (
            <button className="action-button danger" type="button" disabled={busy !== null} onClick={() => void handleUnbind()}>
              <Trash2 size={14} />
              <span>{t(locale, "chatgptBridgeUnbind")}</span>
            </button>
          ) : null}
          {running ? (
            <button className="action-button secondary" type="button" disabled={busy !== null} onClick={() => void handleStop()}>
              <Power size={14} />
              <span>{t(locale, "chatgptBridgeStop")}</span>
            </button>
          ) : null}
          {signedIn ? (
            <button className="action-button secondary" type="button" disabled={busy !== null} onClick={() => void refreshModels().catch(() => undefined)}>
              <RefreshCw size={14} />
              <span>{t(locale, "chatgptBridgeRefresh")}</span>
            </button>
          ) : null}
        </div>
        {models.length > 0 ? (
          <div className="chatgpt-bridge-models">
            <strong>{t(locale, "chatgptBridgeModels")}</strong>
            <ul>
              {models.map((entry) => (
                <li key={entry.slug}>
                  <code>{entry.slug}</code>
                  {entry.display_name ? <span>{entry.display_name}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {!running && !signedIn ? <p className="form-note">{t(locale, "chatgptBridgeHint")}</p> : null}
      </div>
    </SettingsGroup>
  );
}
