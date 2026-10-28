export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

/**
 * DeepSeek 视觉模型调用。
 *
 * 已对官方文档核实的关键事实：
 *  - 视觉模型名为 deepseek-flash（旧名 deepseek-v4-flash-vision-exp 已退役但仍接受）
 *  - 标准 OpenAI 兼容格式，图片走 content 数组的 image_url block
 *  - detail 字段刻意不传：默认 auto 等价 original。绝不能传 low，
 *    那会把图降采样到 512×512，屏幕上的题目文字会糊掉。
 *  - thinking 模式下 temperature / presence_penalty / frequency_penalty
 *    全部无效，且不报错也不生效。所以这里一个采样参数都不传。
 *  - thinking 的思维链通过 reasoning_content 返回，与 content 同级。
 *    不带 tools 参数时无需回传，丢弃即可（官方说明）。
 */

const DEFAULT_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-flash';

export function baseUrl(): string {
  return process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE;
}

export function modelName(): string {
  return process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;
}

export function hasApiKey(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  /** 注意：图片只能出现在 user 消息里，放 system/assistant 会被上游拒 400 */
  role: 'system' | 'user' | 'assistant';
  content: string | ContentBlock[];
}

export type StreamEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'finish'; reason: string; usage?: Usage };

export interface AskOptions {
  /** 默认 false。解题这类任务开思考会吃掉大量输出 token 且明显变慢。 */
  thinking?: boolean;
  signal?: AbortSignal;
}

export async function* askStream(
  messages: ChatMessage[],
  options: AskOptions = {},
): AsyncGenerator<StreamEvent, void, undefined> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('没有配置 DEEPSEEK_API_KEY');

  const body = {
    model: modelName(),
    messages,
    stream: true,
    stream_options: { include_usage: true },
    thinking: { type: options.thinking ? 'enabled' : 'disabled' },
  };

  const res = await fetch(`${baseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`DeepSeek 返回 ${res.status}${detail ? `：${detail.slice(0, 500)}` : ''}`);
  }
  if (!res.body) throw new Error('DeepSeek 没有返回响应体');

  for await (const payload of parseSSE(res.body)) {
    if (payload === '[DONE]') return;

    // 上游响应的形状由外部决定，这里不做类型体操。
    let frame: any;
    try {
      frame = JSON.parse(payload);
    } catch {
      continue; // 畸形帧不能让整条流崩掉
    }

    const choice = frame?.choices?.[0];
    const delta = choice?.delta;

    if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
      yield { type: 'reasoning', text: delta.reasoning_content };
    }
    if (typeof delta?.content === 'string' && delta.content) {
      yield { type: 'delta', text: delta.content };
    }
    if (choice?.finish_reason) {
      yield { type: 'finish', reason: choice.finish_reason, usage: frame.usage };
    }
  }
}

/**
 * 把上游的 SSE 字节流切成一条条 data: 的内容。
 *
 * 两个必须做对的地方：
 *  1. 按 '\n' 逐行切，而不是按 '\n\n' 切事件块 —— 后者遇到畸形分帧或 CRLF 就崩。
 *  2. TextDecoder 要带 { stream: true }，因为一个 UTF-8 多字节字符（中文）
 *     完全可能被 chunk 边界从中间劈开。
 */
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let index: number;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);

        if (line === '' || line.startsWith(':')) continue; // 空行 / 心跳注释
        if (line.startsWith('data:')) yield line.slice(5).trimStart();
      }
    }
  } finally {
    reader.releaseLock();
  }
}
