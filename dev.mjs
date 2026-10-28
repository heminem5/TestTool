/**
 * 一条 `npm run dev` 同时起两件事：
 *   1. esbuild 监听 web/app.tsx，改动就重新打包
 *   2. node --watch 跑服务端，改动就重启
 *
 * 不引入 concurrently 之类的包 —— 就两个子任务，用 esbuild 的 JS API
 * 还能省掉 Windows 上 spawn .cmd 的 shell 转义麻烦。
 */
import { spawn, execFileSync } from 'node:child_process';
import process from 'node:process';
import * as esbuild from 'esbuild';

/**
 * Windows 上必须杀整棵进程树。
 * 父进程被强杀时 `node --watch` 的子进程不会跟着退出，会变成孤儿继续占着端口，
 * 下次启动就报 EADDRINUSE —— 而且那个进程你从任务管理器里很难认出来是谁。
 */
function killTree(pid) {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // 已经退出了，正常
    }
  } else {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // 已经退出了，正常
    }
  }
}

const options = {
  entryPoints: ['web/app.tsx'],
  bundle: true,
  format: 'esm',
  outfile: 'web/app.js',
  jsx: 'automatic', // React 17+ 的新 JSX 转换，不需要 import React
  target: ['es2022'],
  sourcemap: true,
  /**
   * 不告诉 esbuild「这是生产环境」的话，React 会打包 development 版本 ——
   * 1.1MB，而且带一整套运行时检查。打包结果里能直接搜到 react.development。
   * 换成 production 之后降到 180KB 左右。
   * 注意这个值必须是带引号的字符串字面量，esbuild 的 define 是文本替换。
   */
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
};

// 只想构建一次（npm run build:web），不起 watch，也不起服务端
if (process.argv.includes('--build')) {
  await esbuild.build({ ...options, logLevel: 'info' });
  process.exit(0);
}

const ctx = await esbuild.context({ ...options, logLevel: 'warning' });

await ctx.watch();
console.log('[web]  监听 web/app.tsx');

const server = spawn(process.execPath, ['--watch', 'server/server.ts'], {
  stdio: 'inherit',
});

let closing = false;

function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  killTree(server.pid);
  void ctx.dispose().then(() => process.exit(code));
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));

server.on('close', (code) => shutdown(code ?? 0));
