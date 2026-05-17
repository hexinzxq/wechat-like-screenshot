# Windows WebView2 打包到安装包说明

这份文档讲的是：Windows WebView 应用如何把 Microsoft Edge WebView2 Runtime 一起处理进安装包里，避免用户电脑没有 WebView2 环境时应用无法启动。

本文以 `Tauri 2` 为主，因为当前项目就是 Tauri 2 + React + Next.js。

> 当前项目暂时不改配置。本文只是迁移和发布时的说明。

## 为什么要处理 WebView2

Tauri 的 Windows 桌面应用不是把 Chromium 整个打进 exe，而是使用系统里的 Microsoft Edge WebView2 Runtime。

大部分 Windows 10/11 机器已经有 WebView2，但不能 100% 假设所有用户都有。尤其是：

- 精简版系统。
- 企业内网机器。
- 禁止 Windows Update 的机器。
- 老旧 Windows 10 环境。
- 用户卸载或损坏了 WebView2 Runtime。

所以正式发布 Windows 安装包时，建议让安装程序自动处理 WebView2。

## Tauri 2 的配置位置

配置文件：

```text
src-tauri/tauri.conf.json
```

相关字段：

```json
{
  "bundle": {
    "windows": {
      "webviewInstallMode": {
        "type": "offlineInstaller"
      }
    }
  }
}
```

字段名是：

```text
bundle.windows.webviewInstallMode
```

## 推荐方案

如果你希望普通用户下载一个安装包就能用，推荐：

```json
{
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "windows": {
      "webviewInstallMode": {
        "type": "offlineInstaller"
      }
    }
  }
}
```

这个方案会把 WebView2 离线安装器放进安装包。

优点：

- 用户没装 WebView2 也能安装。
- 用户没网也能安装。
- 最适合发给普通用户、测试人员、客户。

缺点：

- 安装包会明显变大，Tauri 官方文档里大约增加 127MB。

## 各方案区别

| type | 是否需要联网 | 安装包大小变化 | 适合场景 |
| --- | --- | --- | --- |
| `downloadBootstrapper` | 需要 | 几乎不增加 | 默认方案，用户有网时够用 |
| `embedBootstrapper` | 需要 | 约 +1.8MB | 把小引导安装器打进包，但运行时还要联网下载 Runtime |
| `offlineInstaller` | 不需要 | 约 +127MB | 推荐给普通用户，离线也能安装 |
| `fixedRuntime` | 不需要 | 约 +180MB | 完全固定 WebView2 版本，适合强管控环境 |
| `skip` | 不需要 | 不增加 | 不推荐，用户没 WebView2 时应用会打不开 |

简单理解：

- 想安装包小：用 `downloadBootstrapper`。
- 想用户体验稳：用 `offlineInstaller`。
- 想把运行时固定到某个版本：用 `fixedRuntime`。
- 不想处理 WebView2：用 `skip`，但不推荐。

## 方案一：downloadBootstrapper

这是 Tauri Windows 安装包默认模式。

配置：

```json
{
  "bundle": {
    "windows": {
      "webviewInstallMode": {
        "type": "downloadBootstrapper"
      }
    }
  }
}
```

效果：

1. 安装包启动。
2. 安装程序检查用户电脑有没有 WebView2 Runtime。
3. 如果没有，就下载 Microsoft WebView2 Bootstrapper。
4. Bootstrapper 再从 Microsoft 下载并安装 WebView2 Runtime。

优点是安装包很小。

缺点是用户必须联网。如果用户断网或企业网络拦截 Microsoft 下载地址，安装体验会翻车。

## 方案二：embedBootstrapper

配置：

```json
{
  "bundle": {
    "windows": {
      "webviewInstallMode": {
        "type": "embedBootstrapper"
      }
    }
  }
}
```

这个方案会把 WebView2 Bootstrapper 小安装器放进你的安装包。

注意：它仍然需要联网，因为 Bootstrapper 只是引导器，不是完整 Runtime。

适合：

- 想比默认方案更稳一点。
- 用户基本都有网络。
- 不想让安装包变大太多。

不适合：

- 离线客户。
- 企业内网。
- 对安装成功率要求很高的发行包。

## 方案三：offlineInstaller

推荐大多数桌面软件使用这个。

配置：

```json
{
  "bundle": {
    "windows": {
      "webviewInstallMode": {
        "type": "offlineInstaller"
      }
    }
  }
}
```

效果：

1. WebView2 离线安装器被打进你的安装包。
2. 安装时检测用户电脑是否已有 WebView2。
3. 如果没有，就直接从安装包里安装 WebView2。
4. 不需要联网。

优点：

- 最稳。
- 用户不用自己装 WebView2。
- 离线也能安装。
- 适合发给客户、测试人员、非技术用户。

缺点：

- 安装包体积会大很多。

## 方案四：fixedRuntime

`fixedRuntime` 不是安装用户系统里的 Evergreen Runtime，而是把一个固定版本的 WebView2 Runtime 文件夹随应用一起打包。

配置示例：

```json
{
  "bundle": {
    "windows": {
      "webviewInstallMode": {
        "type": "fixedRuntime",
        "path": "./Microsoft.WebView2.FixedVersionRuntime.128.0.2739.42.x64/"
      }
    }
  }
}
```

大致步骤：

1. 去 Microsoft 下载 WebView2 Fixed Version Runtime。
2. 解压到 `src-tauri` 目录下。
3. 在 `tauri.conf.json` 里配置 `fixedRuntime` 和 `path`。
4. 执行 `npm run tauri:build`。

适合：

- 企业内网。
- 需要严格控制 WebView2 版本。
- 不希望依赖系统 WebView2 更新。

不适合普通分发的原因：

- 包体积更大。
- 安全更新要自己负责。
- WebView2 漏洞修复不会自动跟随 Evergreen Runtime。

如果没有强版本管控需求，不建议优先用这个。

## 方案五：skip

配置：

```json
{
  "bundle": {
    "windows": {
      "webviewInstallMode": {
        "type": "skip"
      }
    }
  }
}
```

这个模式会跳过 WebView2 安装检查。

不推荐。

因为用户机器没有 WebView2 Runtime 时，应用可能直接无法启动。

## 推荐决策

一般这样选：

```text
给自己开发测试：downloadBootstrapper
给普通用户测试：offlineInstaller
给客户正式交付：offlineInstaller
给企业内网交付：offlineInstaller 或 fixedRuntime
强制固定 WebView2 版本：fixedRuntime
```

对截图工具、桌面效率工具、内部管理工具这类应用，通常推荐：

```json
{
  "bundle": {
    "windows": {
      "webviewInstallMode": {
        "type": "offlineInstaller"
      }
    }
  }
}
```

## 完整 tauri.conf.json 片段

如果你当前配置类似这样：

```json
{
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": []
  }
}
```

可以改成：

```json
{
  "bundle": {
    "active": true,
    "targets": ["nsis"],
    "icon": [],
    "windows": {
      "webviewInstallMode": {
        "type": "offlineInstaller"
      }
    }
  }
}
```

然后重新打包：

```bash
npm run tauri:build
```

产物一般在：

```text
src-tauri/target/release/bundle/nsis/
```

## 如何验证有没有生效

最直接的判断：

1. 重新打包。
2. 看安装包体积。
3. 如果使用 `offlineInstaller`，安装包应该明显变大。
4. 找一台没有 WebView2 Runtime 的 Windows 测试机安装。
5. 断网安装一次。
6. 安装后启动应用。

如果断网安装成功，并且应用能启动，说明 WebView2 离线安装处理是正常的。

## 不要误解的一点

`offlineInstaller` 不是把 WebView2 运行时直接塞进你的 exe。

它是把 WebView2 离线安装器打进安装包里。安装程序发现用户没有 WebView2 时，会先安装 Runtime，再安装或启动你的应用。

如果你真的想把一个固定 WebView2 Runtime 文件夹随应用一起带走，那是 `fixedRuntime`。

## 参考资料

- Tauri 2 Windows Installer 文档：https://v2.tauri.app/distribute/windows-installer/
- Microsoft WebView2 Runtime 分发文档：https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
