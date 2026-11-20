/*
 * light — 灯具插件（kind: 'device'，type: 'light'，7 种灯型）
 * 坐标系: group 原点 = 锚点（吸顶/筒灯=天花板面，吊灯=灯罩悬挂高度，壁灯=灯体中心，落地灯/灯带=各自高度）
 * 静态: 灯体可来自 obj.model / style.model 的 GLB；无 GLB 时按灯型程序化绘制
 * 状态: entityId on/off 控制灯泡发光 + 光晕 + 点光源，rgb_color 同步光色
 * 发光方向: 按灯型区分——吸顶灯/吊灯/筒灯向下锥形扩散（吊灯灯罩开口向下）、
 *   壁灯向墙外斜下、落地灯从灯罩下口柔和向下铺开、灯带四周透光全向（见 lightKit opts.dir）
 *
 * 贴面发光: 按灯形状生成发光面（disc/rect/bar），作为灯 group 子对象跟着灯一起旋转，
 *   位置贴在灯体上、形状匹配灯型；球形光晕只做柔光氛围（见 lightKit opts.emitter）
 */
'use strict';

/* 包一层 IIFE：独立 <script> 加载的经典脚本共享全局作用域，顶层 const 重名会 SyntaxError */
(function () {

/* 造型图标: 24×24 线性 SVG（图标由插件自己提供，引擎只用 ⚙️ 兜底）。 */
const ico = PluginEngine.ico;

PluginEngine.register({
  builtin: true,
  id: 'light',
  kind: 'device',
  type: 'light',
  name: '灯',
  styles: [
    { id: 'ceiling_flat',  name: '平板吸顶灯', z: 2.78, icon: ico('<rect x="4" y="5" width="16" height="4.5" rx="1.2"/><line x1="8" y1="12.5" x2="6.5" y2="14.5" opacity=".55"/><line x1="12" y1="13.0" x2="12" y2="15.1" opacity=".55"/><line x1="16" y1="12.5" x2="17.5" y2="14.5" opacity=".55"/>') },
    { id: 'ceiling_round', name: '圆形吸顶灯', z: 2.78, icon: ico('<circle cx="12" cy="7.5" r="4.5"/><line x1="8" y1="14.5" x2="6.5" y2="16.5" opacity=".55"/><line x1="12" y1="15.0" x2="12" y2="17.1" opacity=".55"/><line x1="16" y1="14.5" x2="17.5" y2="16.5" opacity=".55"/>') },
    { id: 'downlight',     name: '筒灯/射灯',  z: 2.78, icon: ico('<circle cx="12" cy="8" r="4"/><circle cx="12" cy="8" r="1.3" fill="currentColor" stroke="none"/><line x1="8" y1="14.5" x2="6.5" y2="16.5" opacity=".55"/><line x1="12" y1="15.0" x2="12" y2="17.1" opacity=".55"/><line x1="16" y1="14.5" x2="17.5" y2="16.5" opacity=".55"/>') },
    { id: 'wall',          name: '壁灯',       z: 1.8, icon: ico('<line x1="4" y1="4" x2="4" y2="20"/><path d="M4 8 a5 5 0 0 1 0 10 z"/><line x1="10.5" y1="13" x2="14" y2="13" opacity=".55"/><line x1="10.5" y1="16" x2="13" y2="16" opacity=".55"/>') },
    { id: 'pendant',       name: '吊灯',       z: 2.25, icon: ico('<line x1="12" y1="3" x2="12" y2="8"/><path d="M7.5 8 h9 l-2 6 h-5 z"/><circle cx="12" cy="16.5" r="1.6" opacity=".7"/>') },
    { id: 'floor',         name: '落地灯',     z: 0, labelOffset: 1.75, icon: ico('<path d="M9.5 4 h5 l1.5 5.5 h-8 z"/><line x1="12" y1="9.5" x2="12" y2="19"/><line x1="8.5" y1="20" x2="15.5" y2="20"/>') },
    { id: 'strip',         name: '灯带',       z: 2.75, icon: ico('<line x1="3" y1="9" x2="21" y2="9" stroke-dasharray="3 2.4"/><line x1="5" y1="12.5" x2="6.5" y2="14.5" opacity=".55"/><line x1="10" y1="12.5" x2="11.5" y2="14.5" opacity=".55"/><line x1="15" y1="12.5" x2="16.5" y2="14.5" opacity=".55"/><line x1="19" y1="12.5" x2="20.5" y2="14.5" opacity=".55"/>') },
  ],

  fields: [],

  click: { on: 'turn_on', off: 'turn_off', label: '开 / 关' },

  stateText(st, obj, get) {
    if (!st) return '';
    if (st.state !== 'on') return PluginEngine.baseStateText(st, { off: '已关闭' });
    const b = st.attributes && st.attributes.brightness;
    return b != null ? Math.round((b / 255) * 100) + '% 亮度' : '已开启';
  },

  plan2d(c, p) {
    const ray = (r) => {
      c.lineWidth = 1.4;
      c.strokeStyle = p.accent;
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        c.beginPath();
        c.moveTo(Math.cos(a) * (r + 2), Math.sin(a) * (r + 2));
        c.lineTo(Math.cos(a) * (r + 2 + 0.06 * p.ppm), Math.sin(a) * (r + 2 + 0.06 * p.ppm));
        c.stroke();
      }
    };
    const disc = (r) => {
      p.draw(() => { c.arc(0, 0, r, 0, Math.PI * 2) });
    };
    const sid = p.style || 'ceiling_round';
    if (sid === 'ceiling_flat') {
      const s = 0.4 * p.ppm;
      p.draw(() => p.rrect(-s / 2, -s / 2, s, s, s * 0.2));
      ray(s * 0.5);
      return s * 0.71 + 0.06 * p.ppm + 2;
    }
    if (sid === 'downlight') { const r = 0.075 * p.ppm; disc(r); ray(r); return r + 0.06 * p.ppm + 2; }
    if (sid === 'wall') {
      const r = 0.12 * p.ppm;
      p.draw(() => { c.arc(0, 0, r, Math.PI, 0); c.closePath() });
      ray(r);
      return r + 0.06 * p.ppm + 2;
    }
    if (sid === 'pendant') {
      const r = 0.12 * p.ppm;
      disc(r);
      c.beginPath(); c.arc(0, 0, r * 0.25, 0, Math.PI * 2);
      c.fillStyle = p.ink; c.fill();
      ray(r);
      return r + 0.06 * p.ppm + 2;
    }
    if (sid === 'floor') {
      const r = 0.13 * p.ppm;
      disc(r);
      c.beginPath(); c.arc(0, 0, r * 0.6, 0, Math.PI * 2);
      c.lineWidth = 1.3; c.strokeStyle = p.ink; c.stroke();
      return r + 3;
    }
    if (sid === 'strip') {
      const L = 0.5 * p.ppm;
      c.beginPath();
      c.moveTo(-L / 2 + 3.2, -3.2);
      c.arcTo(L / 2, -3.2, L / 2, 3.2, 3.2);
      c.arcTo(L / 2, 3.2, -L / 2, 3.2, 3.2);
      c.arcTo(-L / 2, 3.2, -L / 2, -3.2, 3.2);
      c.arcTo(-L / 2, -3.2, L / 2, -3.2, 3.2);
      c.closePath();
      c.fillStyle = p.fill; c.fill();
      c.lineWidth = 1; c.strokeStyle = p.ink; c.stroke();
      c.setLineDash([6, 4]);
      c.lineWidth = 2.5;
      c.strokeStyle = p.accent2;
      c.beginPath(); c.moveTo(-L / 2 + 4, 0); c.lineTo(L / 2 - 4, 0); c.stroke();
      c.setLineDash([]);
      return L / 2 + 2;
    }
    const r = 0.15 * p.ppm;
    disc(r); ray(r);
    return r + 0.06 * p.ppm + 2;
  },

  async model3d(ctx) {
    const d = ctx.obj;
    const style = ctx.style || {};
    const sid = style.id || 'pendant';
    const g = new ctx.THREE.Group();
    let kit = null;
    let stripGlow = null;

    const url = d.model || style.model;
    if (url && window.THREE.GLTFLoader) {
      const proto = await ctx.view.loadModel(url);
      if (proto) {
        const inst = proto.clone(true);
        const box = new ctx.THREE.Box3().setFromObject(inst);
        const size = box.getSize(new ctx.THREE.Vector3());
        const target = d.scale || 0.5;
        const s = target / Math.max(size.x, size.y, size.z) || 1;
        inst.scale.multiplyScalar(s);
        inst.position.y = -box.min.y * s;
        g.add(inst);
      }
    }

    if (!url || !g.children.length) {
      const H = ctx.wallH;
      if (sid === 'ceiling_flat') {
        ctx.box(g, 0.6, 0.05, 0.6, 0, -0.025, 0, '#dfe4ea');
        const panelMat = ctx.lambert('#f5f7fa');
        ctx.box(g, 0.54, 0.03, 0.54, 0, -0.06, 0, 0).material = panelMat;
        kit = ctx.lightKit(g, -0.12, 0.9, {
          dir: 'down', angle: 1.05, strength: 0.85,
          emitter: { shape: 'rect', w: 0.54, h: 0.54, y: -0.075 },
        });
        kit.addMat(panelMat);
      } else if (sid === 'ceiling_round') {
        ctx.cyl(g, 0.34, 0.34, 0.04, 28, 0, -0.02, 0, '#dfe4ea');
        const domeMat = ctx.lambert('#f5f7fa');
        const dome = new ctx.THREE.Mesh(new ctx.THREE.SphereGeometry(0.3, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), domeMat);
        dome.position.y = -0.04;
        dome.rotation.x = Math.PI;
        g.add(dome);
        kit = ctx.lightKit(g, -0.14, 0.95, {
          dir: 'down', angle: 1.05, strength: 0.85,
          emitter: { shape: 'disc', w: 0.58, y: -0.055 },
        });
        kit.addMat(domeMat);
      } else if (sid === 'downlight') {
        ctx.cyl(g, 0.1, 0.1, 0.045, 20, 0, -0.02, 0, '#cfd6de');
        const innerMat = ctx.lambert('#f5f7fa');
        ctx.cyl(g, 0.075, 0.06, 0.05, 20, 0, -0.05, 0, 0).material = innerMat;
        kit = ctx.lightKit(g, -0.1, 0.45, {
          dir: 'down', angle: 0.5, dist: 4.5, strength: 1.15,
          emitter: { shape: 'disc', w: 0.15, y: -0.075 },
        });
        kit.addMat(innerMat);
      } else if (sid === 'wall') {
        const plate = ctx.cyl(g, 0.05, 0.05, 0.03, 16, 0, 0, 0.02, '#cfd6de');
        plate.rotation.x = Math.PI / 2;
        const arm = ctx.cyl(g, 0.015, 0.015, 0.12, 8, 0, 0.02, 0.09, '#9aa3ad');
        arm.rotation.x = Math.PI / 2;
        const shadeMat = ctx.lambert('#f0f2f5', { side: ctx.THREE.DoubleSide });
        const shade = new ctx.THREE.Mesh(new ctx.THREE.SphereGeometry(0.13, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), shadeMat);
        shade.position.set(0, 0.02, 0.16);
        shade.rotation.x = Math.PI;
        g.add(shade);
        kit = ctx.lightKit(g, -0.02, 0.55, {
          dir: 'wall', angle: 0.85, strength: 0.95,
          emitter: { shape: 'disc', w: 0.24, y: 0.0, extra: { z: 0.17, rx: 1.15 } },
        });
        kit.addMat(shadeMat);
        g.position.z = 0.14;
      } else if (sid === 'floor') {
        // 落地灯: 底盘 + 立杆 + 灯罩（锚点在地面）；光从灯罩下口柔和向下铺开
        ctx.cyl(g, 0.16, 0.18, 0.03, 24, 0, 0.015, 0, '#3a4048');
        ctx.cyl(g, 0.018, 0.018, 1.3, 10, 0, 0.68, 0, '#555c66');
        const shadeMat = ctx.lambert('#f0e6d4', { side: ctx.THREE.DoubleSide });
        const shade = new ctx.THREE.Mesh(new ctx.THREE.CylinderGeometry(0.14, 0.2, 0.28, 24, 1, true), shadeMat);
        shade.position.y = 1.45;
        g.add(shade);
        kit = ctx.lightKit(g, 1.31, 0.8, {
          dir: 'down', angle: 1.15, dist: 3.2, strength: 0.55,
          emitter: { shape: 'disc', w: 0.4, y: 1.31 },
          beam: { h: 1.35, r0: 0.2, r1: 0.95, opacity: 0.16 },
        });
        kit.addMat(shadeMat);
      } else if (sid === 'strip') {
        const stripMat = ctx.lambert('#f5f7fa');
        ctx.box(g, 1.2, 0.018, 0.05, 0, 0, 0, 0).material = stripMat;
        kit = ctx.lightKit(g, -0.05, 0.7, {
          dir: 'omni',
          emitter: { shape: 'bar', w: 1.2, h: 0.14, y: 0.012 },
        });
        kit.addMat(stripMat);
        /* 灯带柔光：沿长度排 7 颗小 Sprite，开灯淡入；作为 g 的子对象跟着灯一起旋转 */
        stripGlow = [];
        for (let i = 0; i < 7; i++) {
          const m = new ctx.THREE.SpriteMaterial({
            map: ctx.glowTexture(), transparent: true, opacity: 0, depthWrite: false,
            blending: ctx.THREE.AdditiveBlending, color: 0xffe3b8,
          });
          const s = new ctx.THREE.Sprite(m);
          s.position.set(-0.5 + i / 6, 0.012, 0);
          s.scale.set(0.38, 0.38, 1);
          s.renderOrder = 1;
          g.add(s);
          stripGlow.push(m);
        }
      } else {
        const cordLen = Math.max(0.1, H - (d.z != null ? d.z : style.z || 2.25));
        ctx.cyl(g, 0.012, 0.012, cordLen, 6, 0, cordLen / 2, 0, '#555555');
        const shade = new ctx.THREE.Mesh(new ctx.THREE.ConeGeometry(0.24, 0.24, 24, 1, true), ctx.lambert('#3a4048', { side: ctx.THREE.DoubleSide }));
        g.add(shade);
        kit = ctx.lightKit(g, -0.09, 0.85, {
          dir: 'down', angle: 0.95, strength: 0.9,
          emitter: { shape: 'disc', w: 0.44, y: -0.2 },
        });
      }
    } else {
      kit = ctx.lightKit(g, 0.05, 0.7, {
        dir: 'down', angle: 1.0, strength: 0.7,
        emitter: { shape: 'disc', w: 0.45, y: 0.02 },
      });
    }

    const rgb = () => {
      const st = ctx.getState(d.entityId);
      return st && st.attributes && st.attributes.rgb_color;
    };
    return {
      group: g,
      update() {
      const on = ctx.isOn(d.entityId);
      if (kit) kit.set(on, rgb());
      if (stripGlow) {
        const st = ctx.getState(d.entityId);
        const b = st && st.attributes && st.attributes.brightness;
        const lit = on ? (b != null ? 0.25 + 0.75 * (b / 255) : 1) : 0;
        const c = rgb();
        stripGlow.forEach((m) => {
          m.opacity = 0.2 * lit;
          if (on && c && c.length >= 3) {
            m.color.setRGB(0.35 + 0.65 * c[0] / 255, 0.35 + 0.65 * c[1] / 255, 0.35 + 0.65 * c[2] / 255);
          } else {
            m.color.setHex(0xffe3b8);
          }
        });
      }
    },
    };
  },
});

})();
