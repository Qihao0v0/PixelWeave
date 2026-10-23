import { tools } from './types';
export const template = `
<div class="ie" tabindex="-1">
  <header class="ie-header">
    <button data-action="new">新建</button><button data-action="import">导入</button>
    <input data-el="files" type="file" accept="image/*" multiple hidden>
    <button data-action="undo" title="撤销 (Ctrl+Z / ⌘Z)" aria-keyshortcuts="Control+Z Meta+Z">撤销</button><button data-action="redo" title="重做 (Ctrl+Shift+Z / Ctrl+Y / ⌘⇧Z)" aria-keyshortcuts="Control+Shift+Z Control+Y Meta+Shift+Z">重做</button>
    <button data-action="size">画布尺寸</button><button data-action="export">导出</button>
    <span data-el="status" role="status" aria-live="polite"></span>
    <button data-action="dismiss" hidden>关闭提示</button>
  </header>
  <nav class="ie-tools" aria-label="工具">${tools.map(([id, name, key]) => `<button data-tool="${id}" title="${name} (${key})" aria-pressed="false">${name}</button>`).join('')}</nav>
  <section class="ie-options" aria-label="工具参数">
    <label data-for="selection">模式 <select data-option="mode"><option value="replace">新建</option><option value="add">增选</option><option value="subtract">减选</option><option value="intersect">交集</option></select></label>
    <label data-for="radius">笔径 <input data-option="radius" type="range" min="1" max="200" value="24"><output data-value="radius">24</output></label>
    <label data-for="tolerance">容差 <input data-option="tolerance" type="range" min="0" max="255" value="32"><output data-value="tolerance">32</output></label>
    <label data-for="paint">笔画 <select data-option="paint"><option value="add">保留</option><option value="subtract">移除</option></select></label>
    <label data-for="refine">边缘范围 <input data-option="edge" type="range" min="1" max="32" value="4"><output data-value="edge">4</output></label>
    <button data-action="refine" data-for="refine">计算细化</button>
    <label data-for="move"><input data-option="proportional" type="checkbox" checked>等比例</label>
    <label data-for="magnify"><input data-option="magnify" type="checkbox" checked>局部放大</label>
    <button data-action="model-enable" data-for="model">启用模型</button><button data-action="model-disable" data-for="model" hidden>关闭模型</button>
    <button data-action="model-clear" data-for="model">清理模型缓存</button>
  </section>
  <div class="ie-stage" data-el="stage">
    <canvas data-el="canvas" tabindex="0" aria-label="图片编辑画布"></canvas>
    <svg data-el="brush-cursor" class="ie-brush-cursor" hidden aria-hidden="true"><g fill="none"><ellipse stroke="#000" stroke-width="3"/><ellipse stroke="#fff" stroke-width="1"/></g></svg>
    <canvas data-el="magnifier" class="ie-magnifier" width="140" height="140" hidden aria-label="局部放大预览"></canvas>
    <div class="ie-task-actions" data-el="task-actions" hidden><button data-action="apply" hidden>确认</button><button data-action="cancel" hidden>取消</button></div>
  </div>
  <aside class="ie-side" aria-label="图层与选区">
    <div class="ie-controls-panel" aria-label="图层控制">
    <section class="ie-selection">
      <button data-action="all">全选</button><button data-action="inverse">反选</button><button data-action="deselect">取消选择</button>
      <button data-action="copy">拷贝到新图层</button><button data-action="cut">剪切到新图层</button>
      <button data-action="mask-from">选区转蒙版</button><button data-action="mask-selection">蒙版转选区</button>
    </section>
    <section class="ie-properties" aria-label="当前图层参数">
      <label>X <input data-transform="x" type="number" step="1"></label><label>Y <input data-transform="y" type="number" step="1"></label>
      <label>宽 <input data-transform="width" type="number" min="1" step="1"></label><label>高 <input data-transform="height" type="number" min="1" step="1"></label>
      <label>角度 <input data-transform="angle" type="number" step="1"></label>
      <label>不透明度 <input data-transform="opacity" type="number" min="0" max="100" step="1"></label>
      <button data-action="flip-x">水平翻转</button><button data-action="flip-y">垂直翻转</button>
      <button data-action="mask-toggle">停用蒙版</button><button data-action="mask-remove">删除蒙版</button>
    </section>
    </div>
    <div class="ie-layer-panel" aria-label="图层">
    <div class="ie-layer-actions"><button data-action="up">上移</button><button data-action="down">下移</button><button data-action="duplicate">复制图层</button><button data-action="delete">删除</button><button data-action="merge-down">向下合并</button><button data-action="merge-visible">合并可见图层</button></div>
    <ol class="ie-layers" data-el="layers" aria-label="图层列表"></ol>
    </div>
  </aside>
  <footer class="ie-footer">
    <button data-action="zoom-out" aria-label="缩小">−</button>
    <label>缩放 <input data-option="zoom" type="number" min="1" max="3200" value="100">%</label>
    <button data-action="zoom-in" aria-label="放大">＋</button><button data-action="fit">适应</button>
    <label>背景 <select data-option="background"><option value="transparent">透明</option><option value="#ffffff">白</option><option value="#000000">黑</option><option value="#808080">灰</option></select></label>
    <output data-el="dimensions"></output>
    <span class="ie-mobile-panels"><button data-action="controls" aria-expanded="false">图层控制</button><button data-action="layers" aria-expanded="false">图层</button></span>
  </footer>
  <dialog data-el="dialog"><form method="dialog" data-el="dialog-form"></form></dialog>
</div>`;
