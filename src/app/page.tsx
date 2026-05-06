"use client";

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Camera, Keyboard, MonitorUp, Play, Save, Settings } from "lucide-react";
import "./settings.css";

const DEFAULT_SHORTCUT = "Alt+A";
const STORAGE_KEY = "screenshot-shortcut";

async function openOverlay() {
  const current = await WebviewWindow.getByLabel("overlay");
  if (current) {
    await current.show();
    await current.setFocus();
    return current;
  }

  return new WebviewWindow("overlay", {
    url: "/overlay/",
    title: "截图",
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    visible: false
  });
}

async function startCapture() {
  await openOverlay();
  await invoke("start_capture");
}

export default function Home() {
  const [shortcut, setShortcut] = useState(DEFAULT_SHORTCUT);
  const [draft, setDraft] = useState(DEFAULT_SHORTCUT);
  const [message, setMessage] = useState("程序已在后台运行，可从托盘打开设置。");

  const shortcutPreview = useMemo(() => draft.split("+").map((part) => part.trim()).filter(Boolean), [draft]);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY) || DEFAULT_SHORTCUT;
    setShortcut(saved);
    setDraft(saved);

    async function syncHotkey(value: string) {
      try {
        await invoke("set_shortcut", { shortcut: value });
        setMessage(`快捷键 ${value} 已生效。`);
      } catch (error) {
        setMessage(`快捷键注册失败：${String(error)}`);
      }
    }

    syncHotkey(saved);
  }, []);

  async function applyShortcut() {
    const value = draft.trim();
    if (!value.includes("+")) {
      setMessage("请输入类似 Alt+A、Ctrl+Shift+S 的组合键。");
      return;
    }
    try {
      await invoke("set_shortcut", { shortcut: value });
      localStorage.setItem(STORAGE_KEY, value);
      setShortcut(value);
      setMessage(`快捷键 ${value} 已保存。`);
    } catch (error) {
      setMessage(`快捷键保存失败：${String(error)}`);
    }
  }

  async function hideWindow() {
    const win = getCurrentWebviewWindow();
    await win.hide();
  }

  return (
    <main className="settings-shell">
      <section className="settings-header">
        <div className="app-mark">
          <Camera size={22} />
        </div>
        <div>
          <h1>屏幕截图</h1>
          <p>{message}</p>
        </div>
      </section>

      <section className="settings-group">
        <label htmlFor="shortcut">
          <Keyboard size={18} />
          快捷键
        </label>
        <div className="shortcut-row">
          <input
            id="shortcut"
            value={draft}
            spellCheck={false}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") applyShortcut();
            }}
          />
          <button className="primary" onClick={applyShortcut}>
            <Save size={17} />
            保存
          </button>
        </div>
        <div className="shortcut-preview">
          {shortcutPreview.map((key) => (
            <kbd key={key}>{key}</kbd>
          ))}
        </div>
      </section>

      <section className="settings-actions">
        <button onClick={startCapture}>
          <Play size={18} />
          立即截图
        </button>
        <button onClick={hideWindow}>
          <MonitorUp size={18} />
          后台运行
        </button>
      </section>

      <footer>
        <Settings size={16} />
        托盘菜单可打开设置或退出；默认快捷键为 Alt+A。
      </footer>
    </main>
  );
}
