/* keyframes.js 数据层自测（node tools/test_keyframes.js） */
const KF = require('../js/systems/keyframes.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}
function obj(id) { return { id: id, type: 'figure', x: id * 10, y: 0 }; }
function head(t) { console.log('\n' + t); }

/* ---------- 1. 四种身份 ---------- */
head('1. 槽位身份判定');
const t1 = { name: 'A', frames: [KF.markKey(obj(1), 'main'), { id: 1 }, KF.DERIVED_SLOT, null] };
ok('关键帧', KF.kindOf(t1.frames[0]) === 'key');
ok('普通帧', KF.kindOf(t1.frames[1]) === 'plain');
ok('派生帧', KF.kindOf(t1.frames[2]) === 'derived');
ok('空白帧', KF.kindOf(t1.frames[3]) === 'blank');
ok('关键帧来源', KF.originOf(t1.frames[0]) === 'main');
ok('派生帧不是真实对象', KF.isReal(KF.DERIVED_SLOT) === false);
ok('派生帧可 JSON 往返', KF.isDerived(JSON.parse(JSON.stringify(KF.DERIVED_SLOT))));

/* ---------- 2. 验收用例 1：摆 A / 摆 B 两帧设关键帧 → 中间自动补 ---------- */
head('2. 验收 1（逐帧工程打完关键帧要能补）');
const t2 = { name: 'A', frames: [0, 1, 2, 3, 4, 5, 6].map(i => obj(1)) };
KF.markKey(t2.frames[0], 'main');
KF.markKey(t2.frames[6], 'main');
const r2 = KF.reconcileTrack(t2, { adoptPlain: true });
ok('接管 5 个普通帧', r2.adopted.length === 5, r2.adopted);
ok('2-6 全为派生', [1, 2, 3, 4, 5].every(i => KF.kindOf(t2.frames[i]) === 'derived'));
const loc = KF.locate(t2.frames, 3);
ok('第 4 帧定位到段 K1→K7', loc.kind === 'derived' && loc.a === 0 && loc.b === 6, loc);
ok('u = 3/6', Math.abs(loc.u - 0.5) < 1e-9, loc.u);
ok('派生帧数 5（不可自定义）', KF.derivedCount(t2.frames, { a: 0, b: 6 }) === 5);

/* ---------- 3. 段内的空白帧被插值填满 ---------- */
head('3. 段内空白被插值填满');
const t3 = { name: 'B', frames: [obj(2), null, null, null, obj(2), null, null] };
KF.markKey(t3.frames[0], 'sub');
KF.markKey(t3.frames[4], 'sub');
const r3 = KF.reconcileTrack(t3, { adoptPlain: true });
ok('段成立', KF.segments(t3.frames).length === 1);
ok('中间 3 个空白被接管', r3.adopted.join(',') === '1,2,3', r3.adopted);
ok('接管后是派生帧', [1, 2, 3].every(i => KF.kindOf(t3.frames[i]) === 'derived'));
ok('第 3 帧定位到段 K1→K5', (() => { const l = KF.locate(t3.frames, 2); return l.kind === 'derived' && l.a === 0 && l.b === 4 && Math.abs(l.u - 0.5) < 1e-9; })());
ok('段后的空白仍是空白', KF.kindOf(t3.frames[5]) === 'blank' && KF.kindOf(t3.frames[6]) === 'blank');
ok('段后的空白不渲染', KF.locate(t3.frames, 5).kind === 'blank');

/* ---------- 4. 「有缺口就不是一段」：关键帧不成对就没有段 ---------- */
head('4. 关键帧不成对就没有段');
const t4 = { name: 'C', frames: [obj(3), obj(3), KF.markKey(obj(3), 'sub'), obj(3), obj(3)] };
ok('单端关键帧 → 零个段', KF.segments(t4.frames).length === 0);
ok('单端关键帧前仍是普通帧', KF.locate(t4.frames, 1).kind === 'plain');
ok('单端关键帧后仍是普通帧', KF.locate(t4.frames, 4).kind === 'plain');
const t4b = { name: 'C2', frames: [obj(3), obj(3), obj(3), obj(3), obj(3)] };
[0, 2, 4].forEach(i => KF.markKey(t4b.frames[i], 'sub'));
KF.reconcileTrack(t4b, { adoptPlain: true });
const segs4 = KF.segments(t4b.frames);
ok('三个关键帧 → 两段', segs4.length === 2, segs4);
ok('段 1 = K1→K3', segs4[0].a === 0 && segs4[0].b === 2);
ok('段 2 = K3→K5', segs4[1].a === 2 && segs4[1].b === 4);
ok('折返点 K3 本身不受插值', KF.locate(t4b.frames, 2).kind === 'key');

/* ---------- 5. 悬空派生帧退回空白 ---------- */
head('5. 悬空派生帧');
const t5 = { name: 'D', frames: [KF.DERIVED_SLOT, KF.DERIVED_SLOT, KF.markKey(obj(4), 'sub'), KF.DERIVED_SLOT] };
const r5 = KF.reconcileTrack(t5);
ok('段外的派生退回空白', r5.dropped.length === 3, r5.dropped);
ok('三处派生都变空白', t5.frames[0] === null && t5.frames[1] === null && t5.frames[3] === null);
ok('关键帧本身不动', KF.isKey(t5.frames[2]));
ok('孤立派生定位为 orphan', KF.locate([KF.DERIVED_SLOT], 0).kind === 'orphan');

/* ---------- 6. 相邻关键帧（间距 1）是合法退化段 ---------- */
head('6. 间距为 1 的退化段');
const t6 = { name: 'E', frames: [KF.markKey(obj(5), 'sub'), KF.markKey(obj(5), 'sub')] };
ok('段成立', KF.segments(t6.frames).length === 1);
ok('派生帧数 0', KF.derivedCount(t6.frames, { a: 0, b: 1 }) === 0);

/* ---------- 7. 标记随对象走：插帧 / 拖拽排序 / 复制 ---------- */
head('7. 标记跟随槽位（不需要下标重映射）');
const t7 = { name: 'F', frames: [KF.markKey(obj(6), 'sub'), null, null, obj(6)] };
KF.markKey(t7.frames[3], 'sub');
t7.frames.splice(1, 0, null);          /* 在段内插入一帧 */
ok('插帧后关键帧帧号平移', KF.keyIndices(t7.frames).join(',') === '0,4');
const moved = t7.frames.splice(0, 1)[0];   /* 把 K1 拖到末尾 */
t7.frames.push(moved);
ok('拖拽后标记仍在', KF.isKey(t7.frames[t7.frames.length - 1]));
ok('原来的位置不再是关键帧', !KF.isKey(t7.frames[0]));

/* ---------- 8. 选区 → 段 ---------- */
head('8. 选区定位整段（D4）');
const t8 = { name: 'G', frames: [obj(7), obj(7), obj(7), obj(7), obj(7), obj(7), obj(7)] };
[0, 6].forEach(i => KF.markKey(t8.frames[i], 'main'));
KF.reconcileTrack(t8, { adoptPlain: true });
const hit = KF.segmentsForRange(t8.frames, 0, 5);   /* 验收 2：选 1-6，K7 在选区外 */
ok('选中 1-6 命中 K1→K7', hit.length === 1 && hit[0].b === 6, hit);
const exp = KF.expandRangeToSegments(t8.frames, 4, 5);
ok('整段高亮范围 = 0..6', exp.from === 0 && exp.to === 6, exp);
ok('点关键帧本身也能定位该段', KF.segmentsForRange(t8.frames, 0, 0).length === 1);

/* ---------- 9. 只打一个端点 → 没有段 ---------- */
head('9. 单端关键帧不产生段');
const t9 = { name: 'H', frames: [obj(8), obj(8), KF.markKey(obj(8), 'sub'), obj(8)] };
ok('无段', KF.segments(t9.frames).length === 0);
ok('第 4 帧仍是普通帧', KF.locate(t9.frames, 3).kind === 'plain');

/* ---------- 10. 曲线 / 来源挂在对象上 ---------- */
head('10. 段曲线与来源');
const t10 = { name: 'I', frames: [KF.markKey(obj(9), 'main'), KF.DERIVED_SLOT, KF.markKey(obj(9), 'main')] };
KF.setCurve(t10.frames[0], { ease: 'easeInOut', ch: { x: 'linear' } });
ok('曲线存得住', KF.curveOf(t10.frames[0]).ease === 'easeInOut');
ok('来源是 main', KF.originOf(t10.frames[0]) === 'main');
const copied = KF.stripFrameMarks(t10.frames[0]);
ok('新建对象不带标记', !copied[KF.KEY] && copied.id === 9);
ok('撤销快照能带上标记', KF.isKey(JSON.parse(JSON.stringify(t10.frames[0]))));

/* ---------- 11-16. 单对象插值 ---------- */
function fig(id, o) {
  o = o || {};
  return {
    id: id, type: 'figure', x: o.x || 0, y: o.y || 0,
    scale: o.scale == null ? 1 : o.scale, rot: o.rot || 0, alpha: 1,
    color: '#111111', headAngle: 0, headShape: o.headShape || 'circle',
    bodyScale: { head: 1, arm: 1, leg: 1, torso: 1, foreArm: 1, shin: 1 },
    a: { torso: 0, waist: 0, armL: { u: 0, f: 0 }, armR: { u: 0, f: 0 }, legL: { u: 0, f: 0 }, legR: { u: 0, f: 0 } },
    ikEnabled: false, pinned: {}, pinnedPos: {},
    light: { color: '#ff0000' }, glow: { color: '#00ff00' }, joint: { color: '#0000ff' },
    depth: { enabled: false, useCustom: false, customColor: '#000000' },
    hidden: false, mirror: false, extremity: { enabled: false }
  };
}

head('11. 单对象插值');
const A = fig(1, { x: 0, y: 0 }), B = fig(1, { x: 100, y: 200 });
const mid = KF.interpolateObject(A, B, 0.5, {});
ok('位置中点', mid.x === 50 && mid.y === 100, [mid.x, mid.y]);
ok('结果不带 __k', !mid[KF.KEY]);
ok('原对象未被改动', A.x === 0 && A.y === 0);

head('12. 旋转保留多圈（禁止最短弧归一化）');
const rm = KF.interpolateObject(fig(2, { rot: 0 }), fig(2, { rot: -4 * Math.PI }), 0.5, {});
ok('0 → -720° 的中点是 -360°', Math.abs(rm.rot + 2 * Math.PI) < 1e-9, rm.rot);

head('13. 缩放对数插值');
ok('1 → 4 的中点是 2（不是 2.5）', Math.abs(KF.interpolateObject(fig(3, { scale: 1 }), fig(3, { scale: 4 }), 0.5, {}).scale - 2) < 1e-9);
ok('一端为 0 时退回线性', KF.interpolateObject(fig(3, { scale: 0 }), fig(3, { scale: 4 }), 0.5, {}).scale === 2);

head('14. 离散属性 hold：段内取起点，末端才切换（D6）');
const H1 = fig(4, { headShape: 'Vic' }), H2 = fig(4, { headShape: 'TSC' });
H2.mirror = true; H2.depth.enabled = true; H2.ikEnabled = true;
const hm = KF.interpolateObject(H1, H2, 0.9, {});
ok('头型 hold 起点', hm.headShape === 'Vic', hm.headShape);
ok('镜像 hold 起点', hm.mirror === false);
ok('深度开关 hold 起点', hm.depth.enabled === false);
ok('IK 开关 hold 起点', hm.ikEnabled === false);
ok('末端关键帧本身是新值', H2.headShape === 'TSC');

head('15. 缓动与通道缓动');
ok('全局缓动作用于位置', Math.abs(KF.interpolateObject(fig(5, { x: 0 }), fig(5, { x: 100 }), 0.5, { ease: u => u * u }).x - 25) < 1e-9);
ok('通道缓动能覆盖全局', Math.abs(KF.interpolateObject(fig(6, { x: 0 }), fig(6, { x: 100 }), 0.5, { ease: u => u, partEase: (p, tt) => (p === 'x' ? 1 : tt) }).x - 100) < 1e-9);
const w = KF.interpolateObject(fig(6, { x: 0 }), fig(6, { x: 100 }), 0, {});
ok('端点 u=0 即起点', w.x === 0);

head('16. evaluateTrack 求值入口');
const tk = { frames: [KF.markKey(fig(7, { x: 0 }), 'sub'), KF.DERIVED_SLOT, KF.markKey(fig(7, { x: 100 }), 'sub')] };
ok('段内求值', Math.abs(KF.evaluateTrack(tk, 1, {}).x - 50) < 1e-9);
ok('关键帧原样返回', KF.evaluateTrack(tk, 0, {}) === tk.frames[0]);
ok('空白返回 null', KF.evaluateTrack({ frames: [null] }, 0, {}) === null);
ok('越界返回 null', KF.evaluateTrack(tk, 9, {}) === null);
ok('永不返回哨兵', KF.evaluateTrack({ frames: [KF.DERIVED_SLOT] }, 0, {}) === null);

head('结果');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
