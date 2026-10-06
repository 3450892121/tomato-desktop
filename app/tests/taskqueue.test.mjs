// 任务队列单测的独立运行入口（npm test 会连跑它；也可单独 `node tests/taskqueue.test.mjs`）
// 逻辑本体在 tests/taskqueue-test.js，这里只负责跑并给出退出码。
import { runQueueUnitTests } from './taskqueue-test.js';

const result = await runQueueUnitTests();
console.log(`\n任务队列单测：通过 ${result.pass} / 共 ${result.total}${result.fail ? `（失败 ${result.fail}）` : ''}`);
for (const f of result.failures) console.log(`  ✗ ${f.name}：${f.message}`);
process.exit(result.fail === 0 ? 0 : 1);