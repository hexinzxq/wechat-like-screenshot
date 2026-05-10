# 演示程序下载

这里放的是已经打包好的 Windows 演示程序，可以直接下载体验。

## 文件说明

```text
wechat-like-screenshot-portable.exe
```

免安装版本，双击即可运行。程序默认后台运行，可以在系统托盘里打开设置或退出。

```text
wechat-like-screenshot-setup.exe
```

Windows 安装包版本，适合安装到系统后长期使用。

## 默认快捷键

```text
Alt + A
```

按下后进入截图状态，可以框选区域、绘制矩形/圆形/箭头/画笔、输入文字、长截图、复制或保存截图。

长截图现在是会话模式：框选后点击长截图，选区会保持在屏幕上；你可以在选区内手动滚动采集，也可以打开自动滚动，最后手动点击完成。

## 注意

Windows 可能会提示未知发布者，因为这个演示程序没有做代码签名。

如果 `Alt + A` 被其他软件占用，程序仍会保持后台运行，你可以从托盘打开设置修改快捷键。

## SHA256

```text
wechat-like-screenshot-portable.exe
92113DA8B8EE94FDD01FC25001C801E72D2AE2C8E87D03F62673535C0799C257

wechat-like-screenshot-setup.exe
F64E99E24E6689B5DB441DD64361755387166F5F24AE7DEFA01884A934723CB9
```

## 开发签名

当前演示程序使用 `scripts/sign-windows-dev.ps1` 生成的本机开发证书签名。这个证书只适合当前机器测试，不等同于面向公网分发的正式 OV/EV 代码签名证书。

当前证书指纹：

```text
FF7DC6079070944EC7E4D44CD7B5A658D7BA1B24
```
