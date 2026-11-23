// video-extractor-worker.js
// Cloudflare Worker —— 服务端直连解析，绕开浏览器 CORS
// Deploy: cd worker && npx wrangler deploy
//
// 路由：
//   GET  /              健康检查
//   GET  /proxy?url=    通用 GET 代理（转发 Range，供 <video> 拖动进度条）
//   POST /extract       { url } → { platform, title?, duration?, videos: [{ url, size, quality, part? }] }
//                       兼容旧字段 { tgUrl }
//
// 平台分发：t.me / bilibili.com / b23.tv / douyin.com / v.douyin.com

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// 抖音的分享页只有移动端 UA 才会走 SSR 渲染（桌面 UA 返回的是 JS 虚拟机保护页）
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// 抖音只对搜索引擎爬虫输出 SEO 版 SSR（含 Schema.org VideoObject）。
// 换这个 UA 才能拿到标题/作者/时长/封面；普通 UA 拿到的是没有数据的空壳页。
const GOOGLEBOT_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// 白名单：否则这个 Worker 会变成任何人都能白嫖的开放代理
const ALLOWED_HOSTS = [
  't.me',
  'telegram.org',
  'telesco.pe',
  'video.twimg.com',
  'pbs.twimg.com',
  'cdn.syndication.twimg.com',
  'api.fxtwitter.com',
  'platform.twitter.com',
  'abs.twimg.com',
  'api.bilibili.com',
  'www.bilibili.com',
  'b23.tv',
  'bilivideo.com',
  'hdslb.com',
  // 抖音：URL 的 host 是 douyin.com，视频流在各家 CDN 上
  'douyin.com',
  'iesdouyin.com',
  'douyinvod.com',
  'douyinpic.com',
  'zjcdn.com',
  'byteimg.com',
];

const UPSTREAM_TIMEOUT_MS = 25000;
// 视频本体可能是几十上百 MB，用 25 秒会把下载从中间掐断，代理单独放宽。
// 1GB 的视频在手机上要下十几分钟，3 分钟不够用，给到 30 分钟。
const PROXY_TIMEOUT_MS = 1800000;

// B站 多 P 的处理上限：一个 100P 的合集全解析会打爆 Worker，
// 限 10 个 + 并发 3，超出的在响应里告诉前端「还有多少个没解析」。
const BILI_MAX_PARTS = 10;
const BILI_CONCURRENCY = 3;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return json(
        {
          ok: true,
          service: 'video-extractor-worker',
          version: 4,
          platforms: ['telegram', 'bilibili', 'douyin'],
          routes: ['/proxy?url=', '/extract'],
          // 抖音：元数据（标题/作者/封面）始终可拿，视频流依赖下面的解析端点
          douyinMeta: true,
          douyinParser: !!(env && env.DOUYIN_PARSER),
          douyinParserKey: !!(env && env.DOUYIN_PARSER_KEY),
        },
        200
      );
    }

    if (request.method === 'GET' && url.pathname === '/proxy') {
      return handleProxy(request, url);
    }

    if (request.method === 'POST' && url.pathname === '/extract') {
      try {
        const body = await request.json().catch(() => null);
        // 新字段 url，旧版前端发的是 tgUrl，两个都认
        const raw = body && (body.url || body.tgUrl);
        if (!raw || typeof raw !== 'string') {
          return json({ error: 'Missing url' }, 400);
        }
        const target = raw.trim();
        const platform = detectPlatform(target);

        if (platform === 'telegram') {
          const result = await extractTelegramVideo(target);
          if (!result) return json({ error: 'No video found' }, 404);
          return json(
            {
              platform: 'telegram',
              videoUrl: result.videoUrl,
              source: result.source,
              videos: [{ url: result.videoUrl }],
            },
            200
          );
        }

        if (platform === 'bilibili') {
          return json(await extractBilibili(target), 200);
        }

        if (platform === 'douyin') {
          return json(await extractDouyin(target, env), 200);
        }

        return json({ error: 'Unsupported link: ' + safeHost(target) }, 400);
      } catch (e) {
        const status = (e && e.status) || 500;
        return json(
          {
            error: e && e.message ? e.message : 'Extraction failed',
            code: (e && e.code) || undefined,
            meta: (e && e.meta) || undefined,
          },
          status
        );
      }
    }

    return json({ error: 'Not found' }, 404);
  },
};

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  });
}

function safeHost(raw) {
  try {
    return new URL(raw).hostname;
  } catch {
    return String(raw).slice(0, 40);
  }
}

function detectPlatform(raw) {
  let host = '';
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return null;
  }
  const hit = (base) => host === base || host.endsWith('.' + base);
  if (hit('t.me') || hit('telegram.org')) return 'telegram';
  if (hit('bilibili.com') || hit('b23.tv')) return 'bilibili';
  if (hit('douyin.com') || hit('iesdouyin.com')) return 'douyin';
  return null;
}

function httpError(message, status, code, meta) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  // 失败时也想把已知的作品信息带回前端（如抖音只能拿到元数据），
  // 让用户看到"链接没识别错，是平台不给流"，而不是一个空白报错。
  if (meta) err.meta = meta;
  return err;
}

// ---------------------------------------------------------------------------
// 通用代理
// ---------------------------------------------------------------------------

async function handleProxy(request, url) {
  const raw = url.searchParams.get('url');
  if (!raw) return json({ error: 'Missing ?url=' }, 400);

  let target;
  try {
    target = new URL(raw);
  } catch {
    return json({ error: 'Invalid url' }, 400);
  }

  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return json({ error: 'Bad protocol' }, 400);
  }

  const allowed = ALLOWED_HOSTS.some(
    (h) => target.hostname === h || target.hostname.endsWith('.' + h)
  );
  if (!allowed) {
    return json({ error: 'Host not allowed: ' + target.hostname }, 403);
  }

  const headers = {
    'User-Agent': UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  // B站 CDN 收到来自别站的 Referer 会直接 503，所以这里只转发 Range，
  // 绝对不要把浏览器带来的 Referer / Origin 透传下去。
  const range = request.headers.get('Range');
  if (range) headers['Range'] = range;

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
  } catch (e) {
    return json({ error: 'Upstream failed: ' + (e && e.message ? e.message : 'unknown') }, 502);
  }

  const out = new Headers(CORS);
  for (const h of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'last-modified',
    'etag',
  ]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  if (!out.has('accept-ranges') && (out.get('content-type') || '').startsWith('video/')) {
    out.set('accept-ranges', 'bytes');
  }
  out.set('cache-control', upstream.headers.get('cache-control') || 'public, max-age=300');

  return new Response(upstream.body, { status: upstream.status, headers: out });
}

// ---------------------------------------------------------------------------
// Telegram 解析
// ---------------------------------------------------------------------------

async function extractTelegramVideo(url) {
  const cleanUrl = url.replace(/\?.*$/, '').replace(/\/$/, '');

  // t.me/c/<internalId>/<msgId> 是私有频道，必须登录，直接给明确错误
  if (/t\.me\/c\/\d+\/\d+/.test(cleanUrl)) {
    throw httpError('Private channels require login. Open in browser instead.', 400);
  }

  // t.me/<channel>、t.me/<channel>/<id>、t.me/s/<channel>[/<id>] 都接受
  const match = cleanUrl.match(/t\.me\/(?:s\/)?([A-Za-z0-9_]{3,})(?:\/(\d+))?/);
  if (!match) throw httpError('Invalid Telegram URL format', 400);

  const channel = match[1];
  const messageId = match[2] || null;

  // 只给了频道名没给消息 ID：取频道里最新的一条视频，这是用户的合理预期
  const strategies = messageId
    ? [
        { url: `https://t.me/s/${channel}/${messageId}`, source: 't.me/s/' },
        { url: `${cleanUrl}?embed=1&mode=tme`, source: 'embed' },
        { url: `${cleanUrl}?embed=1`, source: 'embed2' },
      ]
    : [{ url: `https://t.me/s/${channel}`, source: 'channel' }];

  // 总预算：策略串行，每个再叠加 25 秒超时和重试会拖到几分钟，客户端早断开了
  const deadline = Date.now() + 25000;

  // Telegram 网页版对受限内容（成人 / 被标记频道）只给一张缩略图，
  // 播放器带 not_supported 类，页面里根本不出现视频地址。
  // 这不是解析失败，是 Telegram 服务端拒绝下发，得如实告诉用户。
  let sawNotSupported = false;

  for (const s of strategies) {
    const remaining = deadline - Date.now();
    if (remaining < 2000) break;
    const html = await fetchHtml(s.url, remaining);
    if (!html) continue;
    if (isNotSupportedPage(html)) sawNotSupported = true;
    const videoUrl = parseHTMLForVideo(html, s.url);
    if (videoUrl) return { videoUrl, source: s.source };
  }

  // 指定了消息 ID 却没在单页里找到：抓频道整页，定位到目标消息那一段再解析
  if (messageId && Date.now() < deadline) {
    const feed = await fetchHtml(`https://t.me/s/${channel}`, deadline - Date.now());
    if (feed) {
      const videoUrl = parseFeedHTMLForVideo(feed, messageId);
      if (videoUrl) return { videoUrl, source: 'feed' };
    }
  }

  if (sawNotSupported) {
    throw httpError(
      'Telegram marks this post as not_supported for the web viewer (age-restricted ' +
        'or restricted channel), so it never exposes a video URL. Open it in the Telegram app.',
      422,
      'not_supported'
    );
  }

  return null;
}

function isNotSupportedPage(html) {
  return /tgme_widget_message_video_player[^"]*not_supported/i.test(html) ||
    /message_media_not_supported/i.test(html);
}

async function fetchHtml(url, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const perAttempt = Math.max(3000, Math.min(UPSTREAM_TIMEOUT_MS, timeoutMs | 0));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(perAttempt),
      });
      if (!resp.ok) continue;
      const text = await resp.text();
      if (text.length > 500) return text;
    } catch {
      // 重试一次
    }
  }
  return null;
}

function parseHTMLForVideo(html, baseUrl) {
  // 1. <video src>
  let m = html.match(/<video[^>]+src=["']([^"']+)["'][^>]*>/i);
  if (m) return absolutize(m[1], baseUrl);

  // 2. <source src>
  m = html.match(/<source[^>]+src=["']([^"']+)["'][^>]*>/i);
  if (m) return absolutize(m[1], baseUrl);

  // 3. data-video-src / data-video-url
  m =
    html.match(/data-video-src=["']([^"']+)["']/i) ||
    html.match(/data-video-url=["']([^"']+)["']/i);
  if (m) return absolutize(m[1], baseUrl);

  // 4. og:video meta
  m =
    html.match(/<meta\s+property=["']og:video(?::url|:secure_url)?["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta\s+property=["']twitter:player:stream["'][^>]+content=["']([^"']+)["']/i);
  if (m) return absolutize(m[1], baseUrl);

  // 5. tgme_player_params 等内联 JSON
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptRegex.exec(html)) !== null) {
    const jsonMatch = scriptMatch[1].match(
      /(?:var|let|const|window\.)?\s*(?:tgme_player_params|videoData|playerData|tgmePlayerParams|playerParams)\s*=\s*(\{[\s\S]*?\})\s*;?/i
    );
    if (!jsonMatch) continue;
    try {
      const data = JSON.parse(jsonMatch[1]);
      const url =
        (data.video && (data.video.src || data.video.url)) ||
        data.src ||
        data.url ||
        data.file ||
        data.video_url;
      if (url) return absolutize(url, baseUrl);
    } catch {
      // 这段不是合法 JSON，继续
    }
  }

  // 6. 内联 JSON 里的视频地址
  m =
    html.match(/"video"\s*:\s*\{[^}]*"src"\s*:\s*"([^"]+)"/) ||
    html.match(/"src"\s*:\s*"(https?:\/\/[^"]*\.(?:mp4|webm)[^"]*)"/) ||
    html.match(/"url"\s*:\s*"(https?:\/\/[^"]*\.(?:mp4|webm)[^"]*)"/) ||
    html.match(/"video_url"\s*:\s*"(https?:\/\/[^"]+)"/) ||
    html.match(/"file"\s*:\s*"(https?:\/\/[^"]*\.mp4[^"]*)"/);
  if (m) return absolutize(m[1].replace(/\\\//g, '/'), baseUrl);

  // 7. 裸的 mp4/webm/mov 链接
  m = html.match(/(https?:\/\/[^\s"'<>]+\.(?:mp4|webm|mov))/i);
  if (m) return absolutize(m[1], baseUrl);

  // 8. Telegram CDN
  m =
    html.match(/https?:\/\/cdn\d?\.(?:telesco\.pe|telegram\.org)\/[^\s"'<>]+\.(?:mp4|webm)/i) ||
    html.match(/https?:\/\/video\.(?:telesco\.pe|telegram\.org)\/[^\s"'<>]+\.(?:mp4|webm)/i);
  if (m) return absolutize(m[0], baseUrl);

  return null;
}

// 原来用 /<div[^>]*data-post=...[\s\S]*?<\/div>/ 非贪婪匹配，
// 遇到第一个 </div> 就断，嵌套结构必然截错。改成按 data-post 切段。
function parseFeedHTMLForVideo(html, messageId) {
  const safeId = String(messageId).replace(/[^0-9]/g, '');
  if (!safeId) return null;

  const marker = new RegExp(`data-post=["'][^"']*${safeId}(?![0-9])["']`, 'i');
  const hit = marker.exec(html);
  if (!hit) return null;

  const rest = html.slice(hit.index);
  const nextIdx = rest.slice(1).search(/data-post=["']/i);
  const block = nextIdx > 0 ? rest.slice(0, nextIdx + 1) : rest.slice(0, 20000);

  return parseHTMLForVideo(block, 'https://t.me');
}

// 相对地址必须补成绝对地址，否则前端拿到 "/file/xxx.mp4" 没法直接播
function absolutize(raw, baseUrl) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  try {
    return new URL(s, baseUrl || 'https://t.me').toString().replace(/^http:\/\//i, 'https://');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// B站 解析
// ---------------------------------------------------------------------------
//
// 实测（2026-11）：
//   - /x/web-interface/view 与 /x/player/playurl 都不需要登录、不需要 wbi 签名
//   - playurl 用 fnval=1&platform=html5 直接给单文件 mp4（已含音轨），不用合流
//   - 但 api.bilibili.com 见到 Origin 头就 403，所以这两步必须在服务端做
//   - 视频 CDN 反而全开 CORS，所以视频本体交给浏览器直连，不占后端带宽

const BILI_QUALITY_NAME = {
  6: '240P', 16: '360P', 32: '480P', 64: '720P', 74: '720P60',
  80: '1080P', 112: '1080P+', 116: '1080P60', 120: '4K', 125: 'HDR', 126: '杜比', 127: '8K',
};

// B站 的业务错误码 → 人话。在 Worker 里映射，前端拿到的就是可以直接展示的句子。
const BILI_ERRORS = {
  '-400': '链接里的视频号不合法',
  '-403': 'B站 拒绝访问（可能是接口风控，稍后重试）',
  '-404': '视频不存在或已被删除',
  '-352': '触发 B站 风控，请稍后重试',
  '-10403': '该视频有地区限制，当前节点无法访问',
  62002: '稿件不可见（私密 / 审核中 / 已下架）',
  62004: '稿件审核中',
};

function biliError(code, fallback) {
  const key = String(code);
  const msg = BILI_ERRORS[key] || fallback || `B站 返回错误码 ${code}`;
  return httpError(msg, 422, 'bili_' + key);
}

async function biliApi(pathWithQuery) {
  const resp = await fetch('https://api.bilibili.com' + pathWithQuery, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      // Referer 对 B站 接口是安全的（实测 200），Origin 才是雷区，绝不能带
      Referer: 'https://www.bilibili.com/',
    },
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw httpError(`B站 接口不可用（HTTP ${resp.status}）`, 502, 'bili_http_' + resp.status);
  }
  return await resp.json();
}

async function extractBilibili(rawUrl) {
  const pageUrl = await resolveBilibiliUrl(rawUrl);

  const bv = (pageUrl.match(/BV[0-9A-Za-z]{10}/) || [])[0];
  const av = (pageUrl.match(/\/video\/av(\d+)/i) || pageUrl.match(/[?&]aid=(\d+)/) || [])[1];
  if (!bv && !av) {
    throw httpError('链接里找不到 BV 号或 av 号', 400, 'bili_no_id');
  }

  // 分 P 参数：?p=2
  const pMatch = pageUrl.match(/[?&]p=(\d+)/);
  const wantedPage = pMatch ? Math.max(1, parseInt(pMatch[1], 10)) : 1;

  const viewPath = bv
    ? `/x/web-interface/view?bvid=${bv}`
    : `/x/web-interface/view?aid=${av}`;
  const view = await biliApi(viewPath);
  if (view.code !== 0) throw biliError(view.code, view.message);
  const info = view.data || {};
  const bvid = info.bvid || bv;

  const allPages = Array.isArray(info.pages) && info.pages.length
    ? info.pages
    : [{ cid: info.cid, page: 1, part: info.title }];

  // 指定了 ?p=N 就只解析那一 P，否则解析前 10 P
  let targets = allPages;
  if (pMatch) {
    const one = allPages.find((x) => Number(x.page) === wantedPage);
    targets = one ? [one] : allPages.slice(0, 1);
  }
  const totalParts = allPages.length;
  targets = targets.slice(0, BILI_MAX_PARTS);
  const multi = targets.length > 1;

  const results = await mapLimit(targets, BILI_CONCURRENCY, async (pg) => {
    try {
      const play = await biliPlayUrl(bvid, pg.cid);
      if (!play) return null;
      return {
        url: play.url,
        size: play.size,
        quality: play.quality,
        part: multi ? (pg.part || `P${pg.page}`) : undefined,
      };
    } catch {
      // 单个分 P 失败不该拖垮整个合集
      return null;
    }
  });

  const videos = results.filter(Boolean);
  if (!videos.length) {
    throw httpError('该视频没有可取用的直链（可能是充电专属或版权限制）', 422, 'bili_no_stream');
  }

  return {
    platform: 'bilibili',
    title: info.title || '',
    duration: info.duration || 0,
    videos,
    limited: totalParts > BILI_MAX_PARTS
      ? { total: totalParts, parsed: BILI_MAX_PARTS }
      : undefined,
  };
}

// b23.tv 短链要跟一次重定向；顺手把各种入口链接归一成带 BV 号的形式
async function resolveBilibiliUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host === 'b23.tv' || host.endsWith('.b23.tv')) {
      const resp = await fetch(rawUrl, {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      // fetch 跟完重定向后 resp.url 就是最终地址
      const finalUrl = resp.url || '';
      if (/BV[0-9A-Za-z]{10}/.test(finalUrl) || /\/video\/av\d+/i.test(finalUrl)) {
        return finalUrl;
      }
      // 少数短链返回 200 的中转页，再从正文里捞一次
      const html = await resp.text().catch(() => '');
      const m = html.match(/https?:\/\/www\.bilibili\.com\/video\/[^"'\s<>\\]+/i);
      if (m) return m[0].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
    }
  } catch {
    // 短链解析失败就按原链接继续，后面还会从原文里找 BV 号
  }
  return rawUrl;
}

async function biliPlayUrl(bvid, cid) {
  const qs = new URLSearchParams({
    bvid,
    cid: String(cid),
    qn: '80',          // 请求 1080P；未登录会自动降级到 64(720P)，不算失败
    fnval: '1',        // 1 = durl 单文件 mp4（已含音轨），不需要合流
    fnver: '0',
    fourk: '1',
    platform: 'html5',
    high_quality: '1',
  });
  const data = await biliApi('/x/player/playurl?' + qs.toString());
  if (data.code !== 0) throw biliError(data.code, data.message);

  const d = data.data || {};
  const first = Array.isArray(d.durl) ? d.durl[0] : null;
  if (!first || !first.url) return null;

  return {
    url: first.url.replace(/^http:\/\//i, 'https://'),
    size: first.size || 0,
    quality: BILI_QUALITY_NAME[d.quality] || (d.quality ? String(d.quality) : ''),
  };
}

// ---------------------------------------------------------------------------
// 抖音 解析
// ---------------------------------------------------------------------------
//
// 实测（2026-11）结论：抖音没有"纯 HTTP 就能拿数据"的口子。逐条验过：
//   - /aweme/v1/web/aweme/detail  → Blocked by ArgusSecurityPlugin Uifid Not Found
//     （裸请求 / 带 Referer / 带伪造 ttwid / 带真实 ttwid 申请结果，四次一模一样）
//   - 桌面 UA 抓分享页            → 返回 _$jsvmprt JS 虚拟机保护页，0 处 play_addr
//   - 移动 UA 抓分享页            → 有 _ROUTER_DATA，但里面只有页面配置
//     （renderInSSR:1，itemId 正确，aweme 数据为 0；36 个 script 全是 argus SDK）
//   - 老接口 iteminfo / snssdk    → 空响应，已下线
//   - 公开 oEmbed / video/detail  → 不存在
//
// 唯一能在纯 HTTP 下拿到东西的入口：伪装 Googlebot 抓分享页，抖音会返回 SEO 版 SSR。
// 但它的 Schema.org VideoObject 故意只给 name/creator/duration/thumbnail，
// <video> 标签只有 poster 没有 src，没有 contentUrl —— 元数据给爬虫，视频流不给。
//
// 所以做成四层降级：
//   ① 短链归一化拿到作品 ID          （稳定）
//   ② SEO 元数据（Googlebot UA）      （稳定，只到标题/作者/时长/封面）
//   ③ 移动端分享页的 SSR play_addr    （对部分公开视频可能有效，实测当前无效）
//   ④ 可选的第三方解析端点            （wrangler.toml 里配置 DOUYIN_PARSER）
// 全失败时抛结构化错误，并把 ② 拿到的元数据一起带回去，
// 前端据此显示"作品卡片 + 原因说明"，而不是让人对着转圈猜。

async function extractDouyin(rawUrl, env) {
  const resolved = await resolveDouyinUrl(rawUrl);
  const id = resolved.id;
  if (!id) {
    throw httpError('无法从链接中解析出抖音作品 ID', 400, 'douyin_no_id');
  }

  // ② SEO 元数据：拿不到视频流，但能确认作品存在并拿到标题/作者
  const meta = await fetchDouyinSeoMeta(id);

  // ③ 移动端分享页 SSR（有 play_addr 就直接成功）
  try {
    const ssr = await fetchDouyinSharePage(id);
    const parsed = ssr ? parseDouyinPage(ssr) : null;
    if (parsed && parsed.videos.length) {
      return {
        platform: 'douyin',
        title: parsed.title || (meta && meta.title) || '',
        duration: parsed.duration || (meta && meta.duration) || 0,
        videos: parsed.videos,
        via: 'ssr',
      };
    }
  } catch {
    // 继续降级
  }

  // ④ 第三方解析端点
  const viaParser = await tryDouyinParser(resolved.pageUrl, id, env);
  if (viaParser && viaParser.videos.length) {
    return {
      platform: 'douyin',
      title: viaParser.title || (meta && meta.title) || '',
      videos: viaParser.videos,
      via: 'parser',
    };
  }

  throw httpError(
    '抖音的分享页由 JS 虚拟机（argus）保护，页面里 <video> 只有封面没有地址，' +
      '服务端拿不到视频流。要提取抖音需在 Worker 配置第三方解析端点（wrangler.toml 的 DOUYIN_PARSER）。',
    422,
    'douyin_needs_parser',
    meta || undefined
  );
}

// 伪装搜索引擎抓分享页，解析 Schema.org 的 VideoObject。
// 这是抖音唯一愿意在纯 HTTP 下交出来的东西：标题、作者、时长、封面。
async function fetchDouyinSeoMeta(id) {
  const html = await fetchHtmlWithUa(
    `https://www.iesdouyin.com/share/video/${id}/`,
    GOOGLEBOT_UA,
    20000
  );
  if (!html) return null;

  const blocks = html.match(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  if (!blocks) return null;

  for (const block of blocks) {
    const body = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>$/i, '');
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      continue;
    }
    if (!data || data['@type'] !== 'VideoObject') continue;

    // name 形如 "#邪恶小帽咪 - 抖音"，把尾巴去掉
    const title = String(data.name || '')
      .replace(/\s*-\s*抖音\s*$/, '')
      .trim()
      .slice(0, 120);

    // duration 是 ISO 8601 区间，如 PT0H0M9S
    let duration = 0;
    const dm = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(String(data.duration || ''));
    if (dm) {
      duration =
        (parseInt(dm[1] || '0', 10) * 3600) +
        (parseInt(dm[2] || '0', 10) * 60) +
        parseInt(dm[3] || '0', 10);
    }

    const creator = data.creator || {};
    const likes = Array.isArray(creator.interactionStatistic)
      ? creator.interactionStatistic[0] && creator.interactionStatistic[0].userInteractionCount
      : null;

    return {
      id,
      title,
      author: typeof creator.name === 'string' ? creator.name.slice(0, 60) : '',
      cover: Array.isArray(data.thumbnailUrl) ? data.thumbnailUrl[0] || '' : '',
      duration,
      uploadDate: data.uploadDate || '',
      likes: typeof likes === 'number' ? likes : null,
      pageUrl: `https://www.douyin.com/video/${id}`,
    };
  }

  return null;
}

async function resolveDouyinUrl(rawUrl) {
  const pick = (s) => (String(s).match(/\/(?:video|note|slides)\/(\d{15,25})/) || [])[1] || null;

  let id = pick(rawUrl);
  let pageUrl = rawUrl;

  if (!id) {
    // v.douyin.com/xxxx 需要跟一次重定向才知道作品 ID
    try {
      const resp = await fetch(rawUrl, {
        headers: { 'User-Agent': MOBILE_UA, Accept: 'text/html' },
        redirect: 'follow',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      pageUrl = resp.url || rawUrl;
      id = pick(pageUrl);
      if (!id) {
        const html = await resp.text().catch(() => '');
        id = pick(html);
        if (!id) {
          const m = html.match(/"(?:aweme_id|itemId)"\s*:\s*"?(\d{15,25})"?/);
          if (m) id = m[1];
        }
      }
    } catch {
      // 落回 null，由上层报错
    }
  }

  return { id, pageUrl };
}

function fetchDouyinSharePage(id) {
  return fetchHtmlWithUa(`https://www.iesdouyin.com/share/video/${id}/`, MOBILE_UA, 20000);
}

async function fetchHtmlWithUa(url, ua, timeoutMs = 20000) {
  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': ua,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    return text.length > 500 ? text : null;
  } catch {
    return null;
  }
}

// 分享页把数据塞在 window._ROUTER_DATA 里。有数据时能挖到 play_addr.url_list；
// 被风控或作品不存在时那块只剩页面配置，挖不到就返回 null。
function parseDouyinPage(html) {
  const m = html.match(/_ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
  if (!m) return null;

  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }

  const playAddr = findDeep(data, 'play_addr');
  const urlList = playAddr && (playAddr.url_list || playAddr.urlList);
  if (!Array.isArray(urlList) || !urlList.length) return null;

  // playwm 是带水印版本，换成 play 取无水印
  const clean = urlList
    .map((u) => String(u).replace('/playwm/', '/play/').replace('playwm', 'play'))
    .filter((u) => /^https?:\/\//i.test(u));

  if (!clean.length) return null;

  const desc = findDeep(data, 'desc');
  const durationRaw = findDeep(data, 'duration');

  return {
    title: typeof desc === 'string' ? desc.slice(0, 120) : '',
    duration:
      typeof durationRaw === 'number'
        ? Math.round(durationRaw / (durationRaw > 10000 ? 1000 : 1))
        : 0,
    videos: clean.slice(0, 3).map((u) => ({ url: u.replace(/^http:\/\//i, 'https://'), size: 0 })),
  };
}

// 第三方解析端点。契约故意放宽：只要返回体里任意位置有一个像视频地址的字符串
// 就认，这样常见的开源解析服务基本能直接接（不要求固定的 JSON 结构）。
//   wrangler.toml →  [vars]  DOUYIN_PARSER = "https://your-parser.example.com/api?url={url}"
//   可选鉴权     →  wrangler secret put DOUYIN_PARSER_KEY   （会同时放进 X-API-Key 和 Authorization）
// 支持 {url} 与 {id} 两个占位符；不配置就跳过这一层。
async function tryDouyinParser(pageUrl, id, env) {
  const base = env && env.DOUYIN_PARSER;
  if (!base || typeof base !== 'string') return null;

  let endpoint = base;
  if (endpoint.includes('{url}')) {
    endpoint = endpoint.replace(/\{url\}/g, encodeURIComponent(pageUrl));
  } else if (endpoint.includes('{id}')) {
    endpoint = endpoint.replace(/\{id\}/g, encodeURIComponent(id));
  } else {
    endpoint = endpoint + (endpoint.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(pageUrl);
  }

  if (!/^https:\/\//i.test(endpoint)) return null;

  // 很多解析服务要鉴权（如 douyin.wtf 公开实例要求 X-API-Key），
  // 用 wrangler secret 传，别写进 wrangler.toml。
  const headers = { 'User-Agent': UA, Accept: 'application/json, text/plain, */*' };
  const key = env && env.DOUYIN_PARSER_KEY;
  if (key && typeof key === 'string') {
    headers['X-API-Key'] = key;
    headers['Authorization'] = /^Bearer\s/i.test(key) ? key : 'Bearer ' + key;
  }

  try {
    const resp = await fetch(endpoint, {
      headers,
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) return null;
    const text = await resp.text();
    if (!text || text.length < 10) return null;

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // 有些服务直接返回一段文本，用正则兜底
      const raw = text.match(/https?:\/\/[^\s"'<>\\]+\.mp4[^\s"'<>\\]*/i);
      return raw ? { videos: [{ url: raw[0].replace(/\\\//g, '/'), size: 0 }] } : null;
    }

    const urls = collectVideoUrls(data);
    if (!urls.length) return null;

    const desc = findDeep(data, 'desc');
    return {
      title: typeof desc === 'string' ? desc.slice(0, 120) : '',
      videos: urls.slice(0, 3).map((u) => ({ url: u, size: 0 })),
    };
  } catch {
    return null;
  }
}

// 深度遍历找一个 key（抖音的数据层级每个版本都在变，写死路径必挂）
function findDeep(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 14) return null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const hit = findDeep(item, key, depth + 1);
      if (hit !== null && hit !== undefined) return hit;
    }
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(obj, key)) {
    const v = obj[key];
    if (v !== null && v !== undefined) return v;
  }
  for (const v of Object.values(obj)) {
    const hit = findDeep(v, key, depth + 1);
    if (hit !== null && hit !== undefined) return hit;
  }
  return null;
}

function collectVideoUrls(obj, depth = 0, out = []) {
  if (!obj || typeof obj !== 'object' || depth > 14 || out.length >= 6) return out;
  for (const v of Object.values(obj)) {
    if (typeof v === 'string') {
      if (
        /^https?:\/\//i.test(v) &&
        /\.mp4|douyinvod|zjcdn|bytecdn|video_id=/i.test(v) &&
        !/\.(jpe?g|png|webp|gif)/i.test(v)
      ) {
        out.push(v.replace(/\\\//g, '/'));
      }
    } else if (v && typeof v === 'object') {
      collectVideoUrls(v, depth + 1, out);
    }
    if (out.length >= 6) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

// 限并发 map（B站 合集解析用）：既不打爆 Worker，也不会串行等到超时
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runner());
  await Promise.all(runners);
  return results;
}
