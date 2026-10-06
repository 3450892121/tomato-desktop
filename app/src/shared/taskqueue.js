// 跨工具任务队列（纯逻辑、无 DOM；Node 可直接单测，见 tests/taskqueue-test.js）
//
// 为什么要有它：
//   1) 工具页的批量任务原先由各工具自己 for 循环跑，切走工具页就看不到整体进度；
//   2) 工具页有保活上限（LRU 回收），被回收时会调 unmount()，而旧实现的 unmount() 会取消在跑的任务，
//      导致「切工具切多了，后台任务连坐被杀」。
// 硬契约（框架层必须遵守，见 spec/modules/task-queue.md）：
//   **入队后的任务归属队列，不归属工具页。** 工具 unmount()（LRU 回收）只退订 UI 订阅，
//   不得取消队列中的任务 —— 任务照跑，切回工具页再看到进度/结果。
// 反向依赖禁令：本文件不得 import 任何工具（工具 → shared 是允许方向，反向不行）。

/** 通道默认并发：cpu=1（ffmpeg / PDF / OCR 吃满 CPU，串行跑最稳）；io=2（canvas 图片类可并行两个） */
const LANE_CONCURRENCY = { cpu: 1, io: 2 };
/** 任务终态 */
const TERMINAL = new Set(['done', 'failed', 'canceled']);
/** 最近完成记录默认保留条数（内存态，运行态不持久化：重启后未完成的一律丢弃） */
const HISTORY_LIMIT = 50;

let seq = 0;
/** 任务 id：时间戳 + 自增序号，稳且可读，便于排障 */
function nextId() {
  seq += 1;
  return `t${Date.now().toString(36)}-${seq.toString(36)}`;
}

/** 通道名归一：未知一律归 cpu（保守：串行，不会因打错通道名把 CPU 打满） */
function normalizeLane(lane) {
  return lane === 'io' ? 'io' : 'cpu';
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 创建一个任务队列实例。
 * @param {object} [options]
 * @param {{cpu?:number, io?:number}} [options.concurrency] 各通道并发上限（缺省 cpu=1 / io=2）
 * @param {() => void} [options.onChange] 队列有任何变化（入队/开跑/进度/结束/清除）时回调，供界面刷新
 * @param {(task:object) => void} [options.onTaskDone] 单个任务到达终态时回调（含失败/取消）
 * @param {number} [options.historyLimit] 最近完成记录保留条数
 */
export function createQueue({ concurrency = {}, onChange, onTaskDone, historyLimit = HISTORY_LIMIT } = {}) {
  const limits = {
    cpu: Math.max(1, Math.trunc(concurrency.cpu) || LANE_CONCURRENCY.cpu),
    io: Math.max(1, Math.trunc(concurrency.io) || LANE_CONCURRENCY.io)
  };

  /** id → task（活任务 + 终态未清除的任务） */
  const tasks = new Map();
  /** 入队顺序的 id 列表（list() 按此顺序返回） */
  const order = [];
  /** 最近完成记录（终态即入栈，新的在前） */
  const history = [];
  /** id → [resolve]，供 waitFor 使用 */
  const waiters = new Map();

  function emit() {
    if (!onChange) return;
    try {
      onChange();
    } catch (err) {
      console.error('[taskqueue] onChange 回调失败', err);
    }
  }

  function runningCount(lane) {
    let n = 0;
    for (const task of tasks.values()) {
      if (task.lane === lane && task.status === 'running') n += 1;
    }
    return n;
  }

  /** 把任务落到终态：写时间戳/结果、进最近完成记录、唤醒等待者、通知界面 */
  function settle(task, status, payload) {
    task.status = status;
    task.endedAt = Date.now();
    if (status === 'done') task.progress = 100;
    if (payload && typeof payload === 'object') {
      if (Array.isArray(payload.outputPaths)) task.output.paths = payload.outputPaths.slice();
      if (payload.outputDir) task.output.dir = payload.outputDir;
      if (payload.error) task.error = String(payload.error);
    }
    history.unshift(task);
    while (history.length > historyLimit) history.pop();

    const list = waiters.get(task.id);
    if (list) {
      waiters.delete(task.id);
      for (const resolve of list) resolve(task);
    }
    if (onTaskDone) {
      try {
        onTaskDone(task);
      } catch (err) {
        console.error('[taskqueue] onTaskDone 回调失败', err);
      }
    }
  }

  /** 真正开跑一个任务：把 run(ctx) 的 ctx（report / isCancelled）备好 */
  function start(task) {
    task.status = 'running';
    task.startedAt = Date.now();
    task.progress = 0;
    emit();

    const report = (info = {}) => {
      if (task.status !== 'running') return; // 已终态（如取消完成）后到达的迟到进度直接丢弃
      if (info.percent != null) task.progress = clampPercent(info.percent);
      if (info.text != null) task.stepText = String(info.text);
      emit();
    };
    const isCancelled = () => !!task.cancelRequested;

    Promise.resolve()
      .then(() => task.run({ report, isCancelled }))
      .then((res) => {
        if (task.cancelRequested || (res && res.canceled)) settle(task, 'canceled');
        else if (res && res.ok) settle(task, 'done', res);
        else settle(task, 'failed', { error: (res && res.error) || '任务失败' });
      })
      .catch((err) => {
        // 已请求取消时，run 抛错（多是进程被杀）算取消，不算失败
        if (task.cancelRequested) settle(task, 'canceled');
        else settle(task, 'failed', { error: (err && err.message) || String(err) });
      })
      .finally(() => {
        emit();
        pump(); // 腾出的并发额度立刻派给排队中的任务
      });
  }

  /** 调度：每个通道在并发上限内，按入队顺序把 queued 派成 running */
  function pump() {
    for (const lane of ['cpu', 'io']) {
      while (runningCount(lane) < limits[lane]) {
        let next = null;
        for (const id of order) {
          const task = tasks.get(id);
          if (task && task.lane === lane && task.status === 'queued') {
            next = task;
            break;
          }
        }
        if (!next) break;
        start(next);
      }
    }
  }

  /**
   * 入队一个任务。
   * @param {object} job
   * @param {string} job.toolId 工具 id（如 'video-compress'）
   * @param {string} job.toolName 工具显示名（如 '视频压缩'）
   * @param {string} job.label 任务名（一般是要处理的文件名）
   * @param {'cpu'|'io'} [job.lane] 通道，默认 cpu
   * @param {(ctx:{report:Function,isCancelled:Function}) => Promise<{ok?:boolean,outputPaths?:string[],outputDir?:string,error?:string,canceled?:boolean}>} job.run
   *        工具提供的执行函数；report({percent,text}) 上报进度，isCancelled() 查取消标志
   * @param {(task:object) => void} [job.onCancel] 取消回调（工具在里面杀 ffmpeg 进程 / 置自己的取消标志）
   * @param {string[]} [job.inputPaths] 输入文件（展示用）
   * @returns {string} taskId
   */
  function enqueue(job = {}) {
    const task = {
      id: nextId(),
      toolId: job.toolId || '',
      toolName: job.toolName || job.toolId || '',
      label: job.label || '',
      lane: normalizeLane(job.lane),
      status: 'queued',
      progress: 0,
      stepText: '',
      input: { paths: Array.isArray(job.inputPaths) ? job.inputPaths.slice() : [] },
      output: { paths: [], dir: job.outputDir || '' },
      error: '',
      retryCount: job.retryCount || 0,
      cancelRequested: false,
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      run: job.run,
      onCancel: job.onCancel
    };
    tasks.set(task.id, task);
    order.push(task.id);
    emit();
    pump();
    return task.id;
  }

  /**
   * 批量入队同一工具的若干「单文件任务」，并等待它们全部到达终态。
   * 这是工具接入的推荐入口：工具只需把串行 for 循环换成一次 runBatch。
   * @param {{toolId:string, toolName:string, lane?:'cpu'|'io', jobs:Array<object>}} batch
   * @returns {Promise<object[]>} 与 jobs 同序的任务对象数组（已全部终态）
   */
  async function runBatch({ toolId, toolName, lane = 'cpu', jobs = [] } = {}) {
    const ids = jobs.map((job) => enqueue({ toolId, toolName, lane, ...job }));
    return Promise.all(ids.map((id) => waitFor(id)));
  }

  /** 取消：queued 直接标记取消；running 置取消标志并调 onCancel()，等 run 自己收敛 */
  function cancel(taskId) {
    const task = tasks.get(taskId);
    if (!task || TERMINAL.has(task.status)) return false;
    task.cancelRequested = true;
    if (task.status === 'queued') {
      settle(task, 'canceled');
      emit();
      pump();
      return true;
    }
    emit();
    if (task.onCancel) {
      try {
        task.onCancel(task);
      } catch (err) {
        console.error('[taskqueue] onCancel 回调失败', err);
      }
    }
    return true;
  }

  /** 取消所有未完成任务（排队中 + 运行中） */
  function cancelAll() {
    let n = 0;
    for (const task of [...tasks.values()]) {
      if (cancel(task.id)) n += 1;
    }
    return n;
  }

  /** 列表：按入队顺序返回全部任务（含尚未清除的终态任务） */
  function list() {
    return order.map((id) => tasks.get(id)).filter(Boolean);
  }

  function get(taskId) {
    return tasks.get(taskId) || null;
  }

  /**
   * 汇总：各状态计数 + 总进度。
   * 总进度按「任务条数」加权平均：终态任务记 100（失败/取消也算「已结束」）、运行中记其进度、排队中记 0。
   */
  function summary() {
    let queued = 0;
    let running = 0;
    let done = 0;
    let failed = 0;
    let canceled = 0;
    let weight = 0;
    let total = 0;
    for (const task of tasks.values()) {
      total += 1;
      if (task.status === 'queued') {
        queued += 1;
      } else if (task.status === 'running') {
        running += 1;
        weight += task.progress;
      } else {
        if (task.status === 'done') done += 1;
        else if (task.status === 'failed') failed += 1;
        else canceled += 1;
        weight += 100;
      }
    }
    return {
      queued,
      running,
      done,
      failed,
      canceled,
      total,
      percent: total ? Math.round(weight / total) : 0
    };
  }

  /** 清除已结束（done/failed/canceled）的任务与最近完成记录，返回清除条数 */
  function clearFinished() {
    let removed = 0;
    for (const id of [...order]) {
      const task = tasks.get(id);
      if (task && TERMINAL.has(task.status)) {
        tasks.delete(id);
        removed += 1;
      }
    }
    if (removed > 0) {
      const alive = order.filter((id) => tasks.has(id));
      order.length = 0;
      order.push(...alive);
    }
    history.length = 0;
    emit();
    return removed;
  }

  /**
   * 失败/取消的任务重新入队（参数不变，retryCount+1）。
   * 为什么不做自动重试：产物可能被重复覆盖，交给用户显式决定。
   */
  function retry(taskId) {
    const task = tasks.get(taskId);
    if (!task || !(task.status === 'failed' || task.status === 'canceled')) return null;
    return enqueue({
      toolId: task.toolId,
      toolName: task.toolName,
      label: task.label,
      lane: task.lane,
      run: task.run,
      onCancel: task.onCancel,
      retryCount: task.retryCount + 1,
      inputPaths: task.input.paths,
      outputDir: task.output.dir
    });
  }

  /** 最近完成记录（新的在前），默认 10 条 */
  function recentFinished(limit = 10) {
    return history.slice(0, Math.max(0, limit));
  }

  /** 等待某任务到达终态（已终态则立即 resolve）；用于工具保留原来的「跑完再汇总」界面行为 */
  function waitFor(taskId) {
    const task = tasks.get(taskId);
    if (!task) return Promise.resolve(null);
    if (TERMINAL.has(task.status)) return Promise.resolve(task);
    return new Promise((resolve) => {
      if (!waiters.has(taskId)) waiters.set(taskId, []);
      waiters.get(taskId).push(resolve);
    });
  }

  return {
    enqueue,
    runBatch,
    cancel,
    cancelAll,
    list,
    get,
    summary,
    clearFinished,
    retry,
    recentFinished,
    waitFor,
    limits
  };
}