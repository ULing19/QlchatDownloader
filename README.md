# 千聊下载器

独立 Windows 桌面程序，将账号可正常播放的千聊课程保存为本地 MP4。支持内置浏览器登录、订单授权、读取课程目录、保存本机课程库、按章节选择课程和批量下载。

项目仓库：[github.com/ULing19/QlchatDownloader](https://github.com/ULing19/QlchatDownloader)；当前 Release：[v0.2.2](https://github.com/ULing19/QlchatDownloader/releases/tag/v0.2.2)。

直接下载：[安装版](https://github.com/ULing19/QlchatDownloader/releases/download/v0.2.2/QlchatDownloader-0.2.2-x64-Setup.exe) · [绿色版](https://github.com/ULing19/QlchatDownloader/releases/download/v0.2.2/QlchatDownloader-0.2.2-x64-Portable.exe)

## 0.2.2 授权保存修复

修复 Windows 应用容器将文件重定向到其他磁盘时，激活后保存授权报 `EXDEV` 的问题。写入临时文件后确认其真实物理目录，再在同目录完成原子替换；重命名失败时保留原文件并清理临时文件。课程库和保存位置也采用相同方式保存。升级保留千聊登录会话、设备标识和本机数据。

## 安装使用

1. 运行 `QlchatDownloader-0.2.2-x64-Setup.exe`，选择安装位置；也可直接运行 `QlchatDownloader-0.2.2-x64-Portable.exe`。
2. 粘贴千聊课程或单节链接，打开登录窗口，用购课账号完成登录。
3. 读取课程目录，勾选要下载的章节或单节课程。
4. 输入闲鱼订单号完成本机授权（订单号本身就是兑换码，不需要另填兑换码），选择保存文件夹，开始下载。可查看进度、取消任务和打开保存位置。

账号登录状态只保存在本机，此程序使用独立的应用数据目录，与钉钉及小鹅通下载器分开。已读取的课程会保存到本机课程库，重新打开程序即可查看并再次读取。当前课程库记录的是本机已读取过的课程，平台没有提供可稳定依赖的“自动列出全部购买课程”接口。无需将 Cookie、验证码或密码发送给其他人。

每节课程下载前会重新获取播放地址，避免长队列中签名过期。再次下载时，已通过本地完整性检查的课时会自动跳过，未完成的临时文件会清理后继续。日志不显示签名地址和登录凭据。同名文件会另行命名，不覆盖已有视频。

## 订单授权

闲鱼商品：[千聊课程下载器](https://www.goofish.com/item?id=1093753190581)。订单号就是兑换码，只需填写一次；钉钉商品的订单不能激活千聊。

授权服务使用现有 HTTPS 订单授权接口，千聊产品在服务端使用独立分区。用户只需输入原始闲鱼订单号，例如 `123456789012`，订单号本身就是兑换码。这使千聊订单与钉钉订单分开计数；每个订单最多绑定两台设备。订单授权缓存保存在本机，服务临时不可用时沿用短期离线租约。GitHub 发布包不包含订单号、兑换码或管理密钥。

## 支持范围

- 千聊普通视频课程的正常授权播放地址，输出 MP4。
- 仅处理当前账号有权访问的课程；未购课、失效课程、直播中内容或特殊播放器可能无法下载。
- 不支持 Widevine 等 DRM 课程。平台更新可能需要更新解析逻辑。
- 内置浏览器可能无法播放部分视频，下载结果以下载完成后的文件检查为准。

已用一套含 42 节课的课程完成整套下载：42 个 MP4、0 个临时文件、0 个坏文件，总时长约 32.14 小时。第一节为 720P、42 分 46 秒，全部课时均通过 FFprobe 音视频文件检查。

## 源码运行和打包

需要 Node.js，以及 Electron 41.2.0、electron-builder 26.8.1。脚本优先使用本项目依赖；当前工作区也可复用相邻 `小鹅通下载器/node_modules` 的运行时，无需重复下载。

```powershell
npm start
npm test
npm run build:win
```

`tools/build-win.ps1 -CheckOnly` 可只检查构建依赖。默认生成 Windows x64 安装版和绿色版，安装包位于 `dist`。FFmpeg 二进制因超过 GitHub 普通 Git 对象大小限制而作为 Release 资源单独提供；源码构建前从同一版本的 GitHub Release 下载 `ffmpeg.exe` 到 `assets/ffmpeg.exe`。安装版和绿色版已将 FFmpeg 独立打包。

## 第三方组件

本程序通过独立的 FFmpeg 进程处理媒体。随包携带的是 [Gyan.dev](https://www.gyan.dev/ffmpeg/builds/) 的 FFmpeg 9.0 essentials Windows x64 静态构建，启用了 `--enable-gpl --enable-version3`，按 GPLv3 分发。程序没有修改该 FFmpeg 二进制文件。

完整许可证、实际构建参数和二进制 SHA-256 分别随安装包保存在 `resources/COPYING.GPLv3.txt`、`resources/FFMPEG-BUILD.txt` 和 `resources/THIRD_PARTY_NOTICES.txt`。FFmpeg 保持独立文件，可用兼容版本替换。

- [FFmpeg 许可说明](https://ffmpeg.org/legal.html)
- [FFmpeg 9.0 上游源码压缩包](https://ffmpeg.org/releases/ffmpeg-9.0.tar.xz)
- [FFmpeg 9.0 上游源码树](https://github.com/FFmpeg/FFmpeg/tree/n9.0)
- [Gyan 构建存档与源码参考](https://github.com/GyanD/codexffmpeg/releases)

FFmpeg 静态构建还包含第三方库，相关版本及构建来源可在 Gyan 对应构建包的 README 和源码参考中查阅。
