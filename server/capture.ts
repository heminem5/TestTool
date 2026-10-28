import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 截屏范围：整个虚拟桌面，还是仅前台窗口 */
export type ShotMode = 'full' | 'window';

/** 裁剪区域，坐标基于截图本身（像素）。留给后面提升小字清晰度用。 */
export interface Crop {
  x: number;
  y: number;
  w: number;
  h: number;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'capture.ps1');

export interface Shot {
  buffer: Buffer;
  /** data:image/png;base64,... —— 直接可喂给模型，也可给网页当缩略图 */
  dataUrl: string;
  mode: ShotMode;
  w: number;
  h: number;
  printWindow: boolean;
  bytes: number;
}

interface PSResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** 截屏脚本抛出的错误码 → 给人看的话 */
const FRIENDLY: Record<string, string> = {
  WINDOW_MINIMIZED_OR_INVALID: '目标窗口已最小化或不可见，请先在电脑上点开它',
  NO_FOREGROUND_WINDOW: '没有找到前台窗口，请先在电脑上点一下目标窗口',
  GET_WINDOW_RECT_FAILED: '读不到窗口尺寸',
  BAD_CROP_FORMAT: '裁剪参数格式不对',
  BAD_CROP_RANGE: '裁剪区域超出了图片范围',
  OUT_PATH_REQUIRED: '缺少输出路径',
};

function friendlyError(raw: string): string {
  for (const [code, message] of Object.entries(FRIENDLY)) {
    if (raw.includes(code)) return message;
  }
  const last = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .pop();
  return last ? `截屏失败：${last}` : '截屏失败';
}

function runPS(mode: string, crop: string, out: string): Promise<PSResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT,
      '-Mode', mode,
      '-OutPath', out,
    ];
    if (crop) args.push('-Crop', crop);

    // windowsHide: 不弹控制台窗口。截屏期间不抢前台焦点，否则 window 模式
    // 会截到我们自己的 PowerShell 窗口。
    const child = spawn('pwsh', args, { windowsHide: true });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function doCapture(mode: ShotMode, crop?: Crop): Promise<Shot> {
  // 每次独立临时目录，并发/连点不会互相覆盖文件。
  const dir = await mkdtemp(path.join(tmpdir(), 'testtool-shot-'));
  const out = path.join(dir, 'shot.png');

  try {
    const cropArg = crop ? `${crop.x},${crop.y},${crop.w},${crop.h}` : '';
    const { code, stdout, stderr } = await runPS(mode, cropArg, out);

    if (code !== 0) throw new Error(friendlyError(stderr || stdout));

    const metaLine = stdout.split(/\r?\n/).find((line) => line.startsWith('META:'));
    if (!metaLine) {
      throw new Error(`截屏脚本没有返回结果：${(stderr || stdout).slice(0, 300)}`);
    }

    const meta = JSON.parse(metaLine.slice(5)) as {
      w: number;
      h: number;
      printWindow?: boolean;
    };

    const buffer = await readFile(out);

    return {
      buffer,
      dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
      mode,
      w: meta.w,
      h: meta.h,
      printWindow: Boolean(meta.printWindow),
      bytes: buffer.length,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

let inflight: Promise<Shot> | null = null;

/**
 * 截屏。带单飞锁：手机连点两次时第二次复用同一个 Promise，而不是再起一个
 * PowerShell 进程。截屏是全局共享资源（一次只能截一个屏幕）。
 */
export function captureScreen(mode: ShotMode = 'full', crop?: Crop): Promise<Shot> {
  if (inflight) return inflight;
  inflight = doCapture(mode, crop).finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * 预热：把 Add-Type 的 C# 运行时编译开销（首次 1~2 秒）提前付掉。
 * 用 -WarmUp 只加载程序集，不接触屏幕。
 */
export async function warmUp(): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      const child = spawn(
        'pwsh',
        [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', SCRIPT, '-WarmUp',
        ],
        { windowsHide: true, stdio: 'ignore' },
      );
      child.on('error', () => resolve());
      child.on('close', () => resolve());
    });
  } catch {
    // 预热失败不影响启动，真正截屏时会再报错。
  }
}
