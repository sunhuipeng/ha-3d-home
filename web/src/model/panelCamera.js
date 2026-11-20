/**
 * 面板取景数学 —— 纯函数（零 Vue / DOM / THREE / window），可在 Node 里单测（阶段 0）。
 *
 * 3D 画布铺满整页、尺寸恒定；「可视区」是白纸羽化层之上还露着的那条带：
 * 宽屏 = 左列（右侧竖栏占掉），窄屏 = 场景列表以上的整块显示区域。
 * 这里只算数值（版面规格、视锥偏移、包围盒完整可见所需的视距与缩放系数），
 * THREE 向量 / camera.setViewOffset 等副作用仍留在 PanelApp.vue 里。
 *
 * 公式从原 methods 逐字搬来，取景参数经过多轮实测定稿，未改任何口径。
 */
import {
  WIDE_BREAKPOINT, RIGHT_PANEL_W, RIGHT_PANEL_GAP, CONTENT_MIN_W,
  STAGE_BAND_INIT, STAGE_MIN_RATIO,
} from './stageLayout.js';

/* 压缩程度 0(初始) → 1(最矮)。用占比算而不是拿实测高度算，
   避免 DOM 的 padding/gap 让最矮状态永远到不了 1。 */
export function squeezeOf(band, minBand, wide) {
  if (wide) return 0;
  return Math.min(1, Math.max(0, (STAGE_BAND_INIT - band) / Math.max(0.001, STAGE_BAND_INIT - minBand)));
}

/**
 * stageMetrics 的纯计算部分：所有输入由调用方实测 / 缓存后传入
 *   W/H        视口宽高
 *   visibleH   窄屏显示区域实测高度（宽屏传 H）
 *   stageFrac  当前 3D 带占屏比（null 用初始值）
 *   stageMin   最矮高度（null 用 H * STAGE_MIN_RATIO）
 *   defaultDist 默认机位距离（DEFAULT_CAM.dist）
 */
export function stageMetricsOf({ W, H, stageFrac, stageMin, visibleH, defaultDist }) {
  const wide = W >= WIDE_BREAKPOINT;
  const contentW = wide ? Math.max(CONTENT_MIN_W, W - RIGHT_PANEL_W - RIGHT_PANEL_GAP) : W;
  const contentH = visibleH;
  const minH = stageMin || Math.round(H * STAGE_MIN_RATIO);
  const minBand = minH / H;
  const band = stageFrac != null ? stageFrac : STAGE_BAND_INIT;
  const squeeze = squeezeOf(band, minBand, wide);
  return {
    W, H, wide, contentW, contentH, squeeze,
    cx: wide ? contentW / 2 : W / 2,                    // 可视区中心的页面横坐标
    cy: wide ? H / 2 : contentH / 2,                    // 剩余可视区中心（相对画布顶）
    /* 画布比剩余可视区高 → 同比拉远，房子在可视区里的像素尺寸才不虚胖 */
    dist: defaultDist * (H / contentH) * (wide ? 1.18 : 1.12),
  };
}

/* 把「画面中心」挪到可视区中心所需的 view offset 像素偏移。
   fitDy = 包围盒投影重心相对画布中心的透视修正（由平滑器逐帧逼近）。 */
export function viewOffsetOf(m, fitDy) {
  return {
    dx: Math.round(m.cx - m.W / 2),                     // 画面要右移多少像素
    dy: Math.round(m.cy - m.H / 2) + (fitDy || 0),
  };
}

/* 完整显示优先：分别算「按宽度填满」「按高度填满」各自的缩放系数，
   取较大的那个（谁紧谁定大小），另一个方向自然留白。 */
export function fitScaleOf(probe, m, fill) {
  return Math.max(probe.w / (m.contentW * fill), probe.h / (m.contentH * fill));
}

/**
 * 把 box 完整塞进「可视区」所需的相机距离。
 *   hw/hh/hd  包围盒 8 个角投影到屏幕基向量后的半宽/半高/半深（THREE 侧算好传入）
 *   fov        相机竖直视场角（度）
 *   contentW/contentH 可视区宽高；canvasH 画布高（像素等比换算）
 *   fill       目标占可视区比例；depthK 深度补偿系数（默认 0.6）
 */
export function fitDistanceOf({ hw, hh, hd, fov, contentW, contentH, canvasH, fill, depthK }) {
  const f = fill || 0.9;
  const tan = Math.tan((fov * Math.PI) / 360);
  const tanV = tan * (contentH / canvasH);      // 可视区在竖直方向的半角正切
  const tanH = tan * (contentW / canvasH);      // 水平方向（像素等比，与画布同高换算）
  /* depthK：把「深度方向的一半」补偿进视距。房子是扁平的，用 0.6 就够（全深度会推太远、显小）；
     房间是近大远小的透视盒，0.6 会算近、下沿被裁，用更大系数。 */
  const k = depthK == null ? 0.6 : depthK;
  return Math.max(hw / (tanH * f), hh / (tanV * f)) + hd * k;
}

/* 8 个 NDC 角点 → 屏幕包围盒（宽高 + 中心）。
   probeBox 用「实测投影」迭代，避开解析式在宽屏左列 / 窄屏上带两种比例下的误差。 */
export function screenBoundsOf(points, W, H) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const p of points) {
    const sx = (p.x * 0.5 + 0.5) * W, sy = (-p.y * 0.5 + 0.5) * H;
    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
    y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
  }
  return { w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}
