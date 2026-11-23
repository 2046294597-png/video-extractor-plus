# 视频提取器 Plus

从 B站、抖音、Telegram、Twitter/X 提取视频直链，支持在线预览与下载。

本项目由 [video-extractor](https://github.com/2046294597-png/video-extractor) 复制而来，
在其基础上增加了 B站 与抖音的解析能力。

## 平台支持

| 平台 | 状态 | 解析位置 | 画质上限 | 备注 |
|---|---|---|---|---|
| B站 | ✅ 可用 | Worker | 720P | 不登录的硬上限；1080P 需要大会员 cookie |
| 抖音 | ⚠️ 需配置 | Worker + 第三方 | 取决于解析源 | 见下方「关于抖音」 |
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

抖音的视频地址由一段 `_$jsvmprt` 保护的 JS 虚拟机在浏览器里**现算**，服务端抓不到。
实测结论：

```
GET /aweme/v1/web/aweme/detail/   → Blocked by ArgusSecurityPlugin Uifid Not Found
桌面 UA 抓分享页                   → 返回 _$jsvmprt 混淆页面，play_addr 出现 0 次
移动 UA 抓分享页                   → 能拿到 _ROUTER_DATA（本项目已实现这条路径）
老接口 iteminfo / snssdk           → 空响应，已下线
```

所以本项目的抖音解析是**三层降级**：

1. 短链归一化拿到作品 ID（稳定）
2. 移动端分享页的 `_ROUTER_DATA`（对部分公开视频可能有效）
3. 第三方解析端点（需要自己配置）

第 3 层在 `worker/wrangler.toml` 里配置，不配就跳过：

```toml
[vars]
DOUYIN_PARSER = "https://your-parser.example.com/api?url={url}"
```

端点契约很宽松：返回体里任意位置有一个像视频地址的字符串就能被识别。
支持 `{url}` 和 `{id}` 两个占位符。

三层全失败时接口返回 `422 { "code": "douyin_needs_parser" }`，前端会显示一张说明卡，
而不是让用户对着转圈猜。

**没有配置解析端点时，抖音功能等于不可用**，其余三个平台不受影响。

## 已知限制

- **B站 最高 720P**：不登录的硬上限，与 X 的默认画质一致。
- **直链有时效**：B站 直链约 2 小时过期。历史记录点击时会**重新解析**（`urlExpires` 标记），
  不会复用旧地址——复用会得到一个黑屏死链且没有任何报错。
- **B站 多 P 上限 10 个**：一个 100P 的合集全解析会打爆 Worker，超出部分会在 toast 里提示。
- **B站 CDN 不能带 Referer**：带了会 503，Worker 转发时只透传 `Range`，不要加 `Referer`。
- **抖音依赖外部服务**：见上。
- **X 默认画质被 `maxBitrate()` 锁在 4.5 Mbps**（约 720P），1080P/4K 会被静默过滤。

## 目录

```
index.html              前端（含 B站 / 抖音 / TG / X 的识别与播放逻辑）
manifest.json           PWA 清单
sw.js                   Service Worker
worker/worker.js        Cloudflare Worker
worker/wrangler.toml    Worker 配置（含 DOUYIN_PARSER 说明）
```
