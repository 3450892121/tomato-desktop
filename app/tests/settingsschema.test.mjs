// 设置校验与转义单测的独立运行入口（npm test 会连跑它；也可单独 `node tests/settingsschema.test.mjs`）
import { runSchemaUnitTests } from './settingsschema-test.js';

const result = runSchemaUnitTests();
console.log(`\n设置校验与转义单测：通过 ${result.pass} / 共 ${result.total}${result.fail ? `（失败 ${result.fail}）` : ''}`);
for (const f of result.failures) console.log(`  ✗ ${f.name}：${f.message}`);
process.exit(result.fail === 0 ? 0 : 1);
