# 视频提取器 Plus

从 B站、抖音、Telegram、Twitter/X 提取视频直链，支持在线预览与下载。

本项目由 [video-extractor](https://github.com/2046294597-png/video-extractor) 复制而来，
在其基础上增加了 B站 与抖音的解析能力。

## 平台支持

| 平台 | 状态 | 解析位置 | 画质上限 | 备注 |
|---|---|---|---|---|
| B站 | ✅ 可用 | Worker | 720P | 不登录的硬上限；1080P 需要大会员 cookie |
| 抖音 | ⚠️ 仅元数据 | Worker + 第三方 | 取决于解析源 | 能识别作品（标题/作者/封面），视频流需配解析端点 |
| Telegram | ✅ 可用（原功能） | Worker | 取决于源 | 私有频道需登录，走提示卡 |
| Twitter/X | ✅ 可用（原功能） | 前端 + 后端 | 720P（默认） | 见 `maxBitrate()` |

## 架构

```
index.html          单文件 PWA：识别链接、展示、播放、下载、历史
worker/worker.js    Cloudflare Worker：/extract 平台分发 + /proxy 白名单代理
sw.js               Service Worker：/__download 流式下载，大文件不进内存
```

三个文件的**白名单必须同步**，否则表现为「能提取但下载 403」：

- `worker/worker.js` → `ALLOWED_HOSTS`
- `sw.js` → `DOWNLOAD_HOSTS`

## 部署

### 1. Worker

```bash
cd worker
npx wrangler deploy
```

会得到 `https://video-extractor-worker.<你的子域>.workers.dev`。

### 2. 前端

把 Worker 地址填进 `index.html` 的 `WORKER_URL`，或者不改代码，在浏览器控制台执行：

```js
localStorage.setItem('ve_worker_url', 'https://video-extractor-worker.<你的子域>.workers.dev')
```

刷新即生效。`localStorage.removeItem('ve_worker_url')` 可回落到代码里的默认值。

> **国内网络注意**：`*.workers.dev` 在国内被 DNS 污染（会解析到 Facebook 的 IP 段），
> Worker 实际不可达。建议给 Worker 绑定一个自有域名再使用，否则 Telegram 与 B站
> 都会卡在「解析失败」这一步。

### 3. 静态托管

`index.html` / `sw.js` / `manifest.json` 是纯静态文件，扔到任意支持 HTTPS 的托管即可
（GitHub Pages、Cloudflare Pages、Vercel）。

## 关于抖音

抖音的视频地址由 JS 虚拟机（argus）在浏览器里**现算**，服务端抓不到。
2026-11 用一条真实作品（`v.douyin.com/G5ywVJQAtAE/`）逐条验证：

```
GET /aweme/v1/web/aweme/detail/   → 403 Blocked by ArgusSecurityPlugin Uifid Not Found
                                    （裸请求 / 带 Referer / 伪造 ttwid / 申请真实 ttwid，四次一模一样）
桌面 UA 抓分享页                   → _$jsvmprt 混淆页面，play_addr 出现 0 次
移动 UA 抓分享页                   → 有 _ROUTER_DATA，但里面只有页面配置：
                                    renderInSSR=1、itemId 正确、aweme 数据为 0，
                                    36 个 script 全是 argus SDK
分享页 <video> 标签                → 只有 poster，没有 src
老接口 iteminfo / snssdk           → 空响应，已下线
oEmbed / video/detail             → 不存在 / Unsupported path
```

**唯一能在纯 HTTP 下拿到东西的入口**：伪装 Googlebot 抓分享页，抖音会返回 SEO 版 SSR。
但它的 Schema.org `VideoObject` 故意只给 `name` / `creator` / `duration` / `thumbnail`，
没有 `contentUrl` —— 元数据给爬虫，视频流不给。这就是「能识别作品、拿不到视频」的由来。

所以本项目的抖音解析是**四层降级**：

1. 短链归一化拿到作品 ID（稳定，实测 302 → `7711233018296505766`）
2. SEO 元数据：Googlebot UA → `ld+json` → 标题 / 作者 / 封面 / 时长 / 点赞（稳定）
3. 移动端分享页的 `_ROUTER_DATA` 里的 `play_addr`（对部分公开视频可能有效，当前实测无效）
4. 第三方解析端点（需要自己配置）

第 4 层在 `worker/wrangler.toml` 里配置，不配就跳过：

```toml
[vars]
DOUYIN_PARSER = "https://your-parser.example.com/api?url={url}"
```

需要鉴权的服务用 secret 传密钥（会同时放进 `X-API-Key` 和 `Authorization: Bearer`）：

```bash
npx wrangler secret put DOUYIN_PARSER_KEY
```

端点契约很宽松：返回体里任意位置有一个像视频地址的字符串就能被识别，不要求固定 JSON 结构。
支持 `{url}` 和 `{id}` 两个占位符。

四层全失败时接口返回 `422 { "code": "douyin_needs_parser", "meta": {...} }`。
`meta` 里带着第 2 层拿到的作品信息，前端的说明卡会**先把封面/标题/作者显示出来**，
再解释为什么拿不到流——用户能确认「链接没粘错，是平台不给」。

**没有配置解析端点时，抖音功能等于不可用**，其余三个平台不受影响。

### 为什么没有内置一个"免费解析接口"

实测过的公开服务：`tikwm.com` 对本机 IP 返回 403（Cloudflare 拦截），
`api.douyin.wtf` 公开实例要求 `X-API-Key`（未鉴权直接 401）。
这类服务随时可能加鉴权、限速或下线——把它写死成默认值，等于把项目的命门交给别人。
所以这里只留适配器，由你决定接谁。

想稳定跑抖音，实际只有三条路：

| 方案 | 代价 | 命门 |
|---|---|---|
| 自建解析服务（如 douyin.wtf / TikTokDownloader，Docker 部署） | 一台 VPS + 维护 | 签名变了要跟着升级 |
| 第三方 API | 代码量最小 | 对方挂就挂；链接要发给别人 |
| 浏览器扩展 | 一行签名都不用解（用户环境已通过校验） | 是另一个产品形态，PWA 装不了扩展 |

## 已知限制

- **B站 最高 720P**：不登录的硬上限，与 X 的默认画质一致。
- **直链有时效**：B站 直链约 2 小时过期。历史记录点击时会**重新解析**（`urlExpires` 标记），
  不会复用旧地址——复用会得到一个黑屏死链且没有任何报错。
- **B站 多 P 上限 10 个**：一个 100P 的合集全解析会打爆 Worker，超出部分会在 toast 里提示。
- **B站 CDN 不能带 Referer**：带了会 503，Worker 转发时只透传 `Range`，不要加 `Referer`。
- **抖音只能拿到元数据**：见上。
- **X 默认画质被 `maxBitrate()` 锁在 4.5 Mbps**（约 720P），1080P/4K 会被静默过滤。

## 目录

```
index.html              前端（含 B站 / 抖音 / TG / X 的识别与播放逻辑）
manifest.json           PWA 清单
sw.js                   Service Worker
worker/worker.js        Cloudflare Worker
worker/wrangler.toml    Worker 配置（含 DOUYIN_PARSER 说明）
```
