# Windows 安装程序版打包流程

这份文档讲的是：当前 `Tauri 2 + React + Next.js` 项目，最终如何打成一个 Windows 安装程序版安装包。

目标产物一般是：

```text
src-tauri/target/release/bundle/nsis/屏幕截图_0.1.0_x64-setup.exe
```

如果你想给用户一个更好识别的文件名，也可以复制成：

```text
releases/wechat-like-screenshot-setup.exe
```

## 一句话流程

```bash
npm run tauri:build
```

这一个命令会做三件事：

1. 先执行前端构建 `npm run build`。
2. 再执行 Rust release 构建。
3. 最后用 Tauri 的 NSIS 打包器生成 Windows 安装程序。

## 前提条件

打包前确认这些东西已经准备好：

```text
Node.js
npm
Rust
Tauri CLI
Windows 构建环境
NSIS 相关打包能力
```

当前项目里已经有脚本：

```json
{
  "scripts": {
    "build": "next build",
    "tauri:build": "tauri build"
  }
}
```

所以正常情况下直接执行：

```bash
npm run tauri:build
```

## 检查 tauri.conf.json

配置文件位置：

```text
src-tauri/tauri.conf.json
```

当前项目安装包相关配置类似这样：

```json
{
  "productName": "屏幕截图",
  "version": "0.1.0",
  "identifier": "com.codex.wechat-like-screenshot",
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": []
  }
}
```

重点看这几个字段：

| 字段 | 作用 |
| --- | --- |
| `productName` | 安装包和安装后的应用名称 |
| `version` | 安装包版本号 |
| `identifier` | 应用唯一标识 |
| `bundle.active` | 是否启用打包 |
| `bundle.targets` | Windows 安装包类型，这里用 `nsis` |

如果你要生成 Windows 安装程序，`targets` 至少要包含：

```json
"targets": ["nsis"]
```

## 正式打包命令

在项目根目录执行：

```bash
npm run tauri:build
```

也就是在这个目录下执行：

```text
C:\Users\x\Documents\Codex\2026-05-06\windows-1-tauri2-7-react-nextjs
```

成功时，你会看到类似输出：

```text
Built application at:
src-tauri/target/release/wechat-like-screenshot.exe

Finished 1 bundle at:
src-tauri/target/release/bundle/nsis/屏幕截图_0.1.0_x64-setup.exe
```

## 产物在哪里

免安装 exe：

```text
src-tauri/target/release/wechat-like-screenshot.exe
```

安装程序：

```text
src-tauri/target/release/bundle/nsis/屏幕截图_0.1.0_x64-setup.exe
```

如果你要把产物集中放到 `releases` 目录，可以执行：

```powershell
New-Item -ItemType Directory -Force -Path releases | Out-Null
Copy-Item -LiteralPath "src-tauri\target\release\wechat-like-screenshot.exe" -Destination "releases\wechat-like-screenshot-portable.exe" -Force
Copy-Item -LiteralPath "src-tauri\target\release\bundle\nsis\屏幕截图_0.1.0_x64-setup.exe" -Destination "releases\wechat-like-screenshot-setup.exe" -Force
```

这样最终给用户的两个文件就是：

```text
releases/wechat-like-screenshot-portable.exe
releases/wechat-like-screenshot-setup.exe
```

## 打包前建议检查

打包前建议先跑：

```bash
npm run build
```

再跑：

```bash
cd src-tauri
cargo check
```

如果这两个都通过，再执行：

```bash
npm run tauri:build
```

这样能更早发现前端类型错误和 Rust 编译错误。

## 打包后建议测试

安装程序生成后，至少测试这些点：

1. 双击安装包能正常安装。
2. 安装完成后能启动应用。
3. 托盘图标正常出现。
4. 默认快捷键 `Alt+A` 能唤起截图。
5. 能框选截图区域。
6. 能绘制、输入文字、复制、保存。
7. 退出后再次启动不会出现多个后台进程。
8. 卸载流程能正常走完。

如果你改过 WebView2 打包策略，还要额外测试：

1. 没有 WebView2 的机器能否安装启动。
2. 断网环境能否安装。
3. 安装包体积是否符合预期。

WebView2 相关说明看：

```text
docs/windows-webview2-bundling-guide.md
```

## 常见问题

### 1. 只生成了 exe，没有安装包

检查 `src-tauri/tauri.conf.json`：

```json
"bundle": {
  "active": true,
  "targets": ["nsis"]
}
```

如果 `bundle.active` 是 `false`，不会生成安装包。

如果 `targets` 没有 `nsis`，也不会生成 NSIS 安装程序。

### 2. 安装包名字不是我想要的

安装包默认会受这些字段影响：

```json
"productName": "屏幕截图",
"version": "0.1.0"
```

所以当前默认安装包名类似：

```text
屏幕截图_0.1.0_x64-setup.exe
```

如果你想发给用户一个英文或固定名称，可以构建后复制并重命名：

```powershell
Copy-Item -LiteralPath "src-tauri\target\release\bundle\nsis\屏幕截图_0.1.0_x64-setup.exe" -Destination "releases\wechat-like-screenshot-setup.exe" -Force
```

### 3. Windows 提示不安全

这是因为安装包没有代码签名，或者签名证书不被用户系统信任。

解决方向：

1. 购买代码签名证书。
2. 在发布流程里对 exe 和安装包签名。
3. 让用户从可信下载渠道获取安装包。

如果只是内部测试，可以先让用户在 Windows 安全提示里选择继续运行。

### 4. 用户电脑没有 WebView2

看这份文档：

```text
docs/windows-webview2-bundling-guide.md
```

一般推荐安装包使用：

```json
"webviewInstallMode": {
  "type": "offlineInstaller"
}
```

这样会把 WebView2 离线安装器一起放进安装包里，但包体积会明显变大。

### 5. 旧版本还在后台运行

这个项目是单例模式。

如果用户测试时后台已经跑着旧版本，再打开新 exe，可能会被旧进程接管，看起来像“新版本没生效”。

测试新包前建议：

1. 从托盘退出旧程序。
2. 或者在任务管理器结束旧进程。
3. 再运行新安装的程序。

## 推荐发布流程

一次比较稳的发布流程：

```bash
npm run build
cd src-tauri
cargo check
cd ..
npm run tauri:build
```

然后复制产物：

```powershell
New-Item -ItemType Directory -Force -Path releases | Out-Null
Copy-Item -LiteralPath "src-tauri\target\release\wechat-like-screenshot.exe" -Destination "releases\wechat-like-screenshot-portable.exe" -Force
Copy-Item -LiteralPath "src-tauri\target\release\bundle\nsis\屏幕截图_0.1.0_x64-setup.exe" -Destination "releases\wechat-like-screenshot-setup.exe" -Force
```

最后把这两个文件发给测试用户：

```text
wechat-like-screenshot-portable.exe
wechat-like-screenshot-setup.exe
```

如果只发安装程序版，就发：

```text
wechat-like-screenshot-setup.exe
```

## 当前项目实际打包记录

当前项目最近一次成功打包命令：

```bash
npm run tauri:build
```

生成过的安装程序：

```text
src-tauri/target/release/bundle/nsis/屏幕截图_0.1.0_x64-setup.exe
releases/wechat-like-screenshot-setup.exe
```

生成过的免安装程序：

```text
src-tauri/target/release/wechat-like-screenshot.exe
releases/wechat-like-screenshot-portable.exe
```
