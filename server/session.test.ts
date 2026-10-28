/**
 * 会话逻辑的回归测试，跑 `npm test`。
 *
 * 这段状态机值得单独测：它一旦出错就是静悄悄地把你已经答完的题全部清空，
 * 而你在手机上只会看到「已答 1 题」突然跳回去，根本联想不到是这里的问题。
 */
import { appendTurn, loadSession } from './session.ts';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}  →  ${String(actual)}${ok ? '' : `（期望 ${String(expected)}）`}`);
}

const id = 'test-session';

// 1. 新会话是空的
check('新会话题数', loadSession(id, '后端开发').turns.length, 0);

// 2. 累积
check('第 1 题返回的题数', appendTurn(id, '后端开发', '答案：B'), 1);
check('第 2 题返回的题数', appendTurn(id, '后端开发', '答案：A'), 2);
check('turns 长度（每题两条）', loadSession(id, '后端开发').turns.length, 4);

// 3. 空白差异不该被当成换岗位
check('岗位换行/多余空格不重开', loadSession(id, '  后端开发\n').turns.length, 4);

// 4. 换岗位 → 整场重开
check('换岗位后题数归零', loadSession(id, '销售代表').turns.length, 0);
check('换岗位后追加是第 1 题', appendTurn(id, '销售代表', '答案：C'), 1);

// 5. 不同 id 互不干扰
check('另一个 id 是独立的', loadSession('other-session', '后端开发').turns.length, 0);

// 6. 历史里存的确实是纯文本，没有图片块
const first = loadSession('other-session', '后端开发');
appendTurn('other-session', '后端开发', '答案：D');
check(
  '历史全是字符串',
  loadSession('other-session', '后端开发').turns.every((t) => typeof t.content === 'string'),
  true,
);
check('首条是题目桩', first.turns[0]?.content, '第 1 题');

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
