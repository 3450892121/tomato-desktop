// 导航手动排序·纯逻辑单测（npm test 连跑；也可单独 `node tests/navorder.test.mjs`）
// 被测对象：src/shell/navsort.js 的 computeNavPlan（净化与渲染顺序）与 pickStartupTool（启动默认工具）。
// 重点盯「用户手改 settings.json 也不能弄丢工具 / 走私跨组 / 弄崩渲染」。

import { computeNavPlan, pickStartupTool } from '../src/shell/navsort.js';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push({ name, message: detail === undefined ? '断言为假' : String(detail) });
}

/** 与 registry 同构的迷你注册表（覆盖：正常分组、order 乱序、未知 group、缺 group） */
const GROUPS = [
  { id: 'image', name: '图片', icon: '🖼️' },
  { id: 'video', name: '视频', icon: '🎬' },
  { id: 'audio', name: '音频', icon: '🎵' }
];
const TOOLS = [
  { id: 'img-b', group: 'image', order: 20 },
  { id: 'img-a', group: 'image', order: 10 },
  { id: 'img-c', group: 'image', order: 30 },
  { id: 'vid-a', group: 'video', order: 10 },
  { id: 'vid-b', group: 'video', order: 20 },
  { id: 'aud-a', group: 'audio', order: 10 },
  { id: 'odd', group: 'weird', order: 5 }, // 声明了未知 group → 归「其它」
  { id: 'none', order: 5 }                 // 没声明 group → 归「其它」
];
const ids = (plan, gid) => plan.find((g) => g.id === gid).tools.map((t) => t.id);
const groupIds = (plan) => plan.filter((g) => g.id !== 'other').map((g) => g.id);
const DEFAULT_GROUPS = ['image', 'video', 'audio'];

// ① null（从没排过序）→ 默认序：分组按注册、组内按 order
{
  const plan = computeNavPlan(GROUPS, TOOLS, null);
  check('null→默认分组序', JSON.stringify(groupIds(plan)) === JSON.stringify(DEFAULT_GROUPS), JSON.stringify(groupIds(plan)));
  check('null→组内按 order', JSON.stringify(ids(plan, 'image')) === JSON.stringify(['img-a', 'img-b', 'img-c']), JSON.stringify(ids(plan, 'image')));
  check('null→其它组聚合未知/缺 group 工具', JSON.stringify(ids(plan, 'other')) === JSON.stringify(['none', 'odd']) || JSON.stringify(ids(plan, 'other')) === JSON.stringify(['odd', 'none']), JSON.stringify(ids(plan, 'other')));
  check('null→其它组固定在最后', plan[plan.length - 1].id === 'other');
}

// ② groups 完整重排生效
{
  const plan = computeNavPlan(GROUPS, TOOLS, { groups: ['audio', 'video', 'image'], tools: {} });
  check('groups 完整重排', JSON.stringify(groupIds(plan)) === JSON.stringify(['audio', 'video', 'image']), JSON.stringify(groupIds(plan)));
}

// ③ 缺某组 → 按注册序追加在已排序分组之后
{
  const plan = computeNavPlan(GROUPS, TOOLS, { groups: ['audio'], tools: {} });
  check('缺组按注册序追加在尾部', JSON.stringify(groupIds(plan)) === JSON.stringify(['audio', 'image', 'video']), JSON.stringify(groupIds(plan)));
}

// ④ 未知分组 id 忽略（不炸、不进序列表）
{
  const plan = computeNavPlan(GROUPS, TOOLS, { groups: ['hacker', 'image'], tools: {} });
  check('未知分组 id 被忽略', JSON.stringify(groupIds(plan)) === JSON.stringify(['image', 'video', 'audio']), JSON.stringify(groupIds(plan)));
}

// ⑤ 组内子集重排 + 没排过的新工具按 order 追加在尾部
{
  const plan = computeNavPlan(GROUPS, TOOLS, { groups: [], tools: { image: ['img-c', 'img-a'] } });
  check('组内重排+新工具按 order 追加', JSON.stringify(ids(plan, 'image')) === JSON.stringify(['img-c', 'img-a', 'img-b']), JSON.stringify(ids(plan, 'image')));
}

// ⑥ 工具 id 出现在「别的组」的数组里 → 那边忽略、它回到声明的组（手改配置无法走私跨组）
{
  const plan = computeNavPlan(GROUPS, TOOLS, { groups: [], tools: { video: ['img-a', 'vid-b', 'vid-a'] } });
  check('跨组走私被忽略', !ids(plan, 'video').includes('img-a'), JSON.stringify(ids(plan, 'video')));
  check('走私的工具回到声明组', ids(plan, 'image').includes('img-a'));
  check('本组顺序生效', JSON.stringify(ids(plan, 'video')) === JSON.stringify(['vid-b', 'vid-a']), JSON.stringify(ids(plan, 'video')));
}

// ⑦ 非法形状（字符串 / 数字 / 数组 / 嵌套类型错）整体回退默认
{
  for (const bad of ['abc', 42, [], true, { groups: 'x', tools: 5 }, { groups: [1, 2], tools: { image: 'nope' } }]) {
    const plan = computeNavPlan(GROUPS, TOOLS, bad);
    check(`非法形状回退默认（${JSON.stringify(bad)}）`, JSON.stringify(groupIds(plan)) === JSON.stringify(DEFAULT_GROUPS), JSON.stringify(groupIds(plan)));
    check(`非法形状不丢工具（${JSON.stringify(bad)}）`, plan.reduce((n, g) => n + g.tools.length, 0) === TOOLS.length);
  }
}

// ⑧ 「其它」组：groups 里塞 other 一律忽略（永远置底）；tools.other 组内可排序
{
  const plan = computeNavPlan(GROUPS, TOOLS, { groups: ['other', 'video', 'other'], tools: { other: ['none', 'odd'] } });
  check('other 不进分组序列表', !groupIds(plan).includes('other'), JSON.stringify(groupIds(plan)));
  check('other 永远置底', plan[plan.length - 1].id === 'other');
  check('other 组内可排序', JSON.stringify(ids(plan, 'other')) === JSON.stringify(['none', 'odd']), JSON.stringify(ids(plan, 'other')));
}

// ⑨ 空数组 / 全量数组不抛错；分组去重
{
  const p1 = computeNavPlan(GROUPS, TOOLS, { groups: [], tools: {} });
  check('空分组数组→默认序', JSON.stringify(groupIds(p1)) === JSON.stringify(DEFAULT_GROUPS));
  const p2 = computeNavPlan(GROUPS, TOOLS, { groups: ['image', 'image', 'video', 'video', 'audio'], tools: {} });
  check('分组去重', JSON.stringify(groupIds(p2)) === JSON.stringify(DEFAULT_GROUPS), JSON.stringify(groupIds(p2)));
}

// ⑩ 幂等：把算出来的顺序再喂回去，结果不变（round-trip 稳定）
{
  const saved = { groups: ['video', 'image', 'audio'], tools: { image: ['img-c', 'img-b', 'img-a'], video: ['vid-b', 'vid-a'] } };
  const once = computeNavPlan(GROUPS, TOOLS, saved);
  const again = computeNavPlan(GROUPS, TOOLS, {
    groups: groupIds(once),
    tools: Object.fromEntries(once.filter((g) => g.id !== 'other').map((g) => [g.id, g.tools.map((t) => t.id)]))
  });
  check('round-trip 幂等', JSON.stringify(once) === JSON.stringify(again));
}

// ⑪ 启动默认工具（v2.7.1，用户要求）：排在最前的非空分组的第一个工具
{
  check('null→启动工具=默认第一组的第一个', (pickStartupTool(computeNavPlan(GROUPS, TOOLS, null)) || {}).id === 'img-a');
  const s = computeNavPlan(GROUPS, TOOLS, { groups: ['video', 'image', 'audio'], tools: { video: ['vid-b', 'vid-a'] } });
  check('排第一的组→启动工具=该组第一个', (pickStartupTool(s) || {}).id === 'vid-b');
  // 空分组跳过：只有其它组有工具时，启动工具取「其它」里的（不返回 undefined 炸掉启动）
  const pEmpty = computeNavPlan([{ id: 'image', name: '图片', icon: '🖼️' }], [{ id: 'odd', order: 5 }], null);
  check('空分组被跳过', pickStartupTool(pEmpty) !== null && pickStartupTool(pEmpty).id === 'odd');
  check('一个工具都没有→null', pickStartupTool(computeNavPlan(GROUPS, [], null)) === null);
}

console.log(`\n导航排序逻辑：通过 ${pass} / 共 ${pass + fail}${fail ? `（失败 ${fail}）` : ''}`);
for (const f of failures) console.log(`  ✗ ${f.name}：${f.message}`);
process.exit(fail === 0 ? 0 : 1);
