/**
 * 解题模式的截图留档。
 *
 * 只存图，不存题目文本 —— 题目本来就在图上，再存一份文本只会让这个文件夹
 * 变成另一种日志。
 *
 * 性格测评模式**不调用这里**：那类截图只是用来答题的，没必要落到磁盘上。
 * 这个约束由 server.ts 的调用点保证，本模块不做模式判断。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Shot } from './capture.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 项目根目录下的 pics/，和 web/ 并列。不在静态服务的白名单里，网页访问不到。 */
export const PICS_DIR = path.resolve(HERE, '..', 'pics');

/** 简称最多这么多个码点。再长就不是「简称」了，也容易把文件名顶出屏幕。 */
const MAX_TITLE = 20;

/** 文件名里不能出现的字符，Windows 的限制是 \ / : * ? " < > | */
const ILLEGAL = /[\\/:*?"<>|]/g;

/** 控制字符（含换行）。单独处理是因为它该变成空格，直接删掉会把前后两个词粘一起。 */
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** Windows 的保留设备名，做文件名会直接失败 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 模型答应第一行写成 `**题目**：简称`，但别指望它永远守规矩，冒号和星号都放宽 */
const TITLE_LINE = /^\s*(?:\*\*)?题目(?:\*\*)?\s*[：:]\s*(.*?)\s*$/;

/** 首行一直不结束（模型没按格式写）时，攒到这个长度就原样放行，不能无限缓冲 */
const HEAD_MAX = 80;

/** 撞名时最多试这么多次；能撞满说明系统时间有问题，不是正常用法的边界 */
const MAX_TRY = 20;

/**
 * 把模型给的简称洗成能当文件名的一段字。
 *
 * 空字符串返回「未命名」—— 调用方不需要区分「没拿到标题」和「标题是空的」。
 */
export function safeTitle(raw: string): string {
  let title = raw
    .replace(CONTROL, ' ')
    .replace(ILLEGAL, '')
    .replace(/\s+/g, ' ') // 换行、制表符、连续空格都压成一个空格
    .replace(/^[.\s]+|[.\s]+$/g, ''); // 首尾的点和空格：Windows 不允许结尾带点

  // 按码点截断，不能按 UTF-16 长度切 —— 否则 emoji 可能被从中间劈开，文件名变成乱码
  title = Array.from(title).slice(0, MAX_TITLE).join('');
  title = title.replace(/[.\s]+$/, '');

  if (!title) return '未命名';

  // 完整文件名是「简称_时间.png」，理论上撞不上保留名。留着这层是防御，
  // 万一哪天改成只用简称当文件名，这里不用再想起来。
  return RESERVED.test(title) ? `${title}_` : title;
}

function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

/** `两数之和_2026-10-27_17-50-42.png`。时间取本地时间，精确到秒。 */
export function buildName(title: string, date: Date): string {
  return `${title}_${stamp(date)}.png`;
}

/** 首行是不是标题行；是就返回简称原文（还没清洗），不是返回 null */
function matchTitle(line: string): string | null {
  const hit = TITLE_LINE.exec(line.replace(/\r$/, ''));
  if (!hit) return null;
  const title = (hit[1] ?? '').trim();
  return title || null;
}

/** 从一整段回答里取首行的简称。取不到返回空串。 */
export function extractTitle(answer: string): string {
  return matchTitle(answer.split('\n', 1)[0] ?? '') ?? '';
}

/**
 * 把回答流首行的「**题目**：简称」吃掉，其余原样放行。
 *
 * 为什么要缓：首行可能被拆成好几个 delta 到达，不攒齐就分不清是标题行还是正文。
 * 代价是第一个字到手机之前要等首行结束，通常几十到几百毫秒。
 *
 * 认不出标题行（比如 .env 覆盖了提示词）就整段原样放行 —— 宁可文件名退化成
 * 「未命名」，也不能把正文吞掉。
 */
export function createTitleStripper(): {
  readonly title: string;
  push(chunk: string): string;
  end(): string;
} {
  let buffer = '';
  let done = false;
  let title = '';

  return {
    get title() {
      return title;
    },

    push(chunk: string): string {
      if (done) return chunk;

      buffer += chunk;

      const nl = buffer.indexOf('\n');
      if (nl !== -1) {
        const first = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        done = true;

        const hit = matchTitle(first);
        if (hit === null) return `${first}\n${buffer}`;

        title = hit;
        return buffer;
      }

      // 一行攒到 80 字还没换行，基本不可能是标题行了
      if (buffer.length >= HEAD_MAX) {
        done = true;
        const rest = buffer;
        buffer = '';
        return rest;
      }

      return '';
    },

    /** 流结束时把残余吐出来。是标题行就吞掉，否则原样返回。 */
    end(): string {
      if (done) return '';
      done = true;
      const rest = buffer;
      buffer = '';

      const hit = matchTitle(rest);
      if (hit === null) return rest;

      title = hit;
      return '';
    },
  };
}

/**
 * 上次保存过的截图。captureScreen() 有单飞锁，两个同时到达的 /ask 会拿到
 * 同一个 Shot 对象 —— 不记住的话，连点两次会写出两张一模一样的图。
 *
 * 只留一张的量级（几百 KB），不至于因此多占内存。
 */
let lastShot: Shot | null = null;
let lastName = '';

/**
 * 把截图写进 pics/，返回文件名；失败返回 null（绝不上抛）。
 *
 * 用 flag 'wx' 而不是先检查再写：检查和使用之间有窗口，两个进程/两个请求
 * 可能同时通过检查。'wx' 是原子的，撞上就换下一个后缀。
 */
export async function saveShot(shot: Shot, rawTitle: string): Promise<string | null> {
  if (lastShot === shot) return lastName || null;

  const name = buildName(safeTitle(rawTitle), new Date());

  try {
    await mkdir(PICS_DIR, { recursive: true });

    for (let i = 1; i <= MAX_TRY; i++) {
      const file = i === 1 ? name : name.replace(/\.png$/, `-${i}.png`);
      try {
        await writeFile(path.join(PICS_DIR, file), shot.buffer, { flag: 'wx' });
        lastShot = shot;
        lastName = file;
        console.log(`  截图已保存   pics/${file}`);
        return file;
      } catch (error) {
        // 撞名就换下一个后缀；权限、磁盘满之类的直接抛到外面统一处理
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }

    throw new Error(`同名文件已有 ${MAX_TRY} 个`);
  } catch (error) {
    // 存图是附加功能，不能因为它把答题废掉 —— 这行日志是唯一的痕迹
    console.error(`[pics] 保存截图失败：${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
