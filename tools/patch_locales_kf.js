/* 给语言包补关键帧相关文案（保持 CRLF） */
const fs = require('fs');
const path = require('path');

function patch(file, map, insertAfterKey, insertLines) {
  let s = fs.readFileSync(file, 'utf8');
  let changed = 0;
  for (const [from, to] of map) {
    if (!s.includes(from)) { console.log('  ! 未找到: ' + from); continue; }
    s = s.split(from).join(to);
    changed++;
  }
  if (insertLines && insertLines.length) {
    const anchor = insertAfterKey;
    if (s.includes(anchor)) {
      s = s.replace(anchor, anchor + '\r\n' + insertLines.join('\r\n'));
      changed++;
    } else {
      console.log('  ! 未找到锚点: ' + anchor);
    }
  }
  fs.writeFileSync(file, s, 'utf8');
  console.log('  ' + path.basename(file) + ' 改动 ' + changed + ' 处');
}

const zhMap = [
  ['"timeline.multiTween": "✨ 多选补间",', '"timeline.multiTween": "◆ 批量关键帧",'],
  ['"timeline.multiTweenTitle": "在选中的相邻帧之间逐对补间",', '"timeline.multiTweenTitle": "给选中的每一帧都打上关键帧",'],
  ['"timeline.tween": "✨ 补间",', '"timeline.insertFrames": "＋ 插 N 帧",'],
  ['"timeline.tweenTitle": "在当前帧和下一帧之间插入补间动画",', '"timeline.insertFramesTitle": "在当前段的关键帧之间插入 N 帧（只拉长段，画面由关键帧实时算出）",'],
  ['"timeline.tweenCountTitle": "补间帧数",', '"timeline.insertCountTitle": "插入帧数",']
];
const zhAdd = [
  '  "timeline.keyframe": "◆ 关键帧",',
  '  "timeline.keyframeTitle": "把当前帧设为 / 取消关键帧",'
];

const enMap = [
  ['"timeline.multiTween": "✨ Multi-tween",', '"timeline.multiTween": "◆ Key selected",'],
  ['"timeline.multiTweenTitle": "Tween each adjacent pair of selected frames",', '"timeline.multiTweenTitle": "Mark every selected frame as a keyframe",'],
  ['"timeline.tween": "✨ Tween",', '"timeline.insertFrames": "＋ Insert N",'],
  ['"timeline.tweenTitle": "Insert a tween between the current and next frame",', '"timeline.insertFramesTitle": "Insert N frames inside the current keyframe segment (the segment stretches, nothing is baked)",'],
  ['"timeline.tweenCountTitle": "Tween frame count",', '"timeline.insertCountTitle": "Frames to insert",']
];
const enAdd = [
  '  "timeline.keyframe": "◆ Keyframe",',
  '  "timeline.keyframeTitle": "Mark / unmark the current frame as a keyframe",'
];

console.log('[locales] 中文');
patch('js/locales/zh-CN.js', zhMap, '  "timeline.insertFrames": "＋ 插 N 帧",', zhAdd);
console.log('[locales] 英文');
patch('js/locales/en.js', enMap, '  "timeline.insertFrames": "＋ Insert N",', enAdd);
