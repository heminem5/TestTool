/**
 * 截图留档的纯函数测试，跑 `npm test`。
 *
 * 这里不碰磁盘：saveShot 会往真实的 pics/ 里写图，测试不该有副作用。
 * 需要验证的是「名字拼得对不对」和「标题行有没有被误吞」—— 这两处出错
 * 都是静默的，文件照样写出来，只是名字不对或者正文少了一截。
 */
import { buildName, createTitleStripper, extractTitle, safeTitle } from './pics.ts';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}  →  ${String(actual)}${ok ? '' : `（期望 ${String(expected)}）`}`);
}

// ── buildName ──────────────────────────────────────────────
// 用 new Date(年, 月, ...) 而不是 ISO 字符串：拼名字用的是本地时间，
// 传 UTC 字符串的话在不同时区跑出来的结果不一样。
const d = new Date(2026, 9, 27, 17, 50, 42);

check('文件名：中文简称', buildName('两数之和', d), '两数之和_2026-10-27_17-50-42.png');
check('文件名：一位数补零', buildName('x', new Date(2026, 0, 5, 9, 3, 7)), 'x_2026-01-05_09-03-07.png');
check('文件名：午夜', buildName('x', new Date(2026, 11, 31, 0, 0, 0)), 'x_2026-12-31_00-00-00.png');

// ── safeTitle ──────────────────────────────────────────────
check('清洗：非法字符', safeTitle('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghij');
check('清洗：控制字符', safeTitle('a\nb\tc'), 'a b c');
check('清洗：压缩空白', safeTitle('  两数   之和  '), '两数 之和');
check('清洗：去掉首尾的点', safeTitle('...解题...'), '解题');
check('清洗：空串回退', safeTitle('   '), '未命名');
check('清洗：全非法字符回退', safeTitle('///'), '未命名');
check('清洗：20 字截断', safeTitle('一二三四五六七八九十一二三四五六七八九十一'), '一二三四五六七八九十一二三四五六七八九十');
check('清洗：保留名加下划线', safeTitle('CON'), 'CON_');
check('清洗：保留名不分大小写', safeTitle('com1'), 'com1_');
check('清洗：非保留名不动', safeTitle('CONSOLE'), 'CONSOLE');
// 截断后可能剩下结尾空格，Windows 不允许文件名以空格结尾
check('清洗：截断后去尾空格', safeTitle('一二三四五六七八九十一二三四五六七八九 十'), '一二三四五六七八九十一二三四五六七八九');
// 按码点而不是 UTF-16 长度切，否则 emoji 会被劈成两个乱码字符
check('清洗：emoji 不劈开', Array.from(safeTitle('😀'.repeat(25))).length, 20);

// ── extractTitle ───────────────────────────────────────────
check('取标题：标准格式', extractTitle('**题目**：两数之和\n\n给定一个数组……'), '两数之和');
check('取标题：不带星号', extractTitle('题目：TCP 三次握手\n……'), 'TCP 三次握手');
check('取标题：半角冒号', extractTitle('**题目**: 二分查找\n……'), '二分查找');
check('取标题：CRLF', extractTitle('**题目**：二分查找\r\n……'), '二分查找');
check('取标题：正文里出现不算', extractTitle('答案是 B\n**题目**：两数之和'), '');
check('取标题：没有标题行', extractTitle('答案：B'), '');
check('取标题：空标题', extractTitle('**题目**：\n正文'), '');

// ── createTitleStripper ───────────────────────────────────

// 1. 逐个字符喂，模拟 delta 把一个字劈开
{
  const s = createTitleStripper();
  let out = '';
  for (const ch of '**题目**：两数之和\n\n给定一个数组，求和。') out += s.push(ch);
  out += s.end();
  check('剥行：逐字喂，标题被取走', s.title, '两数之和');
  check('剥行：逐字喂，正文完整', out, '\n给定一个数组，求和。');
}

// 2. 标题行和正文在同一块里到达
{
  const s = createTitleStripper();
  const out = s.push('**题目**：快排\n正文') + s.end();
  check('剥行：同一块到达', out, '正文');
}

// 3. 不像标题行 → 一个字都不能吞
{
  const s = createTitleStripper();
  const out = s.push('答案：B\n因为……') + s.end();
  check('剥行：非标题行原样放行', out, '答案：B\n因为……');
  check('剥行：非标题行不产生简称', s.title, '');
}

// 4. 流结束时首行还没换行：是标题行就吞掉
{
  const s = createTitleStripper();
  const out = s.push('**题目**：二分查找') + s.end();
  check('剥行：结束时的残余标题被吞', out, '');
  check('剥行：结束时仍能取到简称', s.title, '二分查找');
}

// 5. 流结束时首行还没换行，但不是标题行
{
  const s = createTitleStripper();
  const out = s.push('答案：C') + s.end();
  check('剥行：结束时的正文残余放行', out, '答案：C');
}

// 6. 一直不换行的长正文：80 字后放行，不能卡住整条流
{
  const s = createTitleStripper();
  const long = '这是一段没有换行的正文'.repeat(10);
  const first = s.push(long);
  check('剥行：长行到上限就放行', first, long);
  check('剥行：放行后不再吞字', s.push('后续'), '后续');
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
