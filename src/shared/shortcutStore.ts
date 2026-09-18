import type { ShortcutAction, ShortcutBinding, ShortcutScope } from "./types";

/** Legacy panel metadata compatibility. These bindings are never registered or dispatched. */
interface LegacyShortcutDefinition {
  action: ShortcutAction;
  scope: ShortcutScope;
  defaultAccelerator: string;
  defaultEnabled: boolean;
}
export interface ShortcutConflict {
  accelerator: string;
  scope: ShortcutScope;
  actions: ShortcutAction[];
}
const SHORTCUT_ACTIONS: LegacyShortcutDefinition[] = [
  { action: "window.toggle", scope: "global", defaultAccelerator: "Command+Shift+H", defaultEnabled: true },
  { action: "profile.next", scope: "global", defaultAccelerator: "", defaultEnabled: false },
  { action: "profile.previous", scope: "global", defaultAccelerator: "", defaultEnabled: false },
  { action: "app.reloadConfig", scope: "window", defaultAccelerator: "CommandOrControl+R", defaultEnabled: true },
  { action: "app.save", scope: "window", defaultAccelerator: "CommandOrControl+S", defaultEnabled: true },
  { action: "app.globalSearch", scope: "window", defaultAccelerator: "CommandOrControl+K", defaultEnabled: true },
  { action: "app.quickProfileSwitch", scope: "window", defaultAccelerator: "CommandOrControl+Shift+P", defaultEnabled: true },
  { action: "app.refresh", scope: "window", defaultAccelerator: "CommandOrControl+Shift+R", defaultEnabled: true },
  { action: "tab.overview", scope: "window", defaultAccelerator: "CommandOrControl+1", defaultEnabled: true },
  { action: "tab.profiles", scope: "window", defaultAccelerator: "CommandOrControl+2", defaultEnabled: true },
  { action: "tab.providers", scope: "window", defaultAccelerator: "CommandOrControl+3", defaultEnabled: true },
  { action: "tab.models", scope: "window", defaultAccelerator: "CommandOrControl+4", defaultEnabled: true },
  { action: "tab.mcp", scope: "window", defaultAccelerator: "CommandOrControl+5", defaultEnabled: true },
  { action: "tab.skills", scope: "window", defaultAccelerator: "CommandOrControl+6", defaultEnabled: true },
  { action: "tab.insights", scope: "window", defaultAccelerator: "CommandOrControl+7", defaultEnabled: true },
  { action: "tab.settings", scope: "window", defaultAccelerator: "CommandOrControl+8", defaultEnabled: true },
];

const LEGACY_WINDOW_TOGGLE_ACCELERATOR = "CommandOrControl+Shift+K";

export function createDefaultShortcuts(): Record<ShortcutAction, ShortcutBinding> {
  return Object.fromEntries(
    SHORTCUT_ACTIONS.map((definition) => [
      definition.action,
      {
        action: definition.action,
        accelerator: definition.defaultAccelerator,
        enabled: definition.defaultEnabled,
        scope: definition.scope,
      },
    ]),
  ) as Record<ShortcutAction, ShortcutBinding>;
}

export function normalizeShortcuts(value: unknown): Record<ShortcutAction, ShortcutBinding> {
  const defaults = createDefaultShortcuts();
  if (!isRecord(value)) {
    return defaults;
  }

  for (const definition of SHORTCUT_ACTIONS) {
    const raw = value[definition.action];
    if (!isRecord(raw)) {
      continue;
    }

    let accelerator = typeof raw.accelerator === "string"
      ? sanitizeAccelerator(raw.accelerator)
      : defaults[definition.action].accelerator;
    let enabled = Boolean(accelerator.trim()) && (typeof raw.enabled === "boolean" ? raw.enabled : defaults[definition.action].enabled);

    if (
      definition.action === "window.toggle" &&
      accelerator === LEGACY_WINDOW_TOGGLE_ACCELERATOR &&
      raw.enabled === false
    ) {
      accelerator = defaults[definition.action].accelerator;
      enabled = defaults[definition.action].enabled;
    }

    defaults[definition.action] = {
      action: definition.action,
      accelerator,
      enabled,
      scope: definition.scope,
    };
  }

  return defaults;
}

export function getShortcutConflicts(shortcuts: Record<ShortcutAction, ShortcutBinding>): ShortcutConflict[] {
  const groups = new Map<string, ShortcutAction[]>();

  for (const binding of Object.values(shortcuts)) {
    if (!binding.enabled || !binding.accelerator.trim() || !isValidAccelerator(binding.accelerator)) {
      continue;
    }
    const key = `${binding.scope}:${normalizeAccelerator(binding.accelerator).toLowerCase()}`;
    groups.set(key, [...(groups.get(key) ?? []), binding.action]);
  }

  return [...groups.entries()]
    .filter(([, actions]) => actions.length > 1)
    .map(([key, actions]) => {
      const [scope, accelerator] = key.split(":");
      return {
        accelerator,
        scope: scope as ShortcutScope,
        actions,
      };
    });
}

export function normalizeAccelerator(value: string): string {
  return value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean)
    .join("+");
}

export function sanitizeAccelerator(value: string): string {
  const accelerator = normalizeAccelerator(value);
  return isValidAccelerator(accelerator) ? accelerator : "";
}

export function isValidAccelerator(value: string): boolean {
  const accelerator = normalizeAccelerator(value);
  return !accelerator || /^[\x20-\x7E]+$/.test(accelerator);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
