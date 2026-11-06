// dsh-qq-image —— QQ 生图 / 生视频 / 小说封面插件（DSH 插件，OneBot v11）
//
// 零硬编码凭据：接口地址、API Key、模型名全部来自插件设置或环境变量。
//   apiBaseUrl  生图服务地址，默认就是 Agnes（https://api.agnes-ai.cn/v1）；换服务商改这里
//   apiKey      必填（也可用环境变量 AGNES_API_KEY / QQ_IMAGE_API_KEY）——包里不含任何密钥
//
// 指令（私聊直接说；群里必须 @ 机器人）：
//   生图 <描述>          画图 <描述>          绘图 <描述>
//   生视频 <描述>        生成视频 <描述>
//   封面 <书名> [作者] [风格]
// 工具：
//   qq_image_generate({ chat, prompt, kind, size })   主动发图/发视频到指定会话
//   qq_image_status()                                 自检

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createAdapter } from './onebot.js';

// 有些机器（比如只有 IPv4 出口的）undici 会挑到 AAAA 记录直接 fetch failed，先按 IPv4 解析
try {
  const { default: dns } = await import('node:dns');
  dns.setDefaultResultOrder('ipv4first');
} catch { /* 老 node 没这个 API */ }
import { registerTool, defineConfig } from './dsh-compat.js';

export const name = 'dsh-qq-image';
export const inject = ['tools'];

const KINDS = {
  image: { label: '图片', word: '生图' },
  cover: { label: '封面', word: '封面' },
  video: { label: '视频', word: '生视频' },
};

const DEFAULT_PROMPT_SUFFIX = '画面清晰，构图讲究，不要文字水印，不要变形的手';

export const Config = defineConfig({
  onebotHttpUrl: { type: 'string', default: 'http://127.0.0.1:3000', description: 'OneBot v11 HTTP 接口地址（NapCat/Lagrange/LLOneBot/snowluma 都填这个）' },
  onebotWsUrl: { type: 'string', default: 'ws://127.0.0.1:3001', description: 'OneBot v11 正向 WebSocket 地址，如 ws://127.0.0.1:3001。填了才能主动收 QQ 消息' },
  onebotToken: { type: 'string', default: '', description: 'OneBot HTTP token，没设就留空' },
  onebotWsToken: { type: 'string', default: '', description: 'OneBot WebSocket token，留空=与 HTTP token 相同（SnowLuma 两者不同：WS 用 accessToken、HTTP 用 httpAccessToken）' },
  selfId: { type: 'string', default: '', description: '机器人自己的 QQ 号（用来识别群里 @ 和忽略自己发的消息）' },
  apiBaseUrl: { type: 'string', default: 'https://api.agnes-ai.cn/v1', description: '生图服务地址（OpenAI 兼容）。默认 Agnes，换服务商只改这里' },
  apiKey: { type: 'string', default: '', description: '生图服务 API Key（也可用环境变量 AGNES_API_KEY / QQ_IMAGE_API_KEY）' },
  imageModel: { type: 'string', default: 'agnes-image-2.5-flash', description: '文生图模型名' },
  videoModel: { type: 'string', default: 'agnes-video-2.5-flash', description: '文生视频模型名' },
  imageSize: { type: 'string', default: '1024x1024', description: '普通出图尺寸' },
  coverSize: { type: 'string', default: '864x1152', description: '封面尺寸（3:4 竖版）' },
  videoSeconds: { type: 'string', default: '5', description: '视频时长（秒）' },
  videoSize: { type: 'string', default: '720P', description: '视频分辨率' },
  promptSuffix: { type: 'string', default: DEFAULT_PROMPT_SUFFIX, description: '自动追加到描述末尾的质量提示，留空不加' },
  maxMB: { type: 'number', default: 40, description: '产物体积上限（MB），超过就报错不下载' },
  videoTimeoutMinutes: { type: 'number', default: 15, description: '视频任务最长等待时间（分钟）；也认 maxWaitMinutes 这个名字' },
  maxWaitMinutes: { type: 'number', default: 0, description: '同 videoTimeoutMinutes，老配置用过这个名字（填了就用它）' },
  requireAtInGroup: { type: 'boolean', default: true, description: '群里必须 @ 机器人才响应' },
  allowVideo: { type: 'boolean', default: true, description: '允许生成视频（关掉只留生图/封面）' },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hashOf = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 12);

function cleanPrompt(text) {
  return String(text || '')
    .replace(/^(\s*@[^\s@]{1,24}\s*)+/g, '')
    .replace(/^[\s，,。.：:、]+/, '')
    .replace(/^[《「『]|[》」』]$/g, '')
    .trim();
}

/** 从消息里认出「在让我生成什么」。认不出返回 null。 */
export function parseGenCommand(text) {
  const s = String(text || '').replace(/^(\s*@[^\s@]{1,24}\s*)+/g, '').replace(/^[\s，,。.：:、]+/, '').trim();
  const m = s.match(/^(生成封面|生成视频|做个封面|来张封面|封面图|生封面|做封面|画封面|生视频|生图|画图|绘图|封面|视频|图片|图|画|短片|生成)\s*[:：,，]?\s*([\s\S]*)$/);
  if (!m) {
    const tail = s.match(/^(?:给|帮|帮我|帮忙|替)?\s*(.+?)\s*(?:做|生成|画|来|整)\s*(?:个|张|一张)?\s*封面$/);
    if (tail?.[1]) return { hit: true, word: '封面', kind: 'cover', prompt: tail[1].trim() };
    return { hit: false };
  }
  const word = m[1];
  let kind = word.includes('封面') ? 'cover' : word.includes('视频') || word.includes('短片') ? 'video' : 'image';
  const prompt = cleanPrompt(m[2]);
  if (word === '生成' && prompt) {
    kind = /视频|动画|动起来|镜头|运镜|动态|延时|慢动作/.test(prompt) ? 'video' : 'image';
  }
  if (!prompt) return { hit: false, needPrompt: true, kind };
  return { hit: true, word, kind, prompt };
}

/** 封面描述：书名/作者/风格 从「《书名》 作者 风格」里尽量抠。 */
export function coverPrompt({ title, author, style }) {
  const t = String(title || '').trim() || '无题';
  const a = String(author || '').trim();
  const st = String(style || '').trim() || '高级感插画';
  return [
    '小说封面设计，3:4 竖版构图，画面中央或上方留出干净区域放书名。',
    `书名：《${t}》`,
    a ? `作者：${a}` : '',
    `风格：${st}，构图讲究、有质感、光影细腻，商业封面水准。`,
    '文字要求：书名与作者用中文字体清晰排版，字迹工整，不要错字、不要英文乱码、不要水印。',
  ].filter(Boolean).join('\n');
}

export function apply(ctx, config) {
  const log = (msg) => { try { ctx.logger?.info?.(msg) ?? console.log(`[${name}] ${msg}`); } catch { /* ignore */ } };
  const cfg = () => ({ ...Config.defaults, ...(config || {}) });
  const setting = (k) => cfg()[k];

  const apiKey = () => String(setting('apiKey') || process.env.AGNES_API_KEY || process.env.QQ_IMAGE_API_KEY || '').trim();
  const baseUrl = () => String(setting('apiBaseUrl') || process.env.AGNES_API_BASE_URL || process.env.QQ_IMAGE_BASE_URL || '').replace(/\/+$/, '');
  // 老配置里视频等待叫 maxWaitMinutes，新的叫 videoTimeoutMinutes，两个都认
  const waitMinutes = () => Number(setting('maxWaitMinutes')) || Number(setting('videoTimeoutMinutes')) || 15;

  // 前置插件提醒：生图/生视频能力来自 dsh-agnes-studio。没填 key 时把话说清楚，别让人以为插件坏了。
  if (!apiKey()) {
    log('没配 apiKey：需要先安装 dsh-agnes-studio（生图/生视频能力由它提供）；apiKey 需通过 https://agnes-ai.cn/ 注册后获取，再填到设置里（或环境变量 AGNES_API_KEY）');
  }

  const adapter = createAdapter({
    httpUrl: setting('onebotHttpUrl'),
    wsUrl: setting('onebotWsUrl'),
    token: setting('onebotToken'),
    wsToken: setting('onebotWsToken'),
    selfId: setting('selfId'),
    log,
  });

  const tmpDir = () => String(setting('tmpDir') || '').trim() || path.join(os.tmpdir(), 'dsh-qq-image');

  async function api(apiPath, { method = 'POST', body, timeoutMs = 120000, retries = 2 } = {}) {
    const base = baseUrl();
    if (!base) throw new Error('没配生图服务地址（设置里的 apiBaseUrl）');
    const key = apiKey();
    if (!key) throw new Error('没配生图 API Key（设置里的 apiKey，或环境变量 QQ_IMAGE_API_KEY）');
    let last;
    for (let i = 0; i <= retries; i += 1) {
      try {
        const res = await fetch(`${base}${apiPath}`, {
          method,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON */ }
        if (res.ok) return json ?? {};
        const msg = json?.message || json?.error?.message || json?.error || text.slice(0, 200);
        const error = new Error(`${res.status} ${msg}`.trim());
        error.status = res.status;
        if (res.status < 500 && res.status !== 429) throw error;
        last = error;
      } catch (error) {
        if (error.status && error.status < 500 && error.status !== 429) throw error;
        last = error;
      }
      if (i < retries) await sleep(1200 * 2 ** i);
    }
    throw last;
  }

  async function textToImage(prompt, size) {
    const json = await api('/images/generations', {
      body: { model: setting('imageModel'), prompt, size: size || setting('imageSize'), extra_body: { response_format: 'url' } },
    });
    const url = json?.data?.[0]?.url || json?.url;
    if (!url) throw new Error('生图接口没返回图片地址');
    return url;
  }

  async function submitVideo(prompt) {
    let last;
    for (let i = 0; i <= 6; i += 1) {
      try {
        const sub = await api('/videos', { body: { model: setting('videoModel'), prompt, mode: 'text', seconds: String(setting('videoSeconds')), size: setting('videoSize') }, retries: 0 });
        const id = sub?.video_id || sub?.id || sub?.task_id;
        if (!id) throw new Error('视频接口没返回任务 ID');
        return String(id);
      } catch (error) {
        last = error;
        if (!/video_queue_full|队列已满/i.test(String(error?.message || ''))) throw error;
        log(`视频队列满，${15 * (i + 1)} 秒后重试`);
        await sleep(15000 * (i + 1));
      }
    }
    throw new Error(`视频队列一直满，稍后再试（${last?.message || ''}）`);
  }

  async function pollVideo(videoId) {
    const until = Date.now() + Math.max(1, waitMinutes()) * 60_000;
    while (Date.now() < until) {
      await sleep(8000);
      const st = await api(`/videos/${encodeURIComponent(videoId)}`, { method: 'GET', retries: 1 });
      const status = String(st?.status ?? '');
      if (status === 'completed') {
        const url = st?.url || st?.metadata?.url;
        if (!url) throw new Error('任务完成但没返回视频地址');
        return url;
      }
      if (status === 'failed') throw new Error(String(st?.error?.message || st?.error || '视频生成失败'));
    }
    throw new Error('视频生成超时');
  }

  async function download(url, ext) {
    const maxBytes = Math.max(1, Number(setting('maxMB')) || 40) * 1048576;
    const dest = path.join(tmpDir(), `${Date.now()}-${hashOf(url)}${ext}`);
    const res = await fetch(url, { signal: AbortSignal.timeout(300000) });
    if (!res?.ok) throw new Error(`下载失败 HTTP ${res?.status ?? '?'}`);
    const declared = Number(res.headers?.get?.('content-length') || 0);
    if (declared && declared > maxBytes) throw new Error(`产物 ${(declared / 1048576).toFixed(1)}MB 超过上限 ${setting('maxMB')}MB`);
    if (!res.body) throw new Error('响应没有 body');
    let written = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        written += chunk.length;
        if (written > maxBytes) return cb(new Error('产物超过体积上限'));
        cb(null, chunk);
      },
    });
    await mkdir(path.dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(dest));
    return { dest, bytes: written };
  }

  async function sendImage(chat, url) {
    const { dest } = await download(url, '.png');
    try {
      const buf = await readFile(dest);
      await adapter.sendImage(chat, buf.toString('base64'));
    } finally { await unlink(dest).catch(() => {}); }
  }

  async function sendVideo(chat, url) {
    const { dest } = await download(url, '.mp4');
    try {
      await adapter.sendVideo(chat, `file://${dest}`);
    } catch (error) {
      // 有些实现不认 file://，退回 base64
      const buf = await readFile(dest);
      await adapter.sendVideo(chat, `base64://${buf.toString('base64')}`);
    } finally { setTimeout(() => { unlink(dest).catch(() => {}); }, 60_000); }
  }

  async function generate({ chat, kind = 'image', prompt, size, title, author, style }) {
    const k = KINDS[kind] ? kind : 'image';
    const suffix = String(setting('promptSuffix') || '').trim();
    const finalPrompt = k === 'cover'
      ? coverPrompt({ title: title || prompt, author, style })
      : [cleanPrompt(prompt), suffix].filter(Boolean).join('，');
    if (!finalPrompt) throw new Error('没给描述');
    if (k === 'video') {
      if (!setting('allowVideo')) throw new Error('视频生成被关掉了（设置里的 allowVideo）');
      const id = await submitVideo(finalPrompt);
      log(`视频任务已提交：${id}`);
      const url = await pollVideo(id);
      await sendVideo(chat, url);
      return { kind: 'video', prompt: finalPrompt, url };
    }
    const url = await textToImage(finalPrompt, k === 'cover' ? setting('coverSize') : size || setting('imageSize'));
    await sendImage(chat, url);
    return { kind: k, prompt: finalPrompt, url };
  }

  // ───────────── 指令入口 ─────────────
  async function handleMessage(msg) {
    if (!msg) return { skip: false };
    if (msg.kind === 'group' && setting('requireAtInGroup') && !msg.atMe) return { skip: false };
    const parsed = parseGenCommand(msg.text);
    if (!parsed?.hit) return { skip: false };
    if (parsed.kind === 'video' && !setting('allowVideo')) {
      await adapter.sendText(msg.chat, '视频生成关掉了，只能生图/做封面。');
      return { skip: true };
    }
    const label = KINDS[parsed.kind].label;
    const eta = parsed.kind === 'video' ? '1~3 分钟' : '10~30 秒';
    await adapter.sendText(msg.chat, `🎨 收到，正在生成${label}（${eta}）…`);
    try {
      const out = await generate({ chat: msg.chat, kind: parsed.kind, prompt: parsed.prompt });
      log(`生成完成：${out.kind} ${out.url}`);
      return { skip: true };
    } catch (error) {
      await adapter.sendText(msg.chat, `生成失败：${error?.message || error}`);
      return { skip: true };
    }
  }

  const disposeWs = adapter.onEvent((msg) => { handleMessage(msg).catch((e) => log(`处理消息出错：${e?.message || e}`)); });
  ctx.effect?.(() => () => disposeWs?.(), 'dsh-qq-image-ws');

  // ───────────── 工具 ─────────────
  const chatArg = {
    kind: { type: 'string', enum: ['private', 'group'], description: '会话类型', required: true },
    id: { type: 'integer', description: 'QQ 号或群号', required: true },
  };

  registerTool(ctx, {
    name: 'qq_image_generate',
    description: '生成图片/封面/视频并发送到指定 QQ 会话。kind=image 普通图、cover 小说封面（可用 title/author/style）、video 短视频。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chat: { type: 'object', description: '发送目标', required: true, additionalProperties: false, properties: chatArg },
        prompt: { type: 'string', description: '画面描述；kind=cover 时可以直接放书名', required: true },
        kind: { type: 'string', enum: ['image', 'cover', 'video'], description: '生成类型，默认 image' },
        size: { type: 'string', description: '尺寸，如 1024x1024（kind=image 时生效）' },
        title: { type: 'string', description: 'kind=cover 时的书名' },
        author: { type: 'string', description: 'kind=cover 时的作者' },
        style: { type: 'string', description: 'kind=cover 时的风格，如 高级感国风插画' },
      },
    },
    async execute(args) {
      const out = await generate({ ...args, chat: args.chat });
      return { ok: true, kind: out.kind, url: out.url, prompt: out.prompt };
    },
  });

  registerTool(ctx, {
    name: 'qq_image_status',
    description: '查看生图插件状态：接口地址是否配好、Key 是否配好、模型、尺寸、是否能发消息。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    async execute() {
      let self = null;
      try { self = await adapter.getSelfInfo(); } catch { /* 没连上也照常返回 */ }
      return {
        apiBaseUrl: baseUrl() || '(未配置)',
        apiKeyConfigured: Boolean(apiKey()),
        imageModel: setting('imageModel'),
        videoModel: setting('videoModel'),
        imageSize: setting('imageSize'),
        coverSize: setting('coverSize'),
        allowVideo: Boolean(setting('allowVideo')),
        maxMB: setting('maxMB'),
        onebotHttpUrl: setting('onebotHttpUrl'),
        wsConfigured: Boolean(setting('onebotWsUrl')),
        wsConnected: adapter.connected,
        self,
      };
    },
  });

  ctx.__qqImage = { handleMessage, generate, adapter, cfg };
  log(`生图插件就绪（接口：${baseUrl() || '未配置'}；Key：${apiKey() ? '已配置' : '未配置'}；WebSocket：${setting('onebotWsUrl') ? '已配置' : '未配置'}）`);
}

export const _internal = { parseGenCommand, coverPrompt, KINDS, DEFAULT_PROMPT_SUFFIX };
