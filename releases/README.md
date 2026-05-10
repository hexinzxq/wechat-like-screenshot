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

按下后进入截图状态，可以框选区域、绘制矩形/圆形/箭头/画笔、输入文字、复制或保存截图。

## 注意

Windows 可能会提示未知发布者，因为这个演示程序使用的是本机开发证书签名。

如果 `Alt + A` 被其他软件占用，程序仍会保持后台运行，你可以从托盘打开设置修改快捷键。

## SHA256

```text
wechat-like-screenshot-portable.exe
013A88CAB7A2B9279107CB6482AC5E07EEDA7F665E8850E87D594823BF726D90

wechat-like-screenshot-setup.exe
2B204C840DD6EC8431A328E6B1554E789A7BB271472C9EF65984D85EEAD3E805
```

## 开发签名

当前演示程序使用 `scripts/sign-windows-dev.ps1` 生成的本机开发证书签名。这个证书只适合当前机器测试，不等同于面向公网分发的正式 OV/EV 代码签名证书。

当前证书指纹：

```text
FF7DC6079070944EC7E4D44CD7B5A658D7BA1B24
```
