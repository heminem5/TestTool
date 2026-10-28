import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { captureScreen, warmUp } from './capture.ts';
import type { Shot } from './capture.ts';
import { askStream, hasApiKey, modelName } from './deepseek.ts';
import type { ChatMessage } from './deepseek.ts';
import { PICS_DIR, createTitleStripper, extractTitle, saveShot } from './pics.ts';
import { personalityPrompt, systemPrompt } from './prompt.ts';
import { appendTurn, loadSession } from './session.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB_DIR = path.join(ROOT, 'web');

/**
 * 保底：任何漏网的异常只记日志，不让整个服务倒掉。
 *
 * 这个服务是无状态的（每次请求独立、不共享可变状态），所以即使某个请求炸了，
 * 继续跑也是安全的 —— 崩掉反而更糟：手机那头会连不上，而你还得跑到电脑前重启。
 */
function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

process.on('uncaughtException', (error) => {
  console.error(`[${stamp()}] 未捕获异常：`, error);
});

process.on('unhandledRejection', (reason) => {
  console.error(`[${stamp()}] 未处理的 Promise 拒绝：`, reason);
});

/**
 * 自己解析 .env，不用 process.loadEnvFile()：
 * VS Code 很容易把文件存成「UTF-8 with BOM」，不剥掉 BOM 的话第一个 key 名
 * 会带上 ﻿，于是永远匹配不到，而且报错信息完全不会提示这一点。
 */
function loadEnv(file: string): void {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return; // 没有 .env 就全靠真实环境变量
  }

  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1]!;
    let value = match[2]!.trim();
    if (
      value.length >= 2 &&
      ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.AUTH_TOKEN || '';

/**
 * 对外公布的手机访问地址。在 .env 里配了就固定用它，不再猜网卡顺序。
 *
 * 只影响「告诉手机哪个地址」，不改变监听范围（仍然是 0.0.0.0）。
 * 这样即使地址配错了，服务也照常跑，本机照样能打开。
 */
const LAN_IP = (process.env.LAN_IP || '').trim();

/* ── 静态文件 ──────────────────────────────────────────────── */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
};

async function serveStatic(res: ServerResponse, urlPath: string): Promise<boolean> {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath.slice(1));
  const target = path.resolve(WEB_DIR, rel);

  // 防目录穿越：解析后必须仍在 web/ 里
  if (target !== WEB_DIR && !target.startsWith(WEB_DIR + path.sep)) return false;

  try {
    const data = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

/* ── 请求体 ────────────────────────────────────────────────── */

function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authorized(req: IncomingMessage, url: URL): boolean {
  if (!TOKEN) return true; // 没配 token 就不校验

  const header = req.headers['x-token'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  return fromHeader === TOKEN || url.searchParams.get('t') === TOKEN;
}

/* ── 核心：截屏 → AI → 流式转发 ────────────────────────────── */

async function handleAsk(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req).catch(() => '');

  let payload: {
    question?: unknown;
    mode?: unknown;
    thinking?: unknown;
    quiz?: unknown;
    job?: unknown;
    session?: unknown;
  };
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('请求体不是合法 JSON');
    return;
  }

  // 注意 mode 和 quiz 是两回事：
  //   mode —— 截屏范围（full / window）
  //   quiz —— 作答模式（solve 解题 / personality 性格测评）
  const shotMode = payload.mode === 'window' ? 'window' : 'full';
  const thinking = Boolean(payload.thinking);

  const isQuiz = payload.quiz === 'personality';
  const job = typeof payload.job === 'string' ? payload.job : '';
  const sessionId = typeof payload.session === 'string' ? payload.session.trim() : '';

  const fallback = isQuiz ? '请作答屏幕上的这道题。' : '请解答屏幕上的题目，给出解题过程。';
  const question = String(payload.question ?? '').trim() || fallback;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // 手机切走/断开就别再烧 token 了
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  const send = (event: string, data: unknown): void => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // 截下来的图要在 finally 里落盘，所以得提到 try 外面。
  // 性格测评不存图（那些截图只是用来答题的），连标题解析都省掉。
  let shot: Shot | null = null;
  let answer = '';
  const stripper = isQuiz ? null : createTitleStripper();

  try {
    if (!hasApiKey()) {
      send('error', { message: '服务端还没配置 DEEPSEEK_API_KEY，请在 .env 里填好后重启' });
      return;
    }

    // 会话要在截屏之前取出来：这样「已答 N 题」随第一个 status 事件就发给手机，
    // 页面刷新后不用等答完一题才显示对。顺带这一步也会处理「岗位变了就重开」。
    const history = isQuiz && sessionId ? loadSession(sessionId, job).turns : [];
    const answeredBefore = history.filter((turn) => turn.role === 'user').length;

    send('status', { phase: 'capturing', answered: answeredBefore });
    shot = await captureScreen(shotMode);

    send('status', { phase: 'thinking', answered: answeredBefore, w: shot.w, h: shot.h, bytes: shot.bytes });

    const messages: ChatMessage[] = [
      { role: 'system', content: isQuiz ? personalityPrompt(job) : systemPrompt() },
    ];

    // 历史全是纯文本，图片只在下面这一条当轮消息里。原因见 session.ts 顶部。
    for (const turn of history) {
      messages.push({ role: turn.role, content: turn.content });
    }

    messages.push({
      role: 'user',
      content: [
        // 刻意不带 detail 字段：默认 auto 等价 original。
        // 传 low 会把图降到 512×512，题目文字直接糊掉。
        { type: 'image_url', image_url: { url: shot.dataUrl } },
        { type: 'text', text: question },
      ],
    });

    for await (const event of askStream(messages, { thinking, signal: abort.signal })) {
      if (event.type === 'delta') {
        answer += event.text;

        // 首行的「**题目**：简称」只用来给截图起名，不转给手机。
        // stripper 为 null 就是性格测评模式，原样转发。
        if (stripper) {
          const text = stripper.push(event.text);
          if (text) send('delta', { text });
        } else {
          send('delta', { text: event.text });
        }
      } else if (event.type === 'reasoning') {
        // reasoning_content 不回写历史：不带 tools 时官方说可以忽略，
        // 回传反而可能触发 400
        send('reasoning', { text: event.text });
      } else if (event.type === 'finish') {
        send('done', { usage: event.usage });
      }
    }

    // 流结束时首行还没换行的情况：残余若是标题行就吞掉，否则补发出去
    if (stripper) {
      const rest = stripper.end();
      if (rest) send('delta', { text: rest });
    }

    // 只有正常跑完才记进历史。被中止的半截回答留下来，下一题会拿它当既成事实。
    const answered =
      isQuiz && sessionId && answer.trim() ? appendTurn(sessionId, job, answer.trim()) : answeredBefore;

    send('end', { answered });
  } catch (error) {
    if (!abort.signal.aborted) {
      send('error', { message: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    if (!res.writableEnded) res.end();

    // 先结束响应再写盘：存图不该让手机多等那一两毫秒。
    //
    // 只留解题模式的截图。性格测评的截图同理要发给模型，但那是可识别的
    // 测评作答，没必要留在硬盘上 —— 所以这个分支根本不进。
    //
    // 文件名依赖 AI 的输出，所以只能在回答结束后存；被中止或报错时，
    // 只要截到了图就照样存 —— 那反而更可能是你想回看的半道题。
    if (shot && !isQuiz) {
      await saveShot(shot, stripper?.title || extractTitle(answer));
    }
  }
}

/* ── 服务 ──────────────────────────────────────────────────── */

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, hasKey: hasApiKey(), model: modelName() }));
      return;
    }

    if (!authorized(req, url)) {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('token 不对');
      return;
    }

    // 调试探针：只截屏，不调 AI。手机浏览器直接打开就能验证
    // 「手机 → 电脑 → 截屏」这一段，不需要 API key。
    if (url.pathname === '/probe') {
      const mode = url.searchParams.get('mode') === 'window' ? 'window' : 'full';
      try {
        const shot = await captureScreen(mode);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            mode: shot.mode,
            w: shot.w,
            h: shot.h,
            bytes: shot.bytes,
            printWindow: shot.printWindow,
          }),
        );
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }),
        );
      }
      return;
    }

    if (url.pathname === '/ask' && req.method === 'POST') {
      await handleAsk(req, res);
      return;
    }

    if (req.method === 'GET' && (await serveStatic(res, url.pathname))) return;

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('没有这个页面');
  })().catch((error: unknown) => {
    if (!res.writableEnded) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(error instanceof Error ? error.message : String(error));
    }
  });
});

/**
 * 自动挑一个「手机大概率连得上」的 IPv4。只在没配 LAN_IP 时才会走到这里。
 *
 * 这台机器上装了 Clash 和 VMware，它们会挂出 198.18.0.1（代理 TUN）和
 * 169.254.x（链路本地）这类手机根本连不上的地址，而 networkInterfaces()
 * 的顺序并不保证真网卡排在最前面 —— 日志里就见过它一会儿挑 153、
 * 一会儿挑 198.18.0.1。
 */
function lanAddress(): string {
  const candidates: string[] = [];

  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;

      const ip = info.address;
      if (ip.startsWith('169.254.')) continue; // 没拿到 DHCP 时自造的链路本地地址
      if (/^198\.1[89]\./.test(ip)) continue; // RFC 2544 测试段，代理的 TUN 常挂在这

      candidates.push(ip);
    }
  }

  // 私网段优先；剩下的不外乎是公网地址或别的虚拟网卡，聊胜于无
  const isPrivate = (ip: string) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return candidates.find(isPrivate) ?? candidates[0] ?? '127.0.0.1';
}

/** 当前网卡上实际存在的所有 IPv4，用来判断 .env 里配的地址还是不是有效 */
function addressesNow(): Set<string> {
  const all = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4') all.add(info.address);
    }
  }
  return all;
}

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error('');
    console.error(`  端口 ${PORT} 已被占用。多半是上一次的服务没退干净，留了个后台进程。`);
    console.error('');
    console.error('  在 PowerShell 里跑这条清理掉：');
    console.error(
      `    Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`,
    );
    console.error('');
    console.error('  或者换个端口：在 .env 里写 PORT=8788');
    console.error('');
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, '0.0.0.0', () => {
  const lan = LAN_IP || lanAddress();
  const suffix = TOKEN ? `/?t=${TOKEN}` : '/';

  console.log('');
  console.log('  TestTool 已启动');
  console.log('');
  console.log(`    手机访问   http://${lan}:${PORT}${suffix}`);
  console.log(`    本机访问   http://127.0.0.1:${PORT}${suffix}`);
  console.log(`    模型       ${modelName()}`);
  console.log(`    API Key    ${hasApiKey() ? '已配置' : '未配置（请在 .env 里填 DEEPSEEK_API_KEY）'}`);
  console.log(`    截图保存   ${PICS_DIR}`);

  // DHCP 把地址换掉时，这是唯一的提示：服务照常跑，但手机连的是一个
  // 已经不存在的 IP，表现就是「手机打不开、电脑一切正常」。
  if (LAN_IP && !addressesNow().has(LAN_IP)) {
    console.log('');
    console.log(`    ⚠ ${LAN_IP} 不在任何网卡上，手机连不上（检查 .env 的 LAN_IP）`);
  }

  console.log('');

  void warmUp();
});
