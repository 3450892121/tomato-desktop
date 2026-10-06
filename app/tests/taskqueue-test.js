// 跨工具任务队列 · 纯逻辑单测（Node 直接跑，无需界面与 Electron）
// 运行：cd app && node tests/taskqueue-test.js   （或 npm test，见 tests/taskqueue.test.mjs 入口）
//
// 覆盖：通道并发上限（cpu=1 / io=2）、通道隔离、进度聚合、取消（排队/运行中）、失败与 retry、
//       最近完成记录、clearFinished、runBatch、waitFor。
import assert from 'node:assert/strict';
import { createQueue } from '../src/shared/taskqueue.js';

/** 可手动放行的闸门（模拟「任务还没做完」） */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 让微任务队列跑空（队列内部的 Promise 链推进需要） */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 造一个「跑一会儿」的任务执行函数：先跑一段，直到 gate 放行才返回 */
function gatedRun(gate, result = { ok: true }) {
  return async () => {
    await gate.promise;
    return result;
  };
}

/**
 * 跑全部纯逻辑单测
 * @returns {Promise<{pass:number, fail:number, total:number, failures:Array<{name:string,message:string}>}>}
 */
export async function runQueueUnitTests() {
  let pass = 0;
  let fail = 0;
  const failures = [];

  async function test(name, fn) {
    try {
      await fn();
      pass += 1;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      fail += 1;
      failures.push({ name, message: err.message });
      console.log(`  ✗ ${name}\n      ${err.message}`);
    }
  }

  console.log('任务队列 · 纯逻辑单测');

  // —— 1) cpu 通道并发上限 = 1 ——
  await test('cpu 通道同时最多跑 1 个（其余排队）', async () => {
    const queue = createQueue();
    const gates = [deferred(), deferred(), deferred()];
    const ids = gates.map((g, i) => queue.enqueue({ toolId: 'x', toolName: 'X', label: `f${i}`, lane: 'cpu', run: gatedRun(g) }));
    assert.equal(queue.summary().running, 1, 'cpu 同时只应有 1 个在跑');
    assert.equal(queue.summary().queued, 2);

    gates[0].resolve();
    await queue.waitFor(ids[0]);
    await tick();
    assert.equal(queue.summary().done, 1);
    assert.equal(queue.summary().running, 1, '前一个结束后应立刻补上下一个');

    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(ids.map((id) => queue.waitFor(id)));
    assert.deepEqual(
      { running: queue.summary().running, queued: queue.summary().queued, done: queue.summary().done },
      { running: 0, queued: 0, done: 3 }
    );
  });

  // —— 2) io 通道并发上限 = 2，且与 cpu 互不挤占 ——
  await test('io 通道同时最多跑 2 个，且与 cpu 通道互不挤占', async () => {
    const queue = createQueue();
    const ioGates = [deferred(), deferred(), deferred()];
    const cpuGate = deferred();
    const ioIds = ioGates.map((g, i) => queue.enqueue({ toolId: 'x', toolName: 'X', label: `io${i}`, lane: 'io', run: gatedRun(g) }));
    const cpuId = queue.enqueue({ toolId: 'x', toolName: 'X', label: 'cpu0', lane: 'cpu', run: gatedRun(cpuGate) });

    const s = queue.summary();
    assert.equal(s.running, 3, 'io 2 个 + cpu 1 个同时跑');
    assert.equal(s.queued, 1, '第三个 io 排队');
    assert.equal(ioIds.filter((id) => queue.get(id).status === 'running').length, 2);
    assert.equal(queue.get(cpuId).status, 'running', 'cpu 不受 io 占用影响');

    for (const g of ioGates) g.resolve();
    cpuGate.resolve();
    await Promise.all([...ioIds, cpuId].map((id) => queue.waitFor(id)));
    assert.equal(queue.summary().done, 4);
  });

  // —— 3) 进度聚合 ——
  await test('进度聚合：终态记 100、运行中记自身进度、排队记 0，按任务条数加权', async () => {
    const queue = createQueue({ concurrency: { cpu: 3, io: 3 } });
    const gate1 = deferred();
    const gate2 = deferred();
    const gate3 = deferred();
    const gate4 = deferred();
    const id1 = queue.enqueue({
      toolId: 'x', toolName: 'X', label: 'a', lane: 'cpu',
      run: async ({ report }) => { report({ percent: 100, text: '快好了' }); await gate1.promise; return { ok: true }; }
    });
    const id2 = queue.enqueue({
      toolId: 'x', toolName: 'X', label: 'b', lane: 'cpu',
      run: async ({ report }) => { report({ percent: 50, text: '一半' }); await gate2.promise; return { ok: true }; }
    });
    queue.enqueue({
      toolId: 'x', toolName: 'X', label: 'c', lane: 'cpu',
      run: async ({ report }) => { report({ percent: 100 }); await gate3.promise; return { ok: true }; }
    });
    queue.enqueue({ toolId: 'x', toolName: 'X', label: 'd', lane: 'cpu', run: gatedRun(gate4) });

    await tick();
    const s = queue.summary();
    // (100 + 50 + 100 + 0) / 4 = 62.5 → 63
    assert.equal(s.percent, 63, `总进度应为 63，实际 ${s.percent}`);
    assert.deepEqual({ done: s.done, running: s.running, queued: s.queued }, { done: 0, running: 3, queued: 1 });
    assert.equal(queue.get(id2).stepText, '一半', 'report 的文本应写入 stepText');
    assert.equal(queue.get(id1).stepText, '快好了');

    gate1.resolve();
    gate2.resolve();
    gate3.resolve();
    gate4.resolve();
    await Promise.all([id1, id2].concat(queue.list().filter((t) => t.label === 'd').map((t) => t.id)).map((id) => queue.waitFor(id)));
    await tick();
    assert.equal(queue.summary().percent, 100);
  });

  // —— 4) 取消排队中的任务 ——
  await test('取消：排队中的直接标记 canceled，不占后续并发额度', async () => {
    const queue = createQueue();
    const gate1 = deferred();
    const id1 = queue.enqueue({ toolId: 'x', toolName: 'X', label: 'a', lane: 'cpu', run: gatedRun(gate1) });
    const gate2 = deferred();
    const id2 = queue.enqueue({ toolId: 'x', toolName: 'X', label: 'b', lane: 'cpu', run: gatedRun(gate2) });

    assert.equal(queue.cancel(id2), true);
    assert.equal(queue.get(id2).status, 'canceled');
    assert.equal(queue.summary().queued, 0);
    assert.equal(queue.summary().canceled, 1);
    const settled = await queue.waitFor(id2);
    assert.equal(settled.status, 'canceled');

    gate1.resolve();
    await queue.waitFor(id1);
    assert.equal(queue.get(id1).status, 'done');
  });

  // —— 5) 取消运行中的任务：置标志 + 调 onCancel，run 收敛后算取消 ——
  await test('取消：运行中的置 cancelRequested 并调 onCancel，返回 ok 也算取消', async () => {
    const queue = createQueue();
    let cancelCalled = 0;
    const gate = deferred();
    const id = queue.enqueue({
      toolId: 'x', toolName: 'X', label: 'a', lane: 'cpu',
      run: async () => { await gate.promise; return { ok: true }; }, // 即便「成功」返回，也已取消
      onCancel: () => { cancelCalled += 1; }
    });
    assert.equal(queue.cancel(id), true);
    assert.equal(cancelCalled, 1, '应调用 onCancel');
    assert.equal(queue.get(id).cancelRequested, true);
    assert.equal(queue.get(id).status, 'running', '取消是异步收敛，先保持 running');

    gate.resolve();
    const settled = await queue.waitFor(id);
    assert.equal(settled.status, 'canceled');
  });

  await test('取消：运行中 run 抛错（进程被杀）也算取消，不算失败', async () => {
    const queue = createQueue();
    const gate = deferred();
    const id = queue.enqueue({
      toolId: 'x', toolName: 'X', label: 'a', lane: 'cpu',
      run: async () => { await gate.promise; throw new Error('进程被结束'); }
    });
    queue.cancel(id);
    gate.resolve();
    const settled = await queue.waitFor(id);
    assert.equal(settled.status, 'canceled');
    assert.equal(settled.error, '');
  });

  // —— 6) 失败不自动重试；retry 重新入队且 retryCount+1 ——
  await test('失败：run 返回 ok:false 记 failed 并保留原因，不自动重试', async () => {
    const queue = createQueue();
    const id = queue.enqueue({
      toolId: 'x', toolName: 'X', label: 'a', lane: 'cpu',
      run: async () => ({ ok: false, error: '磁盘已满' })
    });
    const settled = await queue.waitFor(id);
    assert.equal(settled.status, 'failed');
    assert.equal(settled.error, '磁盘已满');
    assert.equal(queue.summary().failed, 1);
    await tick();
    assert.equal(queue.summary().running, 0, '失败后不应自动重试（不应再有任务在跑）');
  });

  await test('失败：run 抛错记 failed 并带上错误信息', async () => {
    const queue = createQueue();
    const id = queue.enqueue({ toolId: 'x', toolName: 'X', label: 'a', lane: 'cpu', run: async () => { throw new Error('炸了'); } });
    const settled = await queue.waitFor(id);
    assert.equal(settled.status, 'failed');
    assert.equal(settled.error, '炸了');
  });

  await test('retry：失败任务重新入队（参数不变，retryCount+1）并真正执行', async () => {
    const queue = createQueue();
    let attempts = 0;
    const id = queue.enqueue({
      toolId: 'x', toolName: 'X', label: 'a', lane: 'cpu',
      run: async () => {
        attempts += 1;
        return attempts === 1 ? { ok: false, error: '第一次失败' } : { ok: true, outputPaths: ['out.png'] };
      }
    });
    await queue.waitFor(id);
    assert.equal(queue.get(id).status, 'failed');

    const newId = queue.retry(id);
    assert.ok(newId && newId !== id, 'retry 应返回新的 taskId');
    const again = await queue.waitFor(newId);
    assert.equal(again.status, 'done');
    assert.equal(again.retryCount, 1);
    assert.deepEqual(again.output.paths, ['out.png']);
    assert.equal(queue.get(id).status, 'failed', '原任务保持 failed，便于追溯');

    assert.equal(queue.retry(newId), null, '已成功的任务不能再 retry');
  });

  // —— 7) 最近完成记录 / 清空 ——
  await test('recentFinished / clearFinished', async () => {
    const queue = createQueue();
    const ids = [1, 2, 3].map((i) => queue.enqueue({ toolId: 'x', toolName: 'X', label: `f${i}`, lane: 'cpu', run: async () => ({ ok: true }) }));
    await Promise.all(ids.map((id) => queue.waitFor(id)));

    const recent = queue.recentFinished(2);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].label, 'f3', '最近的在前');

    assert.equal(queue.clearFinished(), 3);
    assert.equal(queue.list().length, 0);
    assert.equal(queue.recentFinished(10).length, 0);
    assert.equal(queue.summary().total, 0);
    assert.equal(queue.summary().percent, 0, '无任务时总进度为 0');
  });

  // —— 8) runBatch：工具接入入口 ——
  await test('runBatch：批量入队并等待全部结束，返回值与 jobs 同序', async () => {
    const queue = createQueue();
    const gates = [deferred(), deferred()];
    const pending = queue.runBatch({
      toolId: 'demo', toolName: '演示', lane: 'io',
      jobs: gates.map((g, i) => ({ label: `job${i}`, inputPaths: [`in${i}.png`], run: gatedRun(g, { ok: true, outputPaths: [`out${i}.png`] }) }))
    });
    await tick();
    assert.equal(queue.summary().running, 2);

    gates.forEach((g) => g.resolve());
    const settled = await pending;
    assert.equal(settled.length, 2);
    assert.equal(settled[0].label, 'job0');
    assert.equal(settled[1].label, 'job1');
    assert.ok(settled.every((t) => t.status === 'done'));
    assert.deepEqual(settled[0].input.paths, ['in0.png']);
  });

  // —— 9) waitFor 容错 ——
  await test('waitFor：未知 taskId 返回 null；已终态立即 resolve', async () => {
    const queue = createQueue();
    assert.equal(await queue.waitFor('不存在'), null);
    const id = queue.enqueue({ toolId: 'x', toolName: 'X', label: 'a', lane: 'cpu', run: async () => ({ ok: true }) });
    await queue.waitFor(id);
    const again = await queue.waitFor(id);
    assert.equal(again.status, 'done');
  });

  // —— 10) 未知通道名归一为 cpu（保守串行，避免打满 CPU） ——
  await test('lane 归一：未知通道按 cpu 处理（并发 1）', async () => {
    const queue = createQueue();
    const g1 = deferred();
    const g2 = deferred();
    const a = queue.enqueue({ toolId: 'x', toolName: 'X', label: 'a', lane: 'turbo', run: gatedRun(g1) });
    const b = queue.enqueue({ toolId: 'x', toolName: 'X', label: 'b', lane: 'turbo', run: gatedRun(g2) });
    assert.equal(queue.get(a).lane, 'cpu');
    assert.equal(queue.summary().running, 1);
    assert.equal(queue.summary().queued, 1);
    g1.resolve();
    g2.resolve();
    await Promise.all([queue.waitFor(a), queue.waitFor(b)]);
  });

  return { pass, fail, total: pass + fail, failures };
}

export default runQueueUnitTests;