# 我们的厨房 · Our Kitchen

一个给两个人使用的私人点菜网页。你负责想吃什么，我负责把它做成一顿好饭。

Vue 3、Express 5、Node 24 内置 SQLite。支持菜品管理、照片上传、分类排序、厨房共享喜欢、购物袋、订单备注、后台清单和 Server酱微信提醒。没有付款、配送或公开注册。

## 一键开始（Windows 10/11，x64 或 ARM64）

下载并解压项目，双击 **start.bat**：

```text
Our Kitchen / 我们的厨房
1. 开始
2. 重新配置
3. 运行管理
4. 环境检查
0. 退出
```

首次使用需要联网。启动器检查 Node 24.14+（24.x），缺少兼容版本时从 nodejs.org 下载并校验便携运行时，不修改系统 Node。项目依赖和网页按需安装、构建；下载失败会停在当前步骤，不会绕过校验或切换未知镜像。

### 本机运行

选择「开始 → 本机运行」，设置管理员密码、访客问题/暗语及可选 Server酱 SendKey。管理员密码12–128位，暗语4–128位，必须不同，输入隐藏，仅保存 scrypt 哈希；不要使用公开示例作为真实凭据。输入 `:back` 可取消当前配置。

默认打开 **http://localhost:3001/order/**，后台为 **http://localhost:3001/order/admin**。本机只监听127.0.0.1，初始菜单为空，请到后台添加自己的菜品。数据和照片保存在 `.local/local/data/`。本机环境仅用于本机 HTTP，不对公网开放。

服务后台运行，关闭启动器后仍运行；「运行管理」可打开网页、查看状态/日志或停止。重复开始不会重复启动。其他程序占用端口时，请在「重新配置」改端口，启动器不会结束其他程序。

### 新服务器运行

仅支持**新建的专用 Ubuntu 22.04/24.04 服务器，x64/ARM64**，以及本启动器创建的部署后续更新。不会接管已有网站或旧厨房部署，不会自动卸载其他服务。

1. 准备公网服务器、SSH登录账号（root或免密码sudo）和联系邮箱，放行SSH端口及公网80/443。有域名时，先正确设置A/AAAA解析；也支持直接使用公网IP。
2. 选择「开始 → 服务器运行」，填写SSH地址、端口、用户、可选私钥完整路径、HTTPS网站来源、证书联系邮箱，以及服务器独立的管理员密码和访客暗语。
3. 首次SSH连接请核对主机指纹。SSH密码、私钥口令由OpenSSH原生提示输入，不保存到项目。Windows缺少OpenSSH客户端时会自动引导安装系统可选功能，可能弹出管理员权限提示。
4. 确认Let’s Encrypt条款后，启动器自动检查服务器，安装Node、Caddy、Certbot，上传源码，测试、构建、配置HTTPS和自动续期，最终打开网页。

服务器至少需要2GiB空闲磁盘，并能访问Ubuntu软件源、nodejs.org、GitHub Releases、npm、PyPI和Let’s Encrypt。启动器使用官方来源与明确版本；网络、权限、域名解析或安全组错误会显示失败。不会自动改云安全组或关闭系统防火墙。

域名HTTPS由Caddy自动申请和续期；公网IP使用Certbot webroot短期证书方案，系统每12小时检查续期并加载新证书。首次部署会验证IP证书续期配置，不能退回不安全HTTP。相关机制见[Let’s Encrypt官方说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot/)。

服务器路径：代码 `/opt/our-kitchen/releases/`，当前版本 `/opt/our-kitchen/current`，私密配置 `/etc/our-kitchen/`，SQLite与上传图片 `/var/lib/our-kitchen/`。服务为 `our-kitchen.service`、`our-kitchen-caddy.service`；IP部署另有续期计时器 `our-kitchen-renew.timer`。应用使用专用低权限用户、仅监听本机3001，由HTTPS代理转发。项目不保存客户端IP或IP摘要，不启用代理访问日志。

关闭Windows启动器不影响服务器运行。「运行管理 → 更新服务器」重新测试并发布当前源码，保留数据库、照片和旧版本；切换失败会恢复上一版本。`deploy.bat` 是服务器入口的快捷包装。服务器状态可在启动器查询，详细服务日志通过SSH执行 `journalctl -u our-kitchen.service` 查看。

本项目的一键入口不会自动连接任何内置服务器地址。实际申请证书需要自己的服务器、网络和条款确认。脚本测试不代表已在所有云平台、架构和网络环境完成部署验收。

## 配置与数据

本机配置在 `.local/local/.env`，服务器配置在 `.local/server/.env`，SSH地址、私钥路径等非密码设置在 `.local/server/site.json`。两套配置独立，不自动读取根目录既有 `.env` 或 `.env.credentials`。运行时、配置备份、日志和进程记录同样留在被忽略的 `.local/`。

「重新配置」留空保留原值；密钥输入 `-` 清空。有效配置校验通过后才保存，已有配置自动备份；不会清空菜单和订单。改本机配置时停止旧服务，之后重新开始；服务器配置只在主动部署时生效。不要分享 `.local/`、环境文件、私钥、证书或备份。

备份前停止服务，复制**整个数据目录**（SQLite、WAL/SHM和uploads），不要只复制运行中的主数据库。服务器更新不会上传本机数据库或上传图片。旧数据库启动时自动迁移，迁移会移除旧IP记录并使旧会话失效；历史外部备份与平台日志不属于应用清理范围。

访客同一浏览器30天内免验证，切换网络无需重验；管理员会话8小时。所有菜单、媒体和订单接口均经过服务端授权；管理接口需要管理员角色。保留CSRF、来源验证、持久化限流、图片重编码、订单快照与幂等。修改凭据使旧会话失效，后台也可撤销全部访客权限。

## 微信提醒

在[Server酱](https://sct.ftqq.com/sendkey)获取SendKey，配置到相应运行环境。未配置时订单仍保存到后台；发送失败自动退避重试，后台可查看结果和手动重试。服务商接受请求不等于用户已阅读，同一订单通知可能重复发送。保存菜品不会发送通知。

## 开发与手动运行

```sh
npm ci
npm run demo
npm test
npm run build
```

演示入口为 `http://127.0.0.1:5173/order/`，演示暗语 `一起好好吃饭`，演示管理员密码 `demo-chef-2026`。仅监听本机，使用独立 `data-demo/`，不发送微信；演示凭据不用于正式运行。

手动初始化可用 `npm run setup` 生成根目录 `.env`，再 `npm run dev`。此为开发兼容入口，与一键启动的配置独立。Docker部署仍可使用 `.env.example`、Dockerfile、compose.yaml和 `deploy/Caddyfile`，但不属于Windows一键服务器向导；Docker方式需域名HTTPS并自行准备Docker环境。

界面设计约定保留在 [DESIGN.md](DESIGN.md)。一键工具不改变点菜、喜欢、长按分类排序和订单功能。

## 上传GitHub之前

在项目文件夹建立**独立的Git仓库**，不要在包含其他个人文件的父目录仓库中直接添加。只读检查：

```sh
node scripts/check-public.js
```

检查只报告可疑文件名，不打印密钥，不创建仓库、不提交、不推送。父目录已有Git仓库时会停止发布检查和服务器打包；本机运行仍可用。ZIP下载不要求安装Git，但不能位于另一个Git仓库内。检查是启发式的，发布前仍需检查 `git status` 和待提交差异；ignore规则不能清理过去已提交的秘密。

`.gitignore` 排除环境文件、`.local/`、数据库、上传、依赖、构建、日志、截图、测试输出、私钥、证书和备份。`.env.example`、锁文件、测试、源码、演示图片、设计文档及许可证应提交。

## 许可证与第三方来源

本项目使用 **GPL-3.0-only**，完整条款见 [LICENSE](LICENSE)。公开或分发时请保留许可证和下列署名。

- [Skylarrkuo/family-meal-order](https://github.com/Skylarrkuo/family-meal-order)，提交 `55a46cb0ee3cbf117f668aad58737294470f0fba`，GPL-3.0。`src/api.js` 改编自其 `frontend/src/services/api.js`；原始文件和许可证保存在 `third_party/family-meal-order/`，本项目已修改认证和请求逻辑。
- [Anduin2017/HowToCook](https://github.com/Anduin2017/HowToCook)，Unlicense。演示照片的提交、来源路径和链接见 `seed-assets/SOURCES.json`，原许可证保存在 `third_party/HowToCook/LICENSE`。正式菜单请上传自己的照片。
- [easychen/serverchan-sdk](https://github.com/easychen/serverchan-sdk)：仅参考官方Turbo/SC3接口格式，未复制SDK源代码；通过Node原生Fetch调用。
- 设计过程曾参考 [Anthropic frontend-design skill](https://github.com/anthropics/skills/tree/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/frontend-design)。该技能及其脚本不随项目分发；本项目保留独立的DESIGN.md。
- Vue、Express、Helmet、cookie-parser、Multer、Sharp、Zod、Lucide及开发工具的版本见 `package-lock.json`，许可证包含在各npm分发包中。
