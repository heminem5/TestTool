import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import { marked } from 'marked';

import hljsBash from 'highlight.js/lib/languages/bash';
import hljsCpp from 'highlight.js/lib/languages/cpp';
import hljsCss from 'highlight.js/lib/languages/css';
import hljsGo from 'highlight.js/lib/languages/go';
import hljsJava from 'highlight.js/lib/languages/java';
import hljsJavascript from 'highlight.js/lib/languages/javascript';
import hljsJson from 'highlight.js/lib/languages/json';
import hljsPython from 'highlight.js/lib/languages/python';
import hljsSql from 'highlight.js/lib/languages/sql';
import hljsTypescript from 'highlight.js/lib/languages/typescript';
import hljsXml from 'highlight.js/lib/languages/xml';

type Phase = 'idle' | 'capturing' | 'thinking' | 'streaming' | 'done' | 'error';
type QuizMode = 'solve' | 'personality';

/** 答案字号的三档边界，用整数百分比而不是浮点倍数，省得 0.1 累加出 0.30000000000000004 */
const FONT_MIN = 80;
const FONT_MAX = 180;

/** 小 / 中 / 大。80 和 180 是原来 A−/A+ 的边界，100 是原来的默认值 */
const FONT_LEVELS = [
  { label: '小', pct: FONT_MIN },
  { label: '中', pct: 100 },
  { label: '大', pct: FONT_MAX },
] as const;

/**
 * 把存下来的字号吸附到三档之一。
 *
 * 老版本是 A−/A+ 按 10% 步进，用户可能存着 90、110、150 这类中间值。
 * 不吸附的话三个按钮会一个都不高亮，而他明明调过字号。
 */
function snapFont(pct: number): number {
  let best: number = FONT_LEVELS[1].pct;
  for (const { pct: level } of FONT_LEVELS) {
    if (Math.abs(level - pct) < Math.abs(best - pct)) best = level;
  }
  return best;
}

const PHASE_LABEL: Record<Phase, string> = {
  idle: '',
  capturing: '正在截屏…',
  thinking: 'AI 正在解题…',
  streaming: '正在输出…',
  done: '完成',
  error: '',
};

/* ── Markdown 渲染 ─────────────────────────────────────────── */

// 只注册用得到的语言。highlight.js 全量包有 1MB 多，按需引入后只有几十 KB。
for (const [name, def] of Object.entries({
  javascript: hljsJavascript,
  typescript: hljsTypescript,
  python: hljsPython,
  java: hljsJava,
  cpp: hljsCpp,
  go: hljsGo,
  sql: hljsSql,
  json: hljsJson,
  bash: hljsBash,
  xml: hljsXml,
  css: hljsCss,
})) {
  hljs.registerLanguage(name, def);
}

// 模型爱写 ```js / ```py / ```sh 这类简写，映射到注册过的语言名上
const LANG_ALIAS: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  py3: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  html: 'xml',
  vue: 'xml',
  svg: 'xml',
  c: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  golang: 'go',
  postgres: 'sql',
  postgresql: 'sql',
  mysql: 'sql',
};

function resolveLang(raw: string | undefined): string | null {
  if (!raw) return null;
  const name = LANG_ALIAS[raw.toLowerCase()] ?? raw.toLowerCase();
  return hljs.getLanguage(name) ? name : null;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (ch) => (ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : '&gt;'));
}

marked.use({
  gfm: true,
  // AI 输出常靠单个换行断句，标准 Markdown 会把它们并成一行
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const name = resolveLang(lang);
      // hljs.highlight 的输出已经是转义过的 HTML；没命中语言时得自己转义
      const body = name ? hljs.highlight(text, { language: name }).value : escapeHtml(text);
      const cls = name ? `hljs language-${name}` : 'hljs';
      return `<pre class="code"><code class="${cls}">${body}</code></pre>`;
    },
  },
});

/**
 * 渲染 Markdown 并消毒。
 *
 * DOMPurify 这步不能省：走 innerHTML 就意味着 AI 的输出会被当作 HTML 解析，
 * 而它可能被截图里的内容诱导着吐出 <img onerror=...> 这类东西。
 */
function renderMarkdown(text: string): string {
  if (!text) return '';
  const html = marked.parse(text) as string;
  return DOMPurify.sanitize(html);
}

/* ── 工具 ──────────────────────────────────────────────────── */

/** 令牌从 ?t= 进来一次，之后靠 localStorage。顺手从地址栏抹掉，免得留在历史记录里。 */
function readToken(): string {
  const fromUrl = new URLSearchParams(location.search).get('t');
  if (fromUrl) {
    localStorage.setItem('testtool.token', fromUrl);
    history.replaceState(null, '', location.pathname);
    return fromUrl;
  }
  return localStorage.getItem('testtool.token') ?? '';
}

/* ── 本地存储 ──────────────────────────────────────────────── */

// 无痕模式下 localStorage 的读写都可能直接抛，偏好丢了是小事，崩掉不是
function readStored(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 存不下就算了 */
  }
}

/**
 * 测评会话 id。
 *
 * 不能用 crypto.randomUUID —— 它只在安全上下文（https / localhost）里有，
 * 而手机走的是局域网 http://192.168.x.x，那里它是 undefined。
 * 这个 id 只是用来在服务端的内存 Map 里认领一份历史，不是安全凭证，
 * 所以退回 Math.random 完全够用。
 */
function newSessionId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      /* 落到下面 */
    }
  }
  return `s${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ── 默认岗位画像 ──────────────────────────────────────────── */

/**
 * 性格测评的默认岗位描述，第一次打开时自动填进去。
 *
 * 写成一份「普通且稳定」的画像，而不是「优秀候选人」：测评方会做社会赞许性检测，
 * 一份全是亮点的画像会把每道题都往最漂亮的那一档推，整份答卷反而显得不真实。
 * 这里保留「领导力中等」「偏独处」这类不那么耀眼的措辞，作答才有起伏。
 *
 * 它只是初始值 —— 存进 localStorage 之后就以你改过的为准，不会被覆盖回默认。
 */
const DEFAULT_JOB =
  '普通且细致的一线开发工程师：性格稳定，严谨负责，遵守规范，注重质量与闭环；' +
  '能独立专注，也能必要协作。领导力中等，偏守规矩但接受务实创新；偏独处，也能正常沟通。' +
  '抗压中上，目标清晰，理性沟通，遇风险及时同步，稳定可靠地完成开发交付。';

/* ── 组件 ──────────────────────────────────────────────────── */

function App() {
  const [phase, setPhase] = useState<Phase>('idle');
  const [answer, setAnswer] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [error, setError] = useState('');
  const [quiz, setQuiz] = useState<QuizMode>(() =>
    readStored('testtool.quiz') === 'personality' ? 'personality' : 'solve',
  );
  // 存的为空就用默认画像，填过东西则以存的为准。
  //
  // 判空而不是判「键不存在」：旧版本挂载时就会把 '' 写进 localStorage，
  // 所以老用户那儿这个键是存在的、值是空串。全删光再刷新会重新长出默认值 ——
  // 「默认值」本来就该是这个行为，想彻底不要就随便填个字。
  const [job, setJob] = useState(() => readStored('testtool.job') || DEFAULT_JOB);
  const [sessionId, setSessionId] = useState(() => readStored('testtool.session') || newSessionId());
  const [answered, setAnswered] = useState(0);
  const [jobOpen, setJobOpen] = useState(() => !readStored('testtool.job'));
  const [deepThink, setDeepThink] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [fontPct, setFontPct] = useState(() => {
    // 旧版本存过任意 10% 档位，先吸附到三档；没存过、存的不是数字、越界都落到「中」
    const saved = Number(readStored('testtool.fontPct'));
    return Number.isFinite(saved) && saved >= FONT_MIN && saved <= FONT_MAX ? snapFont(saved) : 100;
  });

  const abortRef = useRef<AbortController | null>(null);
  const tokenRef = useRef('');
  const stageRef = useRef<HTMLElement>(null);
  const deltaBufRef = useRef('');
  const reasonBufRef = useRef('');
  const timerRef = useRef<number | null>(null);

  const busy = phase === 'capturing' || phase === 'thinking' || phase === 'streaming';

  useEffect(() => {
    tokenRef.current = readToken();
  }, []);

  // 字号偏好存在本地，下次打开还是你选过的那一档
  useEffect(() => {
    // 挂在 :root 上，答案区、代码块、思考过程统一跟着缩放
    document.documentElement.style.setProperty('--answer-scale', String(fontPct / 100));
    writeStored('testtool.fontPct', String(fontPct));
  }, [fontPct]);

  useEffect(() => writeStored('testtool.quiz', quiz), [quiz]);
  useEffect(() => writeStored('testtool.job', job), [job]);
  useEffect(() => writeStored('testtool.session', sessionId), [sessionId]);

  const rendered = useMemo(() => renderMarkdown(answer), [answer]);

  // 计时器：让人知道到底等了多久，而不是干瞪着转圈
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setSeconds(0);
    const tick = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(tick);
  }, [busy]);

  /**
   * 流式增量先攒进 ref，按固定间隔批量刷进 state。
   *
   * 用 80ms 而不是 requestAnimationFrame：Markdown 渲染要走「解析 → 消毒 →
   * 重建 innerHTML」三步，比纯文本重得多，按帧（16ms）刷会明显卡顿。
   * 80ms 约合 12fps，文字逐字出现的观感依然连贯。
   */
  const flush = useCallback(() => {
    timerRef.current = null;
    if (deltaBufRef.current) {
      const chunk = deltaBufRef.current;
      deltaBufRef.current = '';
      setAnswer((prev) => prev + chunk);
    }
    if (reasonBufRef.current) {
      const chunk = reasonBufRef.current;
      reasonBufRef.current = '';
      setReasoning((prev) => prev + chunk);
    }
  }, []);

  const schedule = useCallback(() => {
    if (timerRef.current !== null) return;
    timerRef.current = window.setTimeout(flush, 80);
  }, [flush]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  // 新内容进来就滚到底
  useEffect(() => {
    const stage = stageRef.current;
    if (stage) stage.scrollTop = stage.scrollHeight;
  }, [rendered, reasoning]);

  const run = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    deltaBufRef.current = '';
    reasonBufRef.current = '';
    setAnswer('');
    setReasoning('');
    setError('');
    setPhase('capturing');

    try {
      const res = await fetch('/ask', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Token': tokenRef.current,
        },
        body: JSON.stringify({
          thinking: deepThink,
          quiz, // 作答模式
          job: quiz === 'personality' ? job : '',
          session: quiz === 'personality' ? sessionId : '',
        }),
        signal: ac.signal,
      });

      if (!res.ok) throw new Error((await res.text()) || `服务端返回 ${res.status}`);
      if (!res.body) throw new Error('服务端没有返回响应体');

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let event = 'message';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;

        // stream: true 是必须的 —— 一个中文字符可能被 chunk 边界从中间劈开
        buffer += decoder.decode(value, { stream: true });

        let index: number;
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index).replace(/\r$/, '');
          buffer = buffer.slice(index + 1);

          if (line === '') {
            event = 'message';
            continue;
          }
          if (line.startsWith(':')) continue; // 心跳注释

          if (line.startsWith('event:')) {
            event = line.slice(6).trim();
            continue;
          }
          if (!line.startsWith('data:')) continue;

          let data: { phase?: string; text?: string; message?: string; answered?: number };
          try {
            data = JSON.parse(line.slice(5).trim());
          } catch {
            continue; // 畸形帧不能让整条流崩掉
          }

          if (event === 'status') {
            setPhase(data.phase === 'capturing' ? 'capturing' : 'thinking');
            // 题数以服务端为准：它才清楚会话是不是因为换岗位被清空了
            if (typeof data.answered === 'number') setAnswered(data.answered);
          } else if (event === 'delta') {
            setPhase('streaming');
            deltaBufRef.current += data.text ?? '';
            schedule();
          } else if (event === 'reasoning') {
            reasonBufRef.current += data.text ?? '';
            schedule();
          } else if (event === 'error') {
            setError(data.message ?? '未知错误');
            setPhase('error');
          } else if (event === 'end') {
            flush();
            if (typeof data.answered === 'number') setAnswered(data.answered);
            setPhase((prev) => (prev === 'error' ? prev : 'done'));
          }
        }
      }

      flush();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setError((err as Error).message);
      setPhase('error');
    }
  }, [deepThink, quiz, job, sessionId, schedule, flush]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    flush();
    setPhase('idle');
  }, [flush]);

  /** 清空上一份答案。两种模式（和换岗位后）的答案读法完全不同，留着只会误导 */
  const clearStage = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    deltaBufRef.current = '';
    reasonBufRef.current = '';
    setAnswer('');
    setReasoning('');
    setError('');
    setPhase('idle');
  }, []);

  const switchQuiz = useCallback(
    (next: QuizMode) => {
      setQuiz(next);
      // 刻意不动 answered：切到解题再切回来，那场测评在服务端还活着，题数也还算数
      clearStage();
    },
    [clearStage],
  );

  const restart = useCallback(() => {
    setSessionId(newSessionId());
    setAnswered(0);
    clearStage();
  }, [clearStage]);

  return (
    <div className="app">
      <header className="bar">
        <div className="segmented" role="group" aria-label="作答模式">
          <button
            type="button"
            className={quiz === 'solve' ? 'on' : ''}
            disabled={busy}
            onClick={() => switchQuiz('solve')}
          >
            解题
          </button>
          <button
            type="button"
            className={quiz === 'personality' ? 'on' : ''}
            disabled={busy}
            onClick={() => switchQuiz('personality')}
          >
            性格测评
          </button>
        </div>

        <div className="bar-right">
          <div className="segmented font" role="group" aria-label="答案字号">
            {FONT_LEVELS.map(({ label, pct }) => (
              <button
                key={pct}
                type="button"
                className={fontPct === pct ? 'on' : ''}
                onClick={() => setFontPct(pct)}
              >
                {label}
              </button>
            ))}
          </div>

          <label className="switch">
            <input
              type="checkbox"
              checked={deepThink}
              disabled={busy}
              onChange={(e) => setDeepThink(e.target.checked)}
            />
            <span>深度思考</span>
          </label>
        </div>
      </header>

      <main className="stage" ref={stageRef}>
        {busy && (
          <div className="status">
            <span className="spinner" />
            <span>{PHASE_LABEL[phase]}</span>
            {seconds > 2 && <em>{seconds}s</em>}
          </div>
        )}

        {error && <div className="error">{error}</div>}

        {reasoning && (
          <details className="reasoning">
            <summary>思考过程（{reasoning.length} 字）</summary>
            <pre>{reasoning}</pre>
          </details>
        )}

        {rendered ? (
          <div className="answer" dangerouslySetInnerHTML={{ __html: rendered }} />
        ) : (
          !busy &&
          !error && (
            <p className="hint">
              {quiz === 'personality'
                ? '点下面的按钮，电脑会截下屏幕上的题目，AI 会参考之前的作答选出一致的答案。'
                : '点下面的按钮，电脑会截下屏幕交给 AI 解答。'}
            </p>
          )
        )}
      </main>

      {quiz === 'personality' && (
        <details
          className="job"
          open={jobOpen}
          onToggle={(e) => setJobOpen(e.currentTarget.open)}
        >
          <summary>
            目标岗位
            {job.trim()
              ? `：${job.trim().replace(/\s+/g, ' ').slice(0, 22)}${job.trim().length > 22 ? '…' : ''}`
              : '（还没填，点开填写）'}
          </summary>

          <textarea
            rows={3}
            value={job}
            disabled={busy}
            onChange={(e) => setJob(e.target.value)}
            placeholder="比如：后端开发工程师，公司价值观「客户第一、坦诚清晰」。也可以直接粘贴整段招聘要求和公司价值观 —— 「抗压」「跨部门沟通」这类措辞越具体，作答越贴。"
          />

          <p className="jobnote">
            默认是一份通用的一线开发画像，可以整段换成目标岗位的招聘要求和公司价值观。
            改完岗位之后，下一题会自动重开一场，之前的作答就不作数了。
          </p>
        </details>
      )}

      {quiz === 'personality' && (
        <div className="quizbar">
          <span>
            已答 <b>{answered}</b> 题
          </span>
          <button type="button" onClick={restart} disabled={busy}>
            重新开始
          </button>
        </div>
      )}

      <footer className="actions">
        <button type="button" className="primary" onClick={run} disabled={busy}>
          {quiz === 'personality' ? (answered > 0 ? '下一题' : '截屏答题') : '截屏提问'}
        </button>
        {busy && (
          <button type="button" className="ghost" onClick={stop}>
            停止
          </button>
        )}
      </footer>
    </div>
  );
}

const container = document.getElementById('root');
if (container) createRoot(container).render(<App />);
