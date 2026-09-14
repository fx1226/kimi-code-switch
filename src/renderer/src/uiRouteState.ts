import {
  isKimiCodeSubTab,
  isSettingsSubTab,
  isTabId,
} from "./appOptions";
import type { KimiCodeSubTab, SettingsSubTab, TabId } from "./appOptions";

export interface UiRouteState {
  activeTab: TabId;
  settingsSubTab: SettingsSubTab;
  kimiCodeSubTab: KimiCodeSubTab;
  selectedProvider: string;
  selectedModel: string;
  selectedProfile: string;
  selectedMcpServer: string;
}

export const DEFAULT_UI_ROUTE_STATE: UiRouteState = {
  activeTab: "overview",
  settingsSubTab: "kimi-code",
  kimiCodeSubTab: "instance",
  selectedProvider: "",
  selectedModel: "",
  selectedProfile: "",
  selectedMcpServer: "",
};

export function normalizeUiRouteState(value: unknown): UiRouteState {
  const record = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  return {
    activeTab: isTabId(record.activeTab) ? record.activeTab : DEFAULT_UI_ROUTE_STATE.activeTab,
    settingsSubTab: isSettingsSubTab(record.settingsSubTab)
      ? record.settingsSubTab
      : DEFAULT_UI_ROUTE_STATE.settingsSubTab,
    kimiCodeSubTab: isKimiCodeSubTab(record.kimiCodeSubTab)
      ? record.kimiCodeSubTab
      : DEFAULT_UI_ROUTE_STATE.kimiCodeSubTab,
    selectedProvider: asRouteSelection(record.selectedProvider),
    selectedModel: asRouteSelection(record.selectedModel),
    selectedProfile: asRouteSelection(record.selectedProfile),
    selectedMcpServer: asRouteSelection(record.selectedMcpServer),
  };
}

export function mergeUiRouteState(
  current: unknown,
  patch: Partial<UiRouteState>,
): UiRouteState {
  return normalizeUiRouteState({ ...normalizeUiRouteState(current), ...patch });
}

function asRouteSelection(value: unknown): string {
  return typeof value === "string" ? value : "";
}
