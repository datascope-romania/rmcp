import { useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import ServerDetail from "./pages/ServerDetail";
import ServerEditor from "./pages/ServerEditor";
import ServerList from "./pages/ServerList";
import Settings from "./pages/Settings";
import { cycleTheme, getTheme, type ThemeMode } from "./theme";

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

const THEME_TITLE: Record<ThemeMode, string> = {
  auto: "Theme: auto (follows system)",
  light: "Theme: light",
  dark: "Theme: dark",
};

function ThemeIcon({ mode }: { mode: ThemeMode }) {
  const common = {
    width: 18, height: 18, viewBox: "0 0 24 24", fill: "none",
    stroke: "currentColor", strokeWidth: 2,
    strokeLinecap: "round", strokeLinejoin: "round",
    "aria-hidden": true,
  } as const;
  if (mode === "light") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    );
  }
  if (mode === "dark") {
    return (
      <svg {...common}>
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(getTheme);
  return (
    <div className="app">
      <header className="appbar">
        <div className="appbar-inner">
          <Link to="/" className="brand">rmcp</Link>
          <span className="tagline">remote MCP servers on AWS Lambda</span>
          <nav className="appbar-nav">
            <button
              type="button"
              className="icon-button"
              onClick={() => setTheme(cycleTheme(theme))}
              aria-label={THEME_TITLE[theme]}
              title={THEME_TITLE[theme]}
            >
              <ThemeIcon mode={theme} />
            </button>
            <NavLink
              to="/settings"
              className={({ isActive }) => `icon-button${isActive ? " active" : ""}`}
              aria-label="Settings"
              title="Settings"
            >
              <GearIcon />
            </NavLink>
          </nav>
        </div>
      </header>
      <main className="layout">
        <Routes>
          <Route path="/" element={<ServerList />} />
          <Route path="/servers/new" element={<ServerEditor />} />
          <Route path="/servers/:id/edit" element={<ServerEditor />} />
          <Route path="/servers/:id" element={<ServerDetail />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </main>
    </div>
  );
}
