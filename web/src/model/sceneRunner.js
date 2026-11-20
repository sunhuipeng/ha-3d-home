/*
 * model/sceneRunner.js — 展示项执行状态机（纯 JS，零 Vue / DOM / 定时器依赖）
 *
 * 阶段 2 抽取：PanelApp 与 DisplayApp 原来各有一份逐字相同的
 *   runScene / sceneResult / sceneConfirmed / waitSceneConfirm / checkSceneWatchers，
 * 现在收敛成一台可注入的状态机：
 *   idle → busy(服务已发出) → confirmed(WS 回执 / 轮询命中) | unconfirmed(4s 超时) → cooldown
 *
 * 2026-11-15 展示项改造：执行对象从「只有场景」扩到场景 / 脚本 / 实体。
 * 服务分派统一读 model/displayAction.js 的 displayActionOf()：
 *   · scene / script / 其它域 → turn_on，仍走 WS 推送 + 400ms 轮询 + 4s 超时回执，
 *     期间磁贴转圈 + 「正在执行」，确认后磁贴变 ✓（执行结束）；
 *   · light / switch / input_boolean → toggle，**不进「执行中」态**：点击即切换，
 *     不转圈、不弹「正在切换」，当前开/关由磁贴上的状态灯实时显示；
 *   · automation → trigger、button → press 保留按域兜底。
 *
 * 所有外部依赖都从 opts 注入，便于 Node 用假时钟跑完整流程：
 *   ha()         → HA 客户端（getState / friendly / callService / demo）
 *   toast(msg)   → 底部轻提示
 *   schedule / unschedule / now → 定时器与时间（默认宿主全局）
 *   state        → { busy:{}, done:{} }，由 Vue 适配层传 reactive 对象进来
 *
 * 场景类时序与文案按重构前两页的实现逐字搬：冷却 1200ms、轮询 400ms、超时 4000ms、
 * ✓ 反馈 1500ms。所有定时器统一登记，dispose() 一次清干净。
 */
import { displayActionOf } from './displayAction.js';

export const SCENE_COOLDOWN_MS = 1200;
export const SCENE_POLL_MS = 400;
export const SCENE_TIMEOUT_MS = 4000;
export const SCENE_DONE_MS = 1500;
/* 开关类冷却：状态灯已实时反映，短冷却只用来挡住误连点，不拖慢连续切换 */
export const TOGGLE_COOLDOWN_MS = 300;

/* 状态比对：state 变化 或 last_triggered 变化 都算执行成功（仅场景类使用） */
export function sceneConfirmed(w, ha) {
  const st = ha && ha.getState ? ha.getState(w.eid) : null;
  if (!st) return false;
  if (st.state != null && st.state !== w.preState) return true;
  const lt = st.attributes && st.attributes.last_triggered;
  return !!(lt && lt !== w.preLast);
}

export function createSceneRunner({
  ha,
  toast,
  state = { busy: {}, done: {} },
  schedule = (fn, ms) => setTimeout(fn, ms),
  unschedule = (id) => clearTimeout(id),
  now = () => Date.now(),
} = {}) {
  const getHa = ha || (() => (typeof window !== 'undefined' ? window.HA : null));
  const say = toast || (() => {});
  const busy = state.busy || (state.busy = {});
  const done = state.done || (state.done = {});
  const locks = Object.create(null);
  /* 开关类的「在途」集合：它们不进 busy 态（没有执行中动效），
   * 但仍要在服务返回前挡住重复点击，否则连点会发多次 toggle。 */
  const inflight = new Set();
  const watchers = [];              // 待确认的 { eid, preState, preLast, toggle }
  const timers = new Set();
  let disposed = false;

  const later = (fn, ms) => {
    const id = schedule(() => {
      timers.delete(id);
      if (!disposed) fn();
    }, ms);
    timers.add(id);
    return id;
  };

  const removeWatcher = (w) => {
    const i = watchers.indexOf(w);
    if (i >= 0) watchers.splice(i, 1);
  };

  /* 确认成功: ✓ + 提示；未确认: 服务已发出但超时内无状态变化 */
  function result(w, confirmed) {
    busy[w.eid] = false;
    locks[w.eid] = now() + (w.toggle ? TOGGLE_COOLDOWN_MS : SCENE_COOLDOWN_MS);
    if (confirmed) {
      done[w.eid] = true;
      say((w.toggle ? '✓ 已切换 · ' : '✓ 已执行 · ') + getHa().friendly(w.eid));
      later(() => { done[w.eid] = false; }, SCENE_DONE_MS);
    } else {
      say('已发送（未收到执行回执）· ' + getHa().friendly(w.eid));
    }
  }

  /* 轮询兜底：WS 推送路径（check）会先一步命中；400ms 一次，4s 超时 */
  function wait(w) {
    const t0 = now();
    const tick = () => {
      if (!watchers.includes(w)) return;            // 已由推送路径确认
      if (sceneConfirmed(w, getHa())) {
        removeWatcher(w);
        result(w, true);
        return;
      }
      if (now() - t0 > SCENE_TIMEOUT_MS) {
        removeWatcher(w);
        result(w, false);
        return;
      }
      later(tick, SCENE_POLL_MS);
    };
    later(tick, SCENE_POLL_MS);
  }

  /* 执行展示项：服务调用 → 场景类等待 HA 回执，开关类/演示模式立即完成 */
  function run(s) {
    const eid = s.eid;
    if (busy[eid] || inflight.has(eid)) return;     // 本次还在执行（场景类看 busy，开关类看在途）
    if (now() < (locks[eid] || 0)) return;         // 冷却窗口内忽略
    const A = getHa();
    if (!A || typeof A.callService !== 'function') {   // HA 客户端缺失（demo 环境异常等）不崩，提示后退出
      say('✗ HA 未连接，无法执行 · ' + (s.name || eid));
      return;
    }
    const act = displayActionOf(s);
    const before = A.getState(eid);
    const w = {
      eid,
      preState: before ? before.state : null,
      preLast: before && before.attributes ? before.attributes.last_triggered : null,
      toggle: act.toggle,
    };
    /* 只有「场景 / 脚本」这类需要等 HA 回执的展示项才有执行中动效：
     * 转圈 + 「正在执行」提示，直到确认 / 超时才结束。
     * 开关类（light / switch / input_boolean）点击即切换 —— 不转圈、不弹
     * 「正在切换」，当前开/关由磁贴状态灯实时反映，完成只留一句 ✓ 提示。 */
    if (act.toggle) {
      inflight.add(eid);
    } else {
      busy[eid] = true;
      say('正在执行 · ' + s.name);
    }
    A.callService(act.domain, act.service, { entity_id: eid })
      .then(() => {
        inflight.delete(eid);
        if (disposed) return;
        /* 演示模式没有真实回执；开关类用状态灯反馈，服务成功即完成 */
        if (getHa().demo || act.toggle) { result(w, true); return; }
        const i = watchers.findIndex((x) => x.eid === eid);
        if (i >= 0) watchers.splice(i, 1);
        watchers.push(w);
        wait(w);                                  // WS 推送 + 轮询双路确认
      })
      .catch((e) => {
        console.error('执行失败', e);
        inflight.delete(eid);
        busy[eid] = false;
        say((act.toggle ? '✗ 切换失败 · ' : '✗ 执行失败 · ') + s.name);
      });
  }

  /* WS 状态推送 → 立即核对挂起的场景回执（比轮询更快） */
  function check() {
    if (!watchers.length) return;
    const A = getHa();
    watchers.slice().forEach((w) => {
      if (sceneConfirmed(w, A)) {
        removeWatcher(w);
        result(w, true);
      }
    });
  }

  function dispose() {
    disposed = true;
    timers.forEach(unschedule);
    timers.clear();
    watchers.length = 0;
  }

  return { run, check, dispose, state };
}
