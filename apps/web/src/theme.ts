export type ThemeMode = "auto" | "light" | "dark";

const KEY = "rmcp-theme";
const MODES: ThemeMode[] = ["auto", "light", "dark"];

export function getTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    return MODES.includes(v as ThemeMode) ? (v as ThemeMode) : "auto";
  } catch {
    return "auto";
  }
}

export function applyTheme(mode: ThemeMode): void {
  // "" restores the stylesheet's `color-scheme: light dark` → follows the OS.
  document.documentElement.style.colorScheme = mode === "auto" ? "" : mode;
}

export function cycleTheme(current: ThemeMode): ThemeMode {
  const next = MODES[(MODES.indexOf(current) + 1) % MODES.length];
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // storage unavailable: the override still applies for this session
  }
  applyTheme(next);
  return next;
}

applyTheme(getTheme());
