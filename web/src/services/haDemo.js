/*
 * services/haDemo.js — 演示模式模拟器（审计 3.13 从 services/ha.js 拆出）。
 * 未配置 HA（服务端 4400 关闭）或令牌无效时，HA 客户端进入演示模式：
 * 填充一套假实体 + 定时漂移制造「实时」感，并按域模拟服务调用反馈。
 *
 * 全部函数以 HA 客户端单例为第一参数（依赖 entities Map / setStatus / stopHeartbeat /
 * emit / demo 标志），不持有自己的状态 —— demoTimer 挂在 HA 上，随 close() 一并清理。
 */

/* 演示模式启动：填假实体 + 3s 漂移定时器 */
export function startDemo(HA) {
  if (HA.demo) return;
  HA.demo = true;
  HA._reconnecting = false;
  HA.stopHeartbeat();
  HA.setStatus('demo');
  const mk = (eid, state, attrs, domain) => ({ entity_id: eid, state, attributes: Object.assign({ friendly_name: eid.split('.')[1].replace(/_/g, ' ') }, attrs), demo: true, domain });
  const demoEntities = [
    mk('light.living', 'on', { friendly_name: '客厅 吸顶灯', brightness: 180, brightness_pct: 71, color_temp_kelvin: 3000, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 }, 'light'),
    mk('light.living_ambient', 'off', { friendly_name: '客厅 氛围灯', brightness: 0, brightness_pct: 0, color_temp_kelvin: 2700, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 }, 'light'),
    mk('light.master', 'on', { friendly_name: '卧室 主灯', brightness: 220, brightness_pct: 86, color_temp_kelvin: 4000, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 }, 'light'),
    mk('light.kitchen', 'off', { friendly_name: '厨房 灯', brightness: 0, brightness_pct: 0, color_temp_kelvin: 5000, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 }, 'light'),
    mk('light.study', 'off', { friendly_name: '书房 灯', brightness: 0, brightness_pct: 0, color_temp_kelvin: 4500, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 }, 'light'),
    mk('light.hall', 'on', { friendly_name: '楼道 灯', brightness: 120, brightness_pct: 47, color_temp_kelvin: 3000, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 }, 'light'),
    mk('switch.ac_plug', 'on', { friendly_name: '空调插座' }, 'switch'),
    mk('switch.tv_plug', 'off', { friendly_name: '电视插座' }, 'switch'),
    /* 卡片用：气候 / 风扇 / 热水器必须有属性，否则 range 取不到 attr: 边界会直接不渲染 */
    mk('climate.living', 'cool', {
      friendly_name: '客厅 空调', temperature: 24, current_temperature: 26.5,
      min_temp: 16, max_temp: 30, temperature_step: 0.5,
      hvac_modes: ['off', 'cool', 'heat', 'dry', 'fan_only', 'auto'], hvac_mode: 'cool',
      fan_modes: ['auto', 'low', 'medium', 'high'], fan_mode: 'auto',
    }, 'climate'),
    mk('fan.bedroom', 'on', {
      friendly_name: '卧室 风扇', percentage: 60, percentage_step: 10, oscillating: false,
    }, 'fan'),
    mk('water_heater.boiler', 'eco', {
      friendly_name: '阳台 热水器', temperature: 50, current_temperature: 48,
      min_temp: 30, max_temp: 75, operation_mode: 'eco',
    }, 'water_heater'),
    mk('sensor.living_temp', '24.5', { friendly_name: '客厅 温度', unit_of_measurement: '°C' }, 'sensor'),
    mk('sensor.living_hum', '56', { friendly_name: '客厅 湿度', unit_of_measurement: '%' }, 'sensor'),
    mk('sensor.outdoor_temp', '18.2', { friendly_name: '室外 温度', unit_of_measurement: '°C' }, 'sensor'),
    mk('sensor.outdoor_hum', '62', { friendly_name: '室外 湿度', unit_of_measurement: '%' }, 'sensor'),
    mk('sensor.power', '860', { friendly_name: '全家 功率', unit_of_measurement: 'W' }, 'sensor'),
    mk('sensor.pm25', '23', { friendly_name: 'PM2.5', unit_of_measurement: 'µg/m³' }, 'sensor'),
    mk('weather.home', 'partlycloudy', { friendly_name: '天气', temperature: 18, humidity: 62 }, 'weather'),
    mk('cover.curtain_living', 'open', { friendly_name: '客厅 窗帘', current_position: 70, supported_features: 15 }, 'cover'),
    mk('vacuum.robot', 'docked', { friendly_name: '扫地机器人', battery_level: 82 }, 'vacuum'),
    mk('scene.good_morning', 'off', { friendly_name: '晨起模式' }, 'scene'),
    mk('scene.movie_night', 'off', { friendly_name: '观影模式' }, 'scene'),
    mk('scene.away', 'off', { friendly_name: '离家模式' }, 'scene'),
    mk('scene.sleep', 'off', { friendly_name: '睡眠模式' }, 'scene'),
    mk('automation.auto_light', 'on', { friendly_name: '人来灯亮' }, 'automation'),
    mk('automation.night_off', 'on', { friendly_name: '深夜熄灯' }, 'automation'),
  ];
  demoEntities.forEach((s) => HA.entities.set(s.entity_id, s));
  HA.emit('change', { full: true });
  HA.demoTimer = setInterval(() => {
    // 温湿度缓慢波动，制造“实时”感
    const drift = (eid, base, amp, dec) => {
      const e = HA.entities.get(eid);
      if (!e) return;
      const v = parseFloat(e.state) || base;
      const nv = Math.max(base - amp, Math.min(base + amp, v + (Math.random() - 0.5) * amp / 8));
      e.state = nv.toFixed(dec);
    };
    drift('sensor.living_temp', 24.5, 2, 1);
    drift('sensor.living_hum', 56, 8, 0);
    drift('sensor.outdoor_temp', 18.2, 3, 1);
    drift('sensor.power', 860, 300, 0);
    HA.emit('change', { demo: true });
  }, 3000);
}

export function stopDemo(HA) {
  HA.demo = false;
  if (HA.demoTimer) { clearInterval(HA.demoTimer); HA.demoTimer = null; }
}

/* 演示模式的「服务调用」：必须吃 service_data，否则卡片上的滑块/下拉点了没有任何反馈，
 * 而本项目所有卡片验证都跑在演示模式 + 无头 Edge 里。 */
export function demoCall(HA, domain, service, target, data) {
  const eid = target && target.entity_id;
  const d = data || {};
  const e = eid && HA.entities.get(eid);

  if (e) {
    const a = e.attributes;
    const on = () => { e.state = 'on'; };
    const off = () => { e.state = 'off'; };

    if (domain === 'light') {
      if (service === 'toggle') e.state = e.state === 'on' ? 'off' : 'on';
      else if (service === 'turn_on') {
        on();
        if (d.brightness_pct != null) {
          a.brightness_pct = Math.round(d.brightness_pct);
          a.brightness = Math.round(d.brightness_pct * 255 / 100);
        }
        if (d.brightness != null) {
          a.brightness = Math.round(d.brightness);
          a.brightness_pct = Math.round(d.brightness / 255 * 100);
        }
        if (d.color_temp_kelvin != null) a.color_temp_kelvin = Math.round(d.color_temp_kelvin);
      } else if (service === 'turn_off') {
        off(); a.brightness_pct = 0; a.brightness = 0;
      }
    } else if (domain === 'switch' || domain === 'fan' || domain === 'input_boolean') {
      if (service === 'toggle') e.state = e.state === 'on' ? 'off' : 'on';
      else if (service === 'turn_on') on();
      else if (service === 'turn_off') off();
      if (service === 'set_percentage' && d.percentage != null) {
        a.percentage = Math.round(d.percentage);
        e.state = d.percentage > 0 ? 'on' : 'off';
      }
      if (service === 'set_speed' && d.speed != null) { a.speed = d.speed; on(); }
      if (service === 'oscillate' && d.oscillating != null) a.oscillating = !!d.oscillating;
    } else if (domain === 'climate') {
      if (service === 'turn_on') e.state = a.hvac_mode && a.hvac_mode !== 'off' ? a.hvac_mode : 'auto';
      else if (service === 'turn_off') { off(); a.hvac_mode = 'off'; }
      else if (service === 'toggle') e.state = e.state === 'off' ? (a.hvac_mode === 'off' ? 'auto' : a.hvac_mode) : 'off';
      if (service === 'set_temperature' && d.temperature != null) {
        a.temperature = d.temperature;
        if (e.state === 'off') { a.hvac_mode = 'heat'; e.state = 'heat'; }
      }
      if (service === 'set_hvac_mode' && d.hvac_mode) { a.hvac_mode = d.hvac_mode; e.state = d.hvac_mode; }
      if (service === 'set_fan_mode' && d.fan_mode) a.fan_mode = d.fan_mode;
    } else if (domain === 'cover') {
      if (service === 'open_cover') { e.state = 'open'; a.current_position = 100; }
      else if (service === 'close_cover') { e.state = 'closed'; a.current_position = 0; }
      else if (service === 'toggle') {
        const opened = e.state === 'open';
        e.state = opened ? 'closed' : 'open';
        a.current_position = opened ? 0 : 100;
      }
      if (service === 'set_cover_position' && d.position != null) {
        a.current_position = Math.round(d.position);
        e.state = d.position > 0 ? 'open' : 'closed';
      }
    } else if (domain === 'water_heater') {
      if (service === 'turn_on') e.state = a.operation_mode && a.operation_mode !== 'off' ? a.operation_mode : 'eco';
      else if (service === 'turn_off') { off(); a.operation_mode = 'off'; }
      if (service === 'set_temperature' && d.temperature != null) a.temperature = d.temperature;
      if (service === 'set_operation_mode' && d.operation_mode) { a.operation_mode = d.operation_mode; e.state = d.operation_mode; }
    } else if (domain === 'media_player') {
      if (service === 'volume_set' && d.volume_level != null) a.volume_level = d.volume_level;
      if (service === 'media_play') e.state = 'playing';
      if (service === 'media_pause') e.state = 'paused';
    }

    HA.emit('change', { entity_id: eid, state: e });
    return Promise.resolve({ demo: true });
  }

  /* 场景 / 自动化：没有单实体 target，按名字批量改灯 */
  if (domain === 'scene') {
    const off = /away|sleep|night/.test(eid || '');
    HA.entities.forEach((s, id) => {
      if (/^light\./.test(id)) { s.state = off ? 'off' : 'on'; }
    });
    HA.emit('change', { demo: true, full: true });
  } else if (domain === 'automation') {
    HA.entities.forEach((s, id) => {
      if (/^light\.hall/.test(id)) s.state = s.state === 'on' ? 'off' : 'on';
    });
    HA.emit('change', { demo: true });
  }
  return Promise.resolve({ demo: true });
}
