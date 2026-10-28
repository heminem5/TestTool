/**
 * 性格测评模式的作答历史。
 *
 * 只存文本，不存图片 —— 这是刻意的。
 *
 * OpenAI 兼容接口是无状态的：「带上下文」= 每次请求把整个 messages 数组完整重发
 * 一遍。所以历史里只要留着一张图，那串 base64 每一轮都会重新上传。300KB 的 PNG
 * 转 base64 约 400KB，第 50 题时光图就有 20MB（DeepSeek 请求体上限 48MiB），
 * 而家用宽带上行要为此多等好几秒。只留文本的话，第 50 题也不到 2MB。
 *
 * 一致性不靠旧截图，靠模型自己写在「倾向：」那一行里的性格标签 —— 见 prompt.ts。
 */

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

export interface Session {
  /** 归一化后的岗位文本。变了就说明换了目标岗位，整场重来 */
  job: string;
  turns: Turn[];
  updatedAt: number;
}

const TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 100;

const sessions = new Map<string, Session>();

/** 连续空白压成一个空格：用户粘贴整段 JD 时，换行和缩进会很乱 */
function normalizeJob(job: string): string {
  return job.replace(/\s+/g, ' ').trim();
}

/**
 * 惰性清理，不挂 setInterval。
 *
 * 定时器会拖住进程退出，得记得 unref；而且没人用的时候清它也没意义。
 * 会话上限 100，每次请求扫一遍是最多 100 次比较，可以忽略。
 */
function sweep(now: number): void {
  for (const [id, session] of sessions) {
    if (now - session.updatedAt > TTL_MS) sessions.delete(id);
  }
}

/**
 * 取会话。不存在、或者岗位变了，就开一场新的。
 *
 * 「岗位变了自动重来」是有意为之：换岗位等于换一套人格画像，沿用旧作答只会
 * 让答卷自相矛盾。用户改完 JD 之后不必记得去点「重新开始」。
 */
export function loadSession(id: string, job: string): Session {
  const now = Date.now();
  sweep(now);

  const wanted = normalizeJob(job);
  const existing = sessions.get(id);

  if (existing && existing.job === wanted) {
    existing.updatedAt = now;
    return existing;
  }

  // 超出上限就淘汰最旧的一个，防止有人拿随机 id 把内存刷爆
  if (sessions.size >= MAX_SESSIONS) {
    let oldestId: string | null = null;
    let oldestAt = Infinity;
    for (const [key, session] of sessions) {
      if (session.updatedAt < oldestAt) {
        oldestAt = session.updatedAt;
        oldestId = key;
      }
    }
    if (oldestId !== null) sessions.delete(oldestId);
  }

  const fresh: Session = { job: wanted, turns: [], updatedAt: now };
  sessions.set(id, fresh);
  return fresh;
}

/**
 * 把一轮问答追加进历史，返回这场测评的累计题数。
 *
 * 只在流完整跑完时调用。中途 abort 的半截回答留在历史里，下一题会拿它当既成
 * 事实，反而制造出矛盾 —— 宁可这一轮不作数。
 */
export function appendTurn(id: string, job: string, answer: string): number {
  const session = loadSession(id, job);
  const answered = session.turns.filter((turn) => turn.role === 'user').length + 1;

  // 用户那一侧只留「第 N 题」这个桩：题干截图已经丢了，而每次请求都重发一遍
  // 「请作答屏幕上的这道题」纯属噪音。模型需要的是它自己的回答（含倾向），
  // 那才是它下一轮保持一致性的依据。
  session.turns.push({ role: 'user', content: `第 ${answered} 题` });
  session.turns.push({ role: 'assistant', content: answer });
  session.updatedAt = Date.now();

  return answered;
}
