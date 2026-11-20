/*
 * engine/lighting.js — 全场景光照控制器（唯一真相）
 *
 * 为什么集中在这里：three.js 的光照本来就是场景级的。把「全局亮度」下发给房屋 /
 * 背景 / 家具 / 设备各自读取会让口径分叉，而且 MeshBasicMaterial（房间地面）、
 * Sprite、emissive、DOM 卡片根本不吃光。这里统一持有状态，再分三条路写出：
 *   1) 受光材质 → 改两盏基础灯强度（View3D.setAmbient），所有 Lambert / Standard 自动跟随；
 *   2) 灯具补光 → View3D.lightingGain 被 lightKit.set() 乘进池灯（plugins.js），
 *                  夜间基础光压暗后灯具要「相对更亮」才能从暗底里跳出来；
 *   3) 不受光   → 房间地面按 roomId 乘亮度（View3D.setRoomBrightness）；
 *                  DOM / 卡片 / 天空由 <html data-theme="dark"> 切另一套 CSS 变量
 *                  （仅展示页；edit.html 编辑页 UI 与 3D 光照都不参与，见 S.editPage）。
 *
 * 状态来自 HA WebSocket，不进 Pinia / reactive；只在 HA 'change' 边界重算，绝不每帧算。
 * 开关灯与模式切换走 260ms 平滑过渡，避免亮度硬跳。
 */
import { View3D } from './view3d.js';
import { PluginEngine } from './plugins.js';
import { HA } from '../services/ha.js';
import { roomDevices, devTypeOf } from '../model/catalog.js';
import { PREF_KEYS, prefBool, prefSetBool, prefInt, prefSetInt } from '../services/prefs.js';

export const LIGHTING_EVENT = 'ha3d:lighting';

/* 白天 / 夜间两档基线：
 * ambient   基础灯倍率（白天 = 太阳主光 0.90 + 天光填充 0.68，见 view3d.js 的 BASE_*）
 * lampGain  灯具池光倍率（夜间 >1：房间地面是 Basic 不吃点光、墙半透无阴影，
 *           压低灯具只会让灯更暗；白天 1.0 / 夜间 1.3 让开关灯反差明显）
 * roomMin   关灯房间的地面亮度下限（开灯房间恒为 1.0）
 * moon      月光色系数：0 = 白天暖白太阳光，1 = 基础灯整体偏到冷蓝月光（view3d.setAmbient）
 * 白天也留 0.82 的下限，所以白天开灯同样能看见房间变亮，只是夜间对比更强。 */
export const LIGHT_PRESETS = {
  day: { ambient: 1.00, lampGain: 1.00, roomMin: 0.82, moon: 0 },
  /* 夜间 ambient 比旧版大（0.38→0.48）：基础灯改成「太阳主光 + 弱天光」配比后，
   * 同样系数下整体会偏暗，抬一点才不至于闷；moon=1 负责把色温换成冷蓝月光。 */
  night: { ambient: 0.48, lampGain: 1.30, roomMin: 0.26, moon: 1 },
};
const TWEEN_MS = 260;

const S = {
  night: false,
  /* edit.html 完全不参与暗夜模式：不读 nightMode 偏好、不切 DOM 主题、3D 也恒白天基线。
     <html data-page="edit"> 是静态标记，模块加载时就能读到，不用等 initLighting。 */
  editPage: typeof document !== 'undefined'
    && document.documentElement.getAttribute('data-page') === 'edit',
  level: 1,               // 全局亮度微调（0.2~1），默认 1 = 不额外压暗
  ambient: 1,
  moon: 0,                // 月光色系数（0 白天 → 1 夜间冷蓝）
  roomMin: LIGHT_PRESETS.day.roomMin,
  rooms: {},              // 当前（渐变中）roomId → 0..1
  project: null,
  floorIndex: () => 0,
  attached: false,
};
let from = null, to = null, t0 = 0, raf = 0;

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
const mix = (a, b, e) => a + (b - a) * e;
const smooth = (p) => p * p * (3 - 2 * p);

/* 房间亮度 = 该房间内所有灯里「最亮的那盏」。light 实体带 brightness(0~255) 时
 * 按百分比连续调光，没带就按满亮。归属只认实例上的 roomId（与 roomDevices 同口径，
 * 不重新做几何判定）。未归属的灯与没有多边形的公共区域不进表，靠 ambient 整体变暗。 */
function computeRooms() {
  const p = S.project;
  const fl = p && p.floors && p.floors[S.floorIndex()];
  const out = {};
  if (!fl) return out;
  (fl.rooms || []).forEach((r) => {
    let b = 0;
    roomDevices(fl, r.id).forEach((d) => {
      if ((d.type || devTypeOf(d)) !== 'light' || !HA.deviceIsOn(d)) return;
      const st = HA.getState(d.entityId);
      const raw = st && st.attributes ? Number(st.attributes.brightness) : NaN;
      b = Math.max(b, Number.isFinite(raw) && raw > 0 ? clamp01(raw / 255) : 1);
    });
    out[r.id] = b;
  });
  return out;
}

/* 只写数据：View3D.startLoop 每帧都会 render，不需要在这里主动触发渲染。 */
function writeEngine() {
  if (View3D.setAmbient) View3D.setAmbient(S.ambient, S.moon);
  if (View3D.setRoomBrightness) View3D.setRoomBrightness(S.rooms, S.roomMin);
}

function tick(ts) {
  const p = Math.min(1, (ts - t0) / TWEEN_MS);
  const e = smooth(p);
  S.ambient = mix(from.ambient, to.ambient, e);
  S.moon = mix(from.moon, to.moon, e);
  S.roomMin = mix(from.roomMin, to.roomMin, e);
  const keys = new Set([...Object.keys(from.rooms), ...Object.keys(to.rooms)]);
  keys.forEach((k) => { S.rooms[k] = mix(from.rooms[k] ?? 1, to.rooms[k] ?? 0, e); });
  writeEngine();
  raf = p < 1 ? requestAnimationFrame(tick) : 0;
}

function applyTheme() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  /* 编辑页 UI 恒浅色；style.css 的夜间变量块另有一层 :not([data-page="edit"]) 兜底。 */
  const editPage = S.editPage;
  if (editPage || !S.night) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', !editPage && S.night ? '#0a0a0a' : '#eef1f5');

  /* 池灯不渐变：切模式时让所有插件实例重跑一次 update()，把新 gain 写进点光源。
   * kit.set() 每次 HA change 都会重写强度，所以系数必须放在它读得到的地方。 */
  const preset = S.night ? LIGHT_PRESETS.night : LIGHT_PRESETS.day;
  View3D.lightingGain = preset.lampGain * S.level;
  /* 默认背景「纯色 + 网格」的网格线跟着主题走：夜间压暗、白天原样（编辑页恒白天）。
   * 与 lightingGain 同在此处，覆盖首次加载 / 手动切夜间 / 跨标签同步三条路径。 */
  if (View3D.setGridNight) View3D.setGridNight(!editPage && S.night);
  if (PluginEngine.updateAll) PluginEngine.updateAll();

  if (typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent(LIGHTING_EVENT, {
      detail: { night: S.night, level: S.level },
    }));
  }
}

/** 启动序列 / 编辑页 init 里调一次；幂等，重复调用只是换 project 引用。 */
export function initLighting(project, floorIndex) {
  S.project = project || null;
  if (typeof floorIndex === 'function') S.floorIndex = floorIndex;
  S.night = S.editPage ? false : prefBool(PREF_KEYS.nightMode, false);
  S.level = Math.max(0.2, Math.min(1, prefInt(PREF_KEYS.lightLevel, 100) / 100));
  applyTheme();
  if (!S.attached) {
    S.attached = true;
    /* 首次全量快照直接到位（避免开场房间先暗一拍再淡入），之后的增量变化才渐变 */
    if (HA && HA.on) HA.on('change', (ev) => refreshLighting(!!(ev && ev.full)));
    /* 切层 / 撤销 / 改户型都会重建房间 mesh，按当前楼层重算一次亮度表 */
    window.addEventListener('ha3d:rebuilt', () => refreshLighting(false));
    /* 两个 HTML 入口各自 createPinia，但同源 localStorage：另一页切夜间 / 亮度时这边跟着变。
       编辑页例外 —— 夜间恒 false，只跟随全局亮度微调。 */
    window.addEventListener('storage', (ev) => {
      if (!ev.key || ev.key === PREF_KEYS.nightMode || ev.key === PREF_KEYS.lightLevel) {
        const n = S.editPage ? false : prefBool(PREF_KEYS.nightMode, false);
        const l = Math.max(0.2, Math.min(1, prefInt(PREF_KEYS.lightLevel, 100) / 100));
        if (n !== S.night || l !== S.level) {
          S.night = n; S.level = l;
          applyTheme();
          refreshLighting(false);
        }
      }
    });
  }
  refreshLighting(true);   // 首帧直接到位，不做淡入
}

/** 重算房间亮度并过渡；immediate=true 用于首帧。 */
export function refreshLighting(immediate) {
  const preset = S.night ? LIGHT_PRESETS.night : LIGHT_PRESETS.day;
  const next = {
    ambient: preset.ambient * S.level,
    moon: preset.moon,
    roomMin: preset.roomMin,
    rooms: computeRooms(),
  };
  if (immediate || typeof requestAnimationFrame === 'undefined') {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    S.ambient = next.ambient;
    S.moon = next.moon;
    S.roomMin = next.roomMin;
    S.rooms = next.rooms;
    writeEngine();
    return;
  }
  from = { ambient: S.ambient, moon: S.moon, roomMin: S.roomMin, rooms: Object.assign({}, S.rooms) };
  to = next;
  t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (!raf) raf = requestAnimationFrame(tick);
}

export function isNight() { return S.night; }

/** UI 开关：切夜间模式（写偏好 → 主题 → 引擎）。 */
export function setNight(v) {
  if (S.editPage) return;   // 编辑页没有夜间开关，也不接受外部切夜间
  const n = !!v;
  if (n === S.night) return;
  S.night = n;
  prefSetBool(PREF_KEYS.nightMode, n);
  applyTheme();
  refreshLighting(false);
}
