import { template } from './ui';
import { canvas, Renderer } from './render';
import { emptyDocument, History, mergeTargets, newLayer, replaceMergedLayers, selectionToLayer, snapshot, type MergeMode } from './document';
import { combineMasks, localToWorld, polygonMask, stroke, worldToLocal } from './geometry';
import { Storage } from './storage';
import { tools, type AlgorithmInput, type AlgorithmOutput, type Asset, type Combine, type DocumentState, type Layer, type Point, type Tool, type Transform, type View } from './types';

interface Task { before: DocumentState; tool: Tool; seed?: Point; modeOverride?: Combine; base?: Uint8Array | null; candidate?: Uint8Array; points: Point[]; labels: number[]; crop?: { x: number; y: number; width: number; height: number } }
interface Gesture {
  start: Point; screen: Point; last: Point; points: Point[]; transform?: Transform;
  handle: number; anchor?: Point; initialSelection?: Uint8Array | null; initialMask?: Uint8Array | null;
  initialConstraints?: Uint8Array | null; initialMaskEnabled?: boolean; createdTask: boolean; mode: Combine; pan: boolean; lastCompute: number; paintMask?: Uint8Array;
}
export interface MountOptions { storageKey?: string; assetBaseURL?: string }
export function mountEditor(root: HTMLElement, options: MountOptions = {}): { destroy(): Promise<void> } {
  const editor = new Editor(root, options); return { destroy: () => editor.destroy() };
}

class Editor {
  private el: HTMLElement;
  private surface: HTMLCanvasElement;
  private stage: HTMLElement;
  private status: HTMLElement;
  private assets = new Map<string, Asset>();
  private renderer = new Renderer(this.assets);
  private doc = emptyDocument();
  private view: View = { zoom: 1, x: 0, y: 0, background: 'transparent' };
  private history = new History();
  private storage: Storage;
  private tool: Tool = 'move';
  private task: Task | null = null;
  private gesture: Gesture | null = null;
  private pointers = new Map<number, Point>();
  private pinch: { distance: number; zoom: number; world: Point } | null = null;
  private abort = new AbortController();
  private resizeObserver: ResizeObserver;
  private stageSize: { width: number; height: number } | null = null;
  private worker: Worker | null = null;
  private model: Worker | null = null;
  private modelReady = false;
  private modelLoading = false;
  private callbacks = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; worker: Worker }>();
  private counter = 0;
  private version = 0;
  private request = 0;
  private operations = new Set<number>();
  private get busy(): boolean { return !!this.colorTimer || this.operations.has(this.request); }
  private importing = false;
  private merging = false;
  private get fileBusy(): boolean { return this.importing || this.merging; }
  private exporting = false;
  private destroyed = false;
  private ready = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveChain = Promise.resolve();
  private needsSave = false;
  private frame = 0;
  private space = false;
  private previewPath: Point[] = [];
  private brushPoint: Point | null = null;
  private colorTimer: ReturnType<typeof setTimeout> | null = null;
  private errorVisible = false;
  private assetBase: URL;

  constructor(private root: HTMLElement, options: MountOptions) {
    this.assetBase = new URL(options.assetBaseURL ?? import.meta.env.BASE_URL, location.href);
    root.classList.add('ie-host'); root.innerHTML = template; this.el = root.querySelector('.ie')!;
    this.surface = this.get('canvas'); this.stage = this.get('stage'); this.status = this.get('status');
    this.storage = new Storage(options.storageKey);
    const signal = this.abort.signal;
    this.el.addEventListener('click', event => this.click(event), { signal });
    this.el.addEventListener('change', event => this.change(event), { signal });
    this.el.addEventListener('input', event => this.input(event), { signal });
    this.el.addEventListener('focusin', event => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-layer]');
      if (row && !this.task && !this.fileBusy && row.dataset.layer !== this.doc.active) { this.doc.active = row.dataset.layer!; this.refresh(false); this.scheduleSave(); }
    }, { signal });
    this.surface.addEventListener('pointerdown', e => this.pointerDown(e), { signal });
    this.surface.addEventListener('pointermove', e => this.pointerMove(e), { signal });
    this.surface.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch' && !this.gesture) { this.brushPoint = null; this.updateBrushCursor(); } }, { signal });
    this.surface.addEventListener('pointerup', e => this.pointerUp(e), { signal });
    this.surface.addEventListener('pointercancel', () => this.cancelGesture(), { signal });
    this.surface.addEventListener('wheel', e => this.wheel(e), { passive: false, signal });
    this.el.addEventListener('keydown', e => this.keyDown(e), { signal });
    this.el.addEventListener('keyup', e => { if (e.code === 'Space') { this.space = false; this.updateBrushCursor(); } }, { signal });
    window.addEventListener('blur', () => { this.space = false; this.cancelGesture(); }, { signal });
    this.stage.addEventListener('dragover', e => { e.preventDefault(); }, { signal });
    this.stage.addEventListener('drop', e => { e.preventDefault(); void this.importFiles(Array.from(e.dataTransfer?.files ?? [])); }, { signal });
    this.el.addEventListener('paste', e => { const files = Array.from(e.clipboardData?.files ?? []); if (files.length) { e.preventDefault(); void this.importFiles(files); } }, { signal });
    window.addEventListener('pagehide', () => { if (this.needsSave && !this.task) void this.save(); }, { signal });
    this.resizeObserver = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (this.stageSize) {
        if (this.gesture) this.cancelGesture();
        this.view.x += (width - this.stageSize.width) / 2; this.view.y += (height - this.stageSize.height) / 2;
      }
      this.stageSize = { width, height }; this.draw(); this.scheduleSave();
    }); this.resizeObserver.observe(this.stage);
    this.refresh(); void this.restore();
  }
  private get<T extends HTMLElement = HTMLElement>(name: string): T { return this.el.querySelector<T>(`[data-el="${name}"]`)!; }
  private option<T extends HTMLInputElement | HTMLSelectElement = HTMLInputElement>(name: string): T { return this.el.querySelector<T>(`[data-option="${name}"]`)!; }
  private button(name: string): HTMLButtonElement { return this.el.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!; }
  private layer(): Layer | undefined { return this.doc.layers.find(l => l.id === this.doc.active); }
  private message(text = '', error = false): void {
    if (this.destroyed) return;
    this.errorVisible = error; this.status.textContent = text; this.status.dataset.error = String(error); this.button('dismiss').hidden = !error;
  }
  private fail(error: unknown): void { this.message(error instanceof Error ? error.message : String(error), true); }
  private draw(): void {
    if (this.frame || this.destroyed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      try { this.renderer.draw(this.surface, this.doc, this.view, this.tool === 'move', this.previewPath); }
      catch (error) { this.fail(error); }
      this.updateBrushCursor();
    });
  }
  private refresh(renderLayers = true): void {
    if (this.destroyed) return;
    if (this.ready && !this.fileBusy) {
      const retained = new Set(this.doc.layers.map(l => l.asset));
      for (const item of [...this.history.past, ...this.history.future]) for (const layer of item.document.layers) retained.add(layer.asset);
      for (const [id, asset] of this.assets) if (!retained.has(id)) { asset.bitmap.close(); this.assets.delete(id); }
    }
    const l = this.layer(), hasSelection = !!l?.selection?.some(Boolean), blocked = !!this.task || this.fileBusy || !this.ready;
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('[data-tool]')) { b.setAttribute('aria-pressed', String(b.dataset.tool === this.tool)); b.disabled = (blocked && b.dataset.tool !== this.tool) || !this.ready; }
    this.stage.dataset.currentTool = this.tool;
    const selection = ['quick', 'color', 'wand', 'brush', 'rect', 'lasso', 'model'].includes(this.tool);
    const fields: Record<string, boolean> = {
      selection, radius: ['quick', 'brush', 'mask', 'refine'].includes(this.tool), tolerance: ['color', 'wand'].includes(this.tool),
      paint: ['mask', 'refine', 'model'].includes(this.tool), refine: this.tool === 'refine', move: this.tool === 'move',
      magnify: ['quick', 'brush', 'mask', 'refine'].includes(this.tool), model: this.tool === 'model',
    };
    for (const field of this.el.querySelectorAll<HTMLElement>('[data-for]')) field.hidden = !fields[field.dataset.for!];
    this.el.querySelector<HTMLElement>('.ie-options')!.hidden = !Object.values(fields).some(Boolean);
    this.button('model-enable').hidden = this.tool !== 'model' || this.modelReady;
    this.button('model-enable').disabled = this.modelLoading;
    this.button('model-disable').hidden = this.tool !== 'model' || (!this.modelReady && !this.modelLoading);
    this.button('apply').hidden = !this.task; this.button('apply').disabled = !!this.busy || !!this.gesture;
    this.button('cancel').hidden = !this.task;
    this.get('task-actions').hidden = !this.task;
    const historyBlocked = this.fileBusy || !this.ready || this.busy || !!this.gesture;
    this.button('undo').disabled = historyBlocked || (!this.task && !this.history.past.length);
    this.button('redo').disabled = historyBlocked || !!this.task || !this.history.future.length;
    for (const name of ['new', 'size', 'import']) this.button(name).disabled = blocked;
    this.button('export').disabled = blocked || this.exporting || !this.doc.layers.length;
    for (const name of ['all', 'inverse', 'deselect', 'duplicate', 'delete', 'flip-x', 'flip-y', 'mask-selection']) this.button(name).disabled = blocked || !l;
    for (const name of ['copy', 'cut', 'mask-from']) this.button(name).disabled = blocked || !hasSelection;
    for (const name of ['mask-toggle', 'mask-remove']) this.button(name).disabled = blocked || !l?.mask;
    this.button('refine').disabled = this.fileBusy || !this.ready || !!this.busy || !l || (!hasSelection && !l.mask);
    this.button('mask-toggle').textContent = l?.maskEnabled === false ? '启用蒙版' : '停用蒙版';
    const index = l ? this.doc.layers.indexOf(l) : -1;
    this.button('up').disabled = blocked || index < 0 || index === this.doc.layers.length - 1;
    this.button('down').disabled = blocked || index <= 0;
    this.button('merge-down').disabled = blocked || mergeTargets(this.doc, 'down').length < 2;
    this.button('merge-visible').disabled = blocked || mergeTargets(this.doc, 'visible').length < 2;
    for (const input of this.el.querySelectorAll<HTMLInputElement>('[data-transform]')) {
      input.disabled = blocked || !l;
      const key = input.dataset.transform!;
      const value = !l ? '' : key === 'opacity' ? l.opacity * 100 : key === 'width' ? Math.abs(l.transform.sx) * l.width : key === 'height' ? Math.abs(l.transform.sy) * l.height : key === 'angle' ? l.transform.angle * 180 / Math.PI : l.transform[key as 'x' | 'y'];
      if (document.activeElement !== input) input.value = typeof value === 'number' ? String(Math.round(value * 100) / 100) : value;
    }
    this.option('zoom').value = String(Math.round(this.view.zoom * 100)); this.option('background').value = this.view.background;
    this.get('dimensions').textContent = `${this.doc.width} × ${this.doc.height}`;
    if (renderLayers) this.renderLayers(blocked);
    else for (const row of this.get('layers').children) { const selected = (row as HTMLElement).dataset.layer === this.doc.active; row.classList.toggle('ie-current', selected); row.setAttribute('aria-current', String(selected)); }
    this.draw();
  }
  private renderLayers(blocked: boolean): void {
    const list = this.get('layers'); list.replaceChildren();
    for (const l of [...this.doc.layers].reverse()) {
      const row = document.createElement('li'); row.dataset.layer = l.id; row.classList.toggle('ie-current', l.id === this.doc.active);
      row.setAttribute('aria-current', String(l.id === this.doc.active));
      const visibility = document.createElement('input'); visibility.type = 'checkbox'; visibility.checked = l.visible; visibility.dataset.visibility = l.id; visibility.setAttribute('aria-label', `显示 ${l.name}`); visibility.disabled = blocked;
      const thumb = canvas(34, 34); thumb.setAttribute('aria-hidden', 'true');
      try {
        const ratio = Math.min(34 / l.width, 34 / l.height), ctx = thumb.getContext('2d')!;
        ctx.drawImage(this.renderer.image(l), (34 - l.width * ratio) / 2, (34 - l.height * ratio) / 2, l.width * ratio, l.height * ratio);
      } catch (error) { this.fail(error); }
      const name = document.createElement('input'); name.className = 'ie-layer-name'; name.value = l.name; name.dataset.name = l.id; name.setAttribute('aria-label', '图层名称'); name.disabled = blocked;
      row.append(visibility, thumb, name); list.append(row);
    }
  }
  private fit(): void {
    const r = this.stage.getBoundingClientRect();
    this.view.zoom = Math.min((r.width - 32) / this.doc.width, (r.height - 32) / this.doc.height, 1);
    this.view.zoom = Math.max(.01, this.view.zoom); this.view.x = (r.width - this.doc.width * this.view.zoom) / 2; this.view.y = (r.height - this.doc.height * this.view.zoom) / 2;
    this.refresh(); this.scheduleSave();
  }
  private screen(e: { clientX: number; clientY: number }): Point { const r = this.surface.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  private world(p: Point): Point { return { x: (p.x - this.view.x) / this.view.zoom, y: (p.y - this.view.y) / this.view.zoom }; }
  private zoomAt(factor: number, screen: Point): void {
    const p = this.world(screen); this.view.zoom = Math.max(.01, Math.min(32, factor)); this.view.x = screen.x - p.x * this.view.zoom; this.view.y = screen.y - p.y * this.view.zoom;
    this.option('zoom').value = String(Math.round(this.view.zoom * 100)); this.draw(); this.scheduleSave();
  }
  private changed(label: string, operation: () => void): void {
    if (!this.ready || this.fileBusy || this.task) return;
    this.history.push(this.doc, label); operation(); this.version++; this.refresh(); this.scheduleSave();
  }
  private startTask(): void {
    if (!this.task) {
      this.task = { before: snapshot(this.doc), tool: this.tool, base: this.layer()?.selection ?? null, points: [], labels: [] };
      this.request++; this.refresh();
    }
  }
  private apply(): void {
    if (!this.task || this.busy || this.gesture) return;
    if (this.task.crop) {
      const r = this.task.crop; this.doc.width = r.width; this.doc.height = r.height; this.doc.autoSize = false;
      for (const l of this.doc.layers) { l.transform.x -= r.x; l.transform.y -= r.y; }
    }
    this.history.push(this.task.before, this.tool); this.task = null; this.previewPath = []; this.version++; this.request++;
    this.refresh(); this.scheduleSave();
  }
  private cancel(): void {
    this.request++; this.gesture = null; this.pointers.clear(); this.previewPath = []; this.get('magnifier').hidden = true;
    if (this.colorTimer) clearTimeout(this.colorTimer); this.colorTimer = null;
    if (this.task) { this.doc = snapshot(this.task.before); this.task = null; }
    this.stopAlgorithms(); if (!this.errorVisible) this.message(); this.refresh(); this.scheduleSave();
  }
  private scheduleSave(): void {
    if (!this.ready || this.destroyed) return;
    this.needsSave = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { if (!this.task) void this.save(); }, 350);
  }
  private async save(): Promise<void> {
    if (!this.ready || this.task || !this.needsSave) return;
    this.needsSave = false; const doc = snapshot(this.doc), view = { ...this.view }, assets = new Map(this.assets);
    this.saveChain = this.saveChain.then(async () => {
      try { if (!this.errorVisible) this.message('保存中…'); await this.storage.save(doc, view, assets); if (!this.errorVisible) this.message(); }
      catch (error) { this.needsSave = true; this.fail(error); }
    }); await this.saveChain;
  }
  private async restore(): Promise<void> {
    try {
      const result = await this.storage.load();
      if (this.destroyed) return;
      if (result) {
        for (const [id, blob] of result.blobs) {
          const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
          if (this.destroyed) { bitmap.close(); return; }
          this.assets.set(id, { id, blob, bitmap });
        }
        for (const l of result.saved.document.layers) if (!this.assets.has(l.asset)) throw new Error('已保存文档的原图不完整');
        this.doc = result.saved.document; this.view = result.saved.view;
      } else this.fit();
      this.ready = true; this.refresh();
    } catch (error) { this.ready = true; this.fail(error); this.refresh(); }
  }
  private async importFiles(files: File[]): Promise<void> {
    if (!this.ready || this.fileBusy || this.task || !files.length) return;
    this.importing = true; this.refresh(); const before = snapshot(this.doc), added: string[] = [];
    try {
      for (const file of files) {
        if (file.type && !file.type.startsWith('image/')) throw new Error(`不支持的图片：${file.name}`);
        this.message(`导入 ${file.name}…`);
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        if (this.destroyed) { bitmap.close(); return; }
        if (!bitmap.width || !bitmap.height || bitmap.width > 16384 || bitmap.height > 16384) { bitmap.close(); throw new Error('图片边长必须在 1–16384 像素之间'); }
        // Check allocation before committing any layer; never silently resize source images.
        const check = canvas(bitmap.width, bitmap.height); check.getContext('2d')!.drawImage(bitmap, 0, 0); check.getContext('2d')!.getImageData(0, 0, 1, 1); check.width = 0;
        const id = crypto.randomUUID(); this.assets.set(id, { id, blob: file, bitmap }); added.push(id);
        const l = newLayer(id, file.name, bitmap.width, bitmap.height);
        if (!this.doc.layers.length && this.doc.autoSize) { this.doc.width = bitmap.width; this.doc.height = bitmap.height; }
        this.doc.autoSize = false;
        l.transform.x = (this.doc.width - bitmap.width) / 2; l.transform.y = (this.doc.height - bitmap.height) / 2;
        this.doc.layers.push(l); this.doc.active = l.id;
      }
      this.history.push(before, '导入'); this.version++; this.message(); this.fit(); this.scheduleSave();
    } catch (error) {
      this.doc = before;
      for (const id of added) { this.assets.get(id)?.bitmap.close(); this.assets.delete(id); }
      this.fail(error);
    } finally { this.importing = false; this.get<HTMLInputElement>('files').value = ''; this.refresh(); }
  }
  private pixels(l: Layer): Uint8ClampedArray {
    const asset = this.assets.get(l.asset); if (!asset) throw new Error('原图丢失');
    if (!asset.pixels) {
      for (const other of this.assets.values()) if (other !== asset) other.pixels = undefined;
      const c = canvas(l.width, l.height), ctx = c.getContext('2d', { willReadFrequently: true })!; ctx.drawImage(asset.bitmap, 0, 0);
      asset.pixels = ctx.getImageData(0, 0, l.width, l.height).data; c.width = 0;
    }
    return asset.pixels;
  }
  private click(event: MouseEvent): void {
    const target = event.target as HTMLElement, tool = target.closest<HTMLButtonElement>('[data-tool]');
    if (tool && !tool.disabled && !this.task) { this.tool = tool.dataset.tool as Tool; if (this.tool === 'quick') this.option('mode').value = 'add'; this.refresh(); return; }
    const row = target.closest<HTMLElement>('[data-layer]');
    if (row && !this.task && !this.fileBusy && !(target instanceof HTMLInputElement && target.type === 'checkbox')) {
      this.doc.active = row.dataset.layer!;
      // Keep the clicked name input alive for editing.
      for (const item of this.get('layers').children) item.classList.toggle('ie-current', (item as HTMLElement).dataset.layer === this.doc.active);
      this.draw(); this.scheduleSave();
      this.refresh(!(target instanceof HTMLInputElement));
    }
    const button = target.closest<HTMLButtonElement>('[data-action]');
    if (!button || button.disabled) return;
    const action = button.dataset.action!, l = this.layer();
    if (action === 'dismiss') { this.message(); return; }
    if (action === 'layers' || action === 'controls') {
      const open = !this.el.classList.contains(`ie-${action}-open`);
      for (const panel of ['controls', 'layers']) {
        const expanded = open && action === panel;
        this.el.classList.toggle(`ie-${panel}-open`, expanded); this.button(panel).setAttribute('aria-expanded', String(expanded));
      }
      return;
    }
    if (action === 'apply') { this.apply(); return; }
    if (action === 'cancel') { this.cancel(); return; }
    if (action === 'fit') { this.fit(); return; }
    if (action === 'zoom-in' || action === 'zoom-out') { const r = this.stage.getBoundingClientRect(); this.zoomAt(this.view.zoom * (action === 'zoom-in' ? 1.25 : .8), { x: r.width / 2, y: r.height / 2 }); return; }
    if (action === 'model-enable') { void this.enableModel(); return; }
    if (action === 'model-disable') { this.disableModel(); return; }
    if (action === 'model-clear') { void this.clearModel(); return; }
    if (action === 'refine') { void this.refine(); return; }
    if (action === 'undo' || action === 'redo') {
      if (!this.ready || this.fileBusy || this.busy || this.gesture) return;
      // Save a completed preview before undoing it so redo can restore the edit.
      if (this.task) {
        if (action !== 'undo' || this.busy || this.gesture) return;
        this.apply();
      }
      const doc = action === 'undo' ? this.history.undo(this.doc) : this.history.redo(this.doc);
      if (doc) { this.doc = doc; this.version++; this.request++; this.refresh(); this.scheduleSave(); } return;
    }
    if (this.task) return;
    if (action === 'merge-down' || action === 'merge-visible') { void this.mergeLayers(action === 'merge-down' ? 'down' : 'visible'); return; }
    if (action === 'import') { this.get<HTMLInputElement>('files').click(); return; }
    if (action === 'new' || action === 'size') { this.sizeDialog(action === 'new'); return; }
    if (action === 'export') { this.exportDialog(); return; }
    if (!l) return;
    if (['copy', 'cut'].includes(action) && !l.selection?.some(Boolean)) return;
    this.changed(action, () => {
      switch (action) {
        case 'all': l.selection = new Uint8Array(l.width * l.height).fill(255); l.constraints = null; break;
        case 'inverse': l.selection = l.selection?.map(v => 255 - v) ?? new Uint8Array(l.width * l.height).fill(255); l.constraints = null; break;
        case 'deselect': l.selection = null; l.constraints = null; break;
        case 'copy': case 'cut': selectionToLayer(this.doc, action === 'cut'); break;
        case 'mask-from': if (l.selection) { l.mask = l.selection.slice(); l.maskEnabled = true; l.selection = null; l.constraints = null; } break;
        case 'mask-selection': l.selection = l.mask?.slice() ?? new Uint8Array(l.width * l.height).fill(255); l.constraints = null; break;
        case 'mask-toggle': l.maskEnabled = !l.maskEnabled; break;
        case 'mask-remove': l.mask = null; l.maskEnabled = true; break;
        case 'duplicate': { const next = { ...l, id: crypto.randomUUID(), name: `${l.name} 副本`, transform: { ...l.transform } }; this.doc.layers.splice(this.doc.layers.indexOf(l) + 1, 0, next); this.doc.active = next.id; break; }
        case 'delete': { const index = this.doc.layers.indexOf(l); this.doc.layers.splice(index, 1); this.doc.active = this.doc.layers[Math.min(index, this.doc.layers.length - 1)]?.id ?? null; break; }
        case 'up': case 'down': { const i = this.doc.layers.indexOf(l), j = i + (action === 'up' ? 1 : -1); if (j >= 0 && j < this.doc.layers.length) [this.doc.layers[i], this.doc.layers[j]] = [this.doc.layers[j], this.doc.layers[i]]; break; }
        case 'flip-x': case 'flip-y': {
          const center = localToWorld({ x: l.width / 2, y: l.height / 2 }, l.transform);
          if (action === 'flip-x') l.transform.sx *= -1; else l.transform.sy *= -1;
          const nextCenter = localToWorld({ x: l.width / 2, y: l.height / 2 }, l.transform); l.transform.x += center.x - nextCenter.x; l.transform.y += center.y - nextCenter.y; break;
        }
      }
    });
  }
  private change(event: Event): void {
    const target = event.target as HTMLInputElement;
    if (target === this.get('files')) { void this.importFiles(Array.from(target.files ?? [])); return; }
    if (target.dataset.visibility) { const l = this.doc.layers.find(l => l.id === target.dataset.visibility); if (l) this.changed('显示图层', () => { l.visible = target.checked; }); return; }
    if (target.dataset.name) {
      const l = this.doc.layers.find(l => l.id === target.dataset.name), value = target.value.trim();
      if (l && value && value !== l.name) this.changed('重命名', () => { l.name = value; }); else if (l) target.value = l.name; return;
    }
    if (target.dataset.transform) {
      const l = this.layer(), value = target.valueAsNumber, key = target.dataset.transform;
      if (!l || !Number.isFinite(value) || (['width', 'height'].includes(key) && (value < 1 || value > 100000))) { this.refresh(); return; }
      this.changed('变换', () => {
        if (key === 'opacity') l.opacity = Math.max(0, Math.min(1, value / 100));
        else if (key === 'angle') l.transform.angle = value * Math.PI / 180;
        else if (key === 'x' || key === 'y') l.transform[key] = value;
        else {
          const t = l.transform, ratio = key === 'width' ? value / (Math.abs(t.sx) * l.width) : value / (Math.abs(t.sy) * l.height);
          if (this.option('proportional').checked) { t.sx *= ratio; t.sy *= ratio; }
          else if (key === 'width') t.sx = Math.sign(t.sx) * value / l.width; else t.sy = Math.sign(t.sy) * value / l.height;
        }
      });
    }
    if (target.dataset.option === 'background') { this.view.background = target.value; this.draw(); this.scheduleSave(); }
    if (target.dataset.option === 'zoom' && target.valueAsNumber > 0) { const r = this.stage.getBoundingClientRect(); this.zoomAt(target.valueAsNumber / 100, { x: r.width / 2, y: r.height / 2 }); }
    if (target.dataset.option === 'mode' && this.task?.seed) { this.task.modeOverride = undefined; this.queueColor(); }
    if (target.dataset.option === 'mode' && this.task?.candidate && this.layer()) { this.layer()!.selection = combineMasks(this.task.base ?? null, this.task.candidate, target.value as Combine); this.draw(); }
  }
  private async mergeLayers(mode: MergeMode): Promise<void> {
    if (!this.ready || this.fileBusy || this.task) return;
    const sources = mergeTargets(this.doc, mode); if (sources.length < 2) return;
    const before = snapshot(this.doc), version = this.version;
    this.merging = true; this.refresh(); this.message('合并中…');
    try {
      const result = await this.renderer.merge(sources);
      if (this.destroyed || this.version !== version) { result.bitmap.close(); return; }
      const id = crypto.randomUUID(), merged = newLayer(id, mode === 'down' ? sources[0].name : '合并图层', result.bitmap.width, result.bitmap.height);
      merged.transform.x = result.x; merged.transform.y = result.y;
      this.assets.set(id, { id, blob: result.blob, bitmap: result.bitmap });
      this.history.push(before, mode === 'down' ? '向下合并' : '合并可见图层');
      replaceMergedLayers(this.doc, sources, merged); this.version++; this.request++; this.message(); this.scheduleSave();
    } catch (error) { this.fail(error); }
    finally { this.merging = false; this.refresh(); }
  }
  private input(event: Event): void {
    const target = event.target as HTMLInputElement, key = target.dataset.option;
    if (key) {
      const output = this.el.querySelector<HTMLOutputElement>(`[data-value="${key}"]`); if (output) output.value = target.value;
      if (key === 'tolerance' && this.task?.seed) this.queueColor();
      if (key === 'radius') {
        const r = this.stage.getBoundingClientRect(); this.brushPoint ??= { x: r.width / 2, y: r.height / 2 };
        this.updateBrushCursor();
      }
    }
  }
  private modal(title: string, fields: string, submit: (data: FormData) => void | Promise<void>): void {
    const dialog = this.get<HTMLDialogElement>('dialog'), form = this.get<HTMLFormElement>('dialog-form');
    form.innerHTML = `<h2>${title}</h2>${fields}<menu><button value="cancel" formnovalidate>取消</button><button value="ok">确认</button></menu>`;
    form.onsubmit = event => {
      event.preventDefault(); if ((event.submitter as HTMLButtonElement)?.value !== 'ok') { dialog.close(); return; }
      if (!form.reportValidity()) return;
      const data = new FormData(form); dialog.close(); Promise.resolve(submit(data)).catch(error => this.fail(error));
    }; dialog.showModal();
  }
  private sizeDialog(fresh: boolean): void {
    this.modal(fresh ? '新建画布' : '画布尺寸', `
      <label>宽 <input name="width" type="number" min="1" max="16384" value="${this.doc.width}" required></label>
      <label>高 <input name="height" type="number" min="1" max="16384" value="${this.doc.height}" required></label>`, data => {
      const width = Number(data.get('width')), height = Number(data.get('height'));
      if (fresh && this.doc.layers.length && !confirm('新建画布将替换当前编辑，继续？')) return;
      const probe = canvas(width, height); probe.getContext('2d')!.fillRect(width - 1, height - 1, 1, 1); const pixel = probe.getContext('2d')!.getImageData(width - 1, height - 1, 1, 1).data; probe.width = 0;
      if (!pixel[3]) throw new Error('画布超出设备支持的尺寸');
      this.changed(fresh ? '新建画布' : '画布尺寸', () => { if (fresh) this.doc = emptyDocument(); this.doc.width = width; this.doc.height = height; this.doc.autoSize = false; }); this.fit();
    });
  }
  private exportDialog(): void {
    this.modal('导出图片', `<label>格式 <select name="type"><option value="image/png">PNG</option><option value="image/jpeg">JPEG</option></select></label>
      <label>JPEG 质量 <input name="quality" type="number" min="1" max="100" value="92" required></label>
      <label>JPEG 背景 <input name="background" type="color" value="#ffffff"></label>`, async data => {
      this.exporting = true; this.refresh();
      try {
        this.message('导出中…');
        const type = String(data.get('type')), blob = await this.renderer.export(this.doc, type, Number(data.get('quality')) / 100, String(data.get('background')));
        const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = `图片.${type === 'image/png' ? 'png' : 'jpg'}`; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 30000); this.message();
      } finally { this.exporting = false; this.refresh(); }
    });
  }
  private keyDown(e: KeyboardEvent): void {
    if (e.isComposing || e.altKey || (e.target as HTMLElement).closest('input,select,textarea,dialog,[contenteditable]:not([contenteditable="false"])') || !this.ready || this.fileBusy) return;
    const key = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') { e.preventDefault(); this.space = true; this.updateBrushCursor(); return; }
    if (key === 'escape') { e.preventDefault(); this.cancel(); return; }
    if (key === 'enter' && this.task) { e.preventDefault(); this.apply(); return; }
    const action = mod && key === 'z' ? e.shiftKey ? 'redo' : 'undo' : mod && key === 'y' ? 'redo' : mod && key === 'a' ? 'all' : mod && key === 'd' ? 'deselect' : mod && key === 'j' ? e.shiftKey ? 'cut' : 'copy' : mod && key === 'i' && e.shiftKey ? 'inverse' : key === 'delete' ? 'delete' : null;
    if (action) { e.preventDefault(); this.button(action).click(); return; }
    if (mod) return;
    const tool = tools.find(([, , shortcut]) => shortcut.toLowerCase() === key);
    if (tool && !this.task) { e.preventDefault(); this.tool = tool[0]; if (this.tool === 'quick') this.option('mode').value = 'add'; this.refresh(); return; }
    if (key === '[' || key === ']') { e.preventDefault(); const r = this.option('radius'); r.value = String(Math.max(1, Math.min(200, Number(r.value) + (key === '[' ? -4 : 4)))); r.dispatchEvent(new Event('input', { bubbles: true })); }
    if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key)) {
      e.preventDefault(); const l = this.layer(); if (l && !this.task) this.changed('移动', () => { const d = e.shiftKey ? 10 : 1; l.transform.x += key === 'arrowleft' ? -d : key === 'arrowright' ? d : 0; l.transform.y += key === 'arrowup' ? -d : key === 'arrowdown' ? d : 0; });
    }
  }
  private pointerDown(e: PointerEvent): void {
    if (!this.ready || this.fileBusy || (e.button !== 0 && e.button !== 1)) return;
    e.preventDefault(); this.surface.focus({ preventScroll: true }); this.surface.setPointerCapture(e.pointerId);
    const screen = this.screen(e); this.brushPoint = screen; this.pointers.set(e.pointerId, screen);
    if (this.pointers.size === 2) {
      this.rollbackGesture();
      const [a, b] = [...this.pointers.values()], mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom: this.view.zoom, world: this.world(mid) }; this.updateBrushCursor(); return;
    }
    if (this.pointers.size > 1) return;
    let l = this.layer(); const world = this.world(screen), pan = this.tool === 'pan' || this.space || e.button === 1;
    if (!pan && this.tool !== 'crop' && !l) { this.pointers.delete(e.pointerId); return; }
    if (!pan && this.tool === 'model' && !this.modelReady) { this.message('请先启用模型'); this.pointers.delete(e.pointerId); return; }
    let handle = -1;
    if (!pan && this.tool === 'move') {
      if (l) handle = this.renderer.handles(l).findIndex(p => Math.hypot(p.x - world.x, p.y - world.y) * this.view.zoom < 12);
      if (handle < 0 && !this.task) {
        const hit = [...this.doc.layers].reverse().find(candidate => {
          if (!candidate.visible) return false; const p = worldToLocal(world, candidate.transform), x = Math.floor(p.x), y = Math.floor(p.y);
          return x >= 0 && y >= 0 && x < candidate.width && y < candidate.height && (!candidate.maskEnabled || !candidate.mask || candidate.mask[y * candidate.width + x] > 0) && this.pixels(candidate)[(y * candidate.width + x) * 4 + 3] > 0;
        });
        if (!hit) { this.pointers.delete(e.pointerId); return; }
        this.doc.active = hit.id; l = hit;
      }
    }
    const createdTask = !pan && !this.task;
    if (!pan) this.startTask();
    const mode: Combine = e.altKey ? 'subtract' : e.shiftKey ? 'add' : this.option('mode').value as Combine;
    this.gesture = { start: world, screen, last: world, points: l ? [worldToLocal(world, l.transform)] : [world], transform: l ? { ...l.transform } : undefined,
      handle, initialSelection: l?.selection, initialMask: l?.mask, initialMaskEnabled: l?.maskEnabled, initialConstraints: l?.constraints, createdTask, mode, pan, lastCompute: 0 };
    if (pan) { this.updateBrushCursor(); return; }
    if (this.tool === 'color' || this.tool === 'wand') {
      if (this.colorTimer) clearTimeout(this.colorTimer); this.colorTimer = null;
      return;
    }
    if (this.tool === 'model') {
      return;
    }
    if (this.tool === 'brush') {
      const n = l!.width * l!.height;
      l!.selection = mode === 'replace' || mode === 'intersect' ? new Uint8Array(n) : l!.selection?.slice() ?? new Uint8Array(n);
      l!.constraints = mode === 'replace' ? new Uint8Array(n) : l!.constraints?.slice() ?? new Uint8Array(n);
    }
    if (this.tool === 'mask') { l!.mask = l!.mask?.slice() ?? new Uint8Array(l!.width * l!.height).fill(255); l!.maskEnabled = true; }
    if (this.tool === 'refine') l!.constraints = l!.constraints?.slice() ?? new Uint8Array(l!.width * l!.height);
    if (this.tool === 'quick' && mode === 'replace' && !this.task!.before.layers.find(x => x.id === l!.id)?.selection) this.gesture.initialSelection = null;
    this.paintGesture(e); this.refresh();
  }
  private pointerMove(e: PointerEvent): void {
    this.brushPoint = this.screen(e); this.updateBrushCursor();
    if (!this.pointers.has(e.pointerId)) return;
    const screen = this.screen(e); this.pointers.set(e.pointerId, screen);
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()], mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.view.zoom = Math.max(.01, Math.min(32, this.pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / this.pinch.distance));
      this.view.x = mid.x - this.pinch.world.x * this.view.zoom; this.view.y = mid.y - this.pinch.world.y * this.view.zoom; this.draw(); return;
    }
    const g = this.gesture; if (!g) return;
    const world = this.world(screen);
    if (g.pan) { this.view.x += screen.x - g.screen.x; this.view.y += screen.y - g.screen.y; g.screen = screen; this.draw(); return; }
    const l = this.layer();
    if (l) {
      const p = worldToLocal(world, g.transform!);
      const prev = g.points[g.points.length - 1];
      if (Math.hypot(p.x - prev.x, p.y - prev.y) >= .5) g.points.push(p);
      // Avoid unbounded pointer-event lists on a long stroke.
      if (g.points.length > 8000) g.points = g.points.filter((_, i) => i % 2 === 0);
    } else g.points.push(world);
    this.paintGesture(e); g.last = world;
  }
  private paintGesture(e: PointerEvent): void {
    const g = this.gesture; if (!g) return;
    const world = this.world(this.screen(e)), l = this.layer();
    if (this.tool === 'crop') {
      const x = Math.max(0, Math.floor(Math.min(g.start.x, world.x))), y = Math.max(0, Math.floor(Math.min(g.start.y, world.y)));
      const right = Math.min(this.doc.width, Math.ceil(Math.max(g.start.x, world.x))), bottom = Math.min(this.doc.height, Math.ceil(Math.max(g.start.y, world.y)));
      if (right > x && bottom > y) { this.task!.crop = { x, y, width: right - x, height: bottom - y }; this.previewPath = [{ x, y }, { x: right, y }, { x: right, y: bottom }, { x, y: bottom }, { x, y }]; }
      this.draw(); return;
    }
    if (!l) return;
    const radius = Number(this.option('radius').value) / 2;
    if (this.tool === 'move') {
      const t = g.transform!;
      if (g.handle === 4) {
        const center = localToWorld({ x: l.width / 2, y: l.height / 2 }, t);
        let angle = t.angle + Math.atan2(world.y - center.y, world.x - center.x) - Math.atan2(g.start.y - center.y, g.start.x - center.x);
        if (e.shiftKey) angle = Math.round(angle / (Math.PI / 12)) * Math.PI / 12;
        l.transform = { ...t, angle };
        const next = localToWorld({ x: l.width / 2, y: l.height / 2 }, l.transform); l.transform.x += center.x - next.x; l.transform.y += center.y - next.y;
      } else if (g.handle >= 0) {
        const corners = [{ x: 0, y: 0 }, { x: l.width, y: 0 }, { x: l.width, y: l.height }, { x: 0, y: l.height }], corner = corners[g.handle], opposite = corners[(g.handle + 2) % 4], anchor = localToWorld(opposite, t);
        const dx = world.x - anchor.x, dy = world.y - anchor.y, c = Math.cos(t.angle), s = Math.sin(t.angle);
        let sx = (c * dx + s * dy) / (corner.x - opposite.x), sy = (-s * dx + c * dy) / (corner.y - opposite.y);
        if (this.option('proportional').checked !== e.shiftKey) {
          const a = localToWorld(corner, t), vx = a.x - anchor.x, vy = a.y - anchor.y;
          const ratio = (dx * vx + dy * vy) / Math.max(1, vx * vx + vy * vy); sx = t.sx * ratio; sy = t.sy * ratio;
        }
        sx = Math.abs(sx) < .001 ? (Math.sign(sx) || 1) * .001 : sx; sy = Math.abs(sy) < .001 ? (Math.sign(sy) || 1) * .001 : sy;
        l.transform = { ...t, sx, sy }; const next = localToWorld(opposite, l.transform); l.transform.x += anchor.x - next.x; l.transform.y += anchor.y - next.y;
      } else l.transform = { ...t, x: t.x + world.x - g.start.x, y: t.y + world.y - g.start.y };
    } else if (this.tool === 'rect') {
      const a = g.points[0], b = worldToLocal(world, l.transform);
      const polygon = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
      l.selection = combineMasks(g.initialSelection ?? null, polygonMask(l.width, l.height, polygon), g.mode); l.constraints = null;
    } else if (this.tool === 'lasso') {
      this.previewPath = g.points.map(p => localToWorld(p, l.transform));
    } else if (this.tool === 'brush') {
      const segment = [worldToLocal(g.last, l.transform), worldToLocal(world, l.transform)], value = g.mode === 'subtract' ? 0 : 255;
      if (g.mode === 'intersect') {
        g.paintMask ??= new Uint8Array(l.width * l.height); stroke(g.paintMask, l.width, l.height, segment, radius); l.selection = combineMasks(g.initialSelection ?? null, g.paintMask, 'intersect');
      } else stroke(l.selection!, l.width, l.height, segment, radius, value);
      stroke(l.constraints!, l.width, l.height, segment, radius, g.mode === 'subtract' ? 2 : 1); this.renderer.invalidate();
    } else if (this.tool === 'mask') {
      stroke(l.mask!, l.width, l.height, [worldToLocal(g.last, l.transform), worldToLocal(world, l.transform)], radius, this.option('paint').value === 'subtract' || e.altKey ? 0 : 255); this.renderer.invalidate(l.id);
    } else if (this.tool === 'refine') {
      stroke(l.constraints!, l.width, l.height, [worldToLocal(g.last, l.transform), worldToLocal(world, l.transform)], radius, this.option('paint').value === 'subtract' || e.altKey ? 2 : 1);
      this.previewPath = g.points.map(p => localToWorld(p, l.transform));
    } else if (this.tool === 'quick') {
      this.previewPath = g.points.map(p => localToWorld(p, l.transform));
      if (!this.busy && performance.now() - g.lastCompute > 160) { g.lastCompute = performance.now(); void this.quickSelection(g); }
    }
    this.draw(); this.magnify(e);
  }
  private pointerUp(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    if (this.surface.hasPointerCapture(e.pointerId)) this.surface.releasePointerCapture(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pinch) { if (this.pointers.size < 2) { this.pinch = null; this.pointers.clear(); this.brushPoint = null; this.scheduleSave(); this.refresh(); } return; }
    const g = this.gesture; this.gesture = null; this.get('magnifier').hidden = true;
    if (!g) { this.refresh(); return; }
    if (g.pan) { this.scheduleSave(); this.refresh(); return; }
    const l = this.layer();
    if (l && this.task && (this.tool === 'color' || this.tool === 'wand')) { this.task.seed = g.points[g.points.length - 1]; this.task.modeOverride = g.mode; void this.colorSelection(); }
    if (l && this.task && this.tool === 'model') {
      const p = g.points[g.points.length - 1];
      if (p.x >= 0 && p.y >= 0 && p.x < l.width && p.y < l.height) { this.task.points.push(p); this.task.labels.push(this.option('paint').value === 'subtract' || e.altKey ? 0 : 1); void this.modelSelection(); }
    }
    if (this.tool === 'lasso' && l) { l.selection = combineMasks(g.initialSelection ?? null, polygonMask(l.width, l.height, g.points), g.mode); l.constraints = null; }
    if (this.tool === 'quick' && l) void this.quickSelection(g);
    else if (this.tool === 'refine' && l) void this.refine();
    this.previewPath = this.tool === 'crop' ? this.previewPath : []; this.refresh();
  }
  private rollbackGesture(): void {
    const g = this.gesture, l = this.layer();
    if (g && !g.pan && l) { l.selection = g.initialSelection ?? null; l.mask = g.initialMask ?? null; l.maskEnabled = g.initialMaskEnabled ?? true; l.constraints = g.initialConstraints ?? null; if (g.transform) l.transform = g.transform; this.renderer.invalidate(l.id); }
    if (g?.createdTask && this.task) { this.doc = snapshot(this.task.before); this.task = null; }
    this.request++; this.gesture = null; this.previewPath = []; this.get('magnifier').hidden = true; this.refresh();
  }
  private cancelGesture(): void { this.brushPoint = null; this.rollbackGesture(); this.pointers.clear(); this.pinch = null; this.refresh(); }
  private brushRadii(): { rx: number; ry: number; angle: number } | null {
    const l = this.layer();
    if (!l || !['quick', 'brush', 'mask', 'refine'].includes(this.tool)) return null;
    const radius = Number(this.option('radius').value) / 2;
    return { rx: radius * Math.abs(l.transform.sx) * this.view.zoom, ry: radius * Math.abs(l.transform.sy) * this.view.zoom, angle: l.transform.angle };
  }
  private updateBrushCursor(): void {
    const overlay = this.el.querySelector<SVGSVGElement>('[data-el="brush-cursor"]')!, p = this.brushPoint, r = this.brushRadii();
    const hidden = !p || !r || !this.ready || this.fileBusy || this.space || !!this.pinch || this.pointers.size > 1 || !!this.gesture?.pan;
    overlay.toggleAttribute('hidden', hidden);
    if (hidden || !p || !r) return;
    for (const ellipse of overlay.querySelectorAll('ellipse')) {
      ellipse.setAttribute('cx', String(p.x)); ellipse.setAttribute('cy', String(p.y));
      ellipse.setAttribute('rx', String(r.rx)); ellipse.setAttribute('ry', String(r.ry));
      ellipse.setAttribute('transform', `rotate(${r.angle * 180 / Math.PI} ${p.x} ${p.y})`);
    }
  }
  private magnify(e: PointerEvent): void {
    const target = this.get<HTMLCanvasElement>('magnifier');
    target.hidden = e.pointerType === 'mouse' || !this.option('magnify').checked || !['quick', 'brush', 'mask', 'refine'].includes(this.tool);
    if (target.hidden) return;
    const p = this.screen(e), ratio = this.surface.width / this.surface.getBoundingClientRect().width, ctx = target.getContext('2d')!;
    ctx.clearRect(0, 0, 140, 140); ctx.imageSmoothingEnabled = false; ctx.drawImage(this.surface, (p.x - 18) * ratio, (p.y - 18) * ratio, 36 * ratio, 36 * ratio, 0, 0, 140, 140);
    const brush = this.brushRadii();
    if (brush) {
      ctx.beginPath(); ctx.ellipse(70, 70, brush.rx * 140 / 36, brush.ry * 140 / 36, brush.angle, 0, Math.PI * 2);
      ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.stroke(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.strokeStyle = '#e00000'; ctx.beginPath(); ctx.moveTo(62, 70); ctx.lineTo(78, 70); ctx.moveTo(70, 62); ctx.lineTo(70, 78); ctx.stroke();
    target.style.left = p.x < 160 && p.y < 160 ? 'auto' : '10px'; target.style.right = p.x < 160 && p.y < 160 ? '10px' : 'auto';
  }
  private wheel(e: WheelEvent): void {
    e.preventDefault(); const screen = this.screen(e);
    if (e.ctrlKey || e.metaKey || !e.shiftKey) this.zoomAt(this.view.zoom * Math.exp(-e.deltaY * .0015), screen);
    else { this.view.x -= e.deltaY; this.view.y -= e.deltaX; this.draw(); this.scheduleSave(); }
  }
  private connect(worker: Worker): Worker {
    worker.onmessage = event => {
      if (event.data.progress) {
        const p = event.data.progress;
        if (p.status === 'progress') this.message(`模型 ${Math.round(p.progress ?? 0)}% ${p.file?.split('/').pop() ?? ''}`);
        else if (p.status === 'initiate') this.message(`加载 ${p.file ?? '模型'}…`);
        return;
      }
      const callback = this.callbacks.get(event.data.id); if (!callback) return; this.callbacks.delete(event.data.id);
      if (event.data.error) callback.reject(new Error(event.data.error)); else callback.resolve(event.data.result);
    };
    worker.onerror = event => {
      for (const [id, callback] of this.callbacks) if (callback.worker === worker) { callback.reject(new Error(event.message || '计算线程加载失败')); this.callbacks.delete(id); }
      if (worker === this.worker) { this.worker.terminate(); this.worker = null; }
      if (worker === this.model) { this.model.terminate(); this.model = null; this.modelReady = false; this.modelLoading = false; this.refresh(); }
    }; return worker;
  }
  private send<T>(worker: Worker, data: Record<string, unknown>): Promise<T> {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      this.callbacks.set(id, { resolve, reject, worker });
      try { worker.postMessage({ ...data, id }); } catch (error) { this.callbacks.delete(id); reject(error); }
    });
  }
  private stopAlgorithms(): void {
    if (this.worker) {
      const worker = this.worker; worker.terminate(); this.worker = null;
      for (const [id, c] of this.callbacks) if (c.worker === worker) { c.reject(new Error('已取消')); this.callbacks.delete(id); }
    }
  }
  private async algorithm(kind: AlgorithmInput['kind'], points: Point[], selection: Uint8Array | null, constraints: Uint8Array | null, radius: number, subtract: boolean): Promise<AlgorithmOutput | null> {
    const l = this.layer(); if (!l || !this.task) return null;
    const task = this.task, token = ++this.request, active = l.id, version = this.version;
    this.operations.add(token); this.refresh();
    try {
      this.worker ??= this.connect(new Worker(new URL('./algorithm.worker.ts', import.meta.url), { type: 'module' }));
      const result = await this.send<AlgorithmOutput>(this.worker, { url: new URL('core.wasm', this.assetBase).href,
        input: { kind, width: l.width, height: l.height, pixels: this.pixels(l), selection, constraints, points, radius, tolerance: Number(this.option('tolerance').value), subtract } satisfies AlgorithmInput });
      return token === this.request && task === this.task && active === this.doc.active && version === this.version ? result : null;
    } catch (error) { if (task === this.task && token === this.request) this.fail(error); return null; }
    finally { this.operations.delete(token); this.refresh(); }
  }
  private queueColor(): void {
    if (this.colorTimer) clearTimeout(this.colorTimer);
    this.colorTimer = setTimeout(() => { this.colorTimer = null; void this.colorSelection(); }, 100); this.refresh();
  }
  private async colorSelection(): Promise<void> {
    const task = this.task, l = this.layer(); if (!task?.seed || !l) return;
    const result = await this.algorithm(this.tool as 'color' | 'wand', [task.seed], null, null, 0, false);
    if (result && task === this.task) { l.selection = combineMasks(task.base ?? null, result.selection, task.modeOverride ?? this.option('mode').value as Combine); l.constraints = null; this.draw(); this.refresh(); }
  }
  private async quickSelection(g: Gesture): Promise<void> {
    const l = this.layer(), task = this.task; if (!l || !task) return;
    const mode = g.mode, previous = g.initialSelection ?? null;
    const fresh = mode === 'replace' || mode === 'intersect';
    const result = await this.algorithm('quick', [...g.points], fresh ? null : previous, fresh ? null : g.initialConstraints ?? null, Number(this.option('radius').value) / 2, mode === 'subtract');
    if (!result || this.task !== task) return;
    l.selection = mode === 'intersect' ? combineMasks(previous, result.selection, mode) : result.selection;
    l.constraints = result.constraints ?? null; this.refresh();
  }
  private async refine(): Promise<void> {
    if (!this.ready || this.fileBusy) return;
    const l = this.layer(); if (!l) return;
    if (!l.selection && l.mask) { this.startTask(); l.selection = l.mask.slice(); }
    if (!l.selection?.some(Boolean)) { this.message('请先建立选区或蒙版'); return; }
    this.startTask(); const task = this.task;
    const result = await this.algorithm('refine', [], l.selection, l.constraints, Number(this.option('edge').value), false);
    if (result && task === this.task) { l.selection = result.selection; this.refresh(); }
  }
  private async enableModel(): Promise<void> {
    if (this.modelReady || this.modelLoading) return;
    // Exact ONNX sizes from the published q8 model; runtime is served from this static build.
    this.modal('启用 SlimSAM', '<span>量化权重 13.79 MB；运行库 21.64 MB。</span>', async () => {
      this.modelLoading = true; this.refresh(); this.message('加载模型…');
      const worker = this.model ??= this.connect(new Worker(new URL('./model.worker.ts', import.meta.url), { type: 'module' }));
      try {
        await this.send(worker, { action: 'load', runtime: new URL('ort/', this.assetBase).href });
        if (this.model === worker) { this.modelReady = true; this.message(); }
      } catch (error) { if (this.model === worker) { this.fail(error); worker.terminate(); this.model = null; this.modelReady = false; } }
      finally { if (this.model === worker || !this.model) this.modelLoading = false; this.refresh(); }
    });
  }
  private disableModel(): void {
    if (this.task?.tool === 'model' && this.busy) { this.request++; }
    const worker = this.model; worker?.terminate(); this.model = null; this.modelReady = false; this.modelLoading = false;
    for (const [id, c] of this.callbacks) if (c.worker === worker) { c.reject(new Error('模型已关闭')); this.callbacks.delete(id); }
    this.message(); this.refresh();
  }
  private async clearModel(): Promise<void> {
    this.disableModel();
    try {
      // The Transformers cache is origin-wide; remove only this model's entries.
      if ('caches' in window) for (const name of await caches.keys()) {
        if (!name.includes('transformers')) continue;
        const cache = await caches.open(name);
        for (const request of await cache.keys()) if (request.url.includes('/Xenova/slimsam-77-uniform/')) await cache.delete(request);
      }
      this.message('模型缓存已清理');
    } catch (error) { this.fail(error); }
  }
  private async modelSelection(): Promise<void> {
    const l = this.layer(), task = this.task;
    if (!l || !task || !this.model || !this.modelReady) return;
    const token = ++this.request; this.operations.add(token); this.refresh(); this.message('模型计算中…');
    try {
      const mask = await this.send<Uint8Array>(this.model, { action: 'segment', key: l.asset, width: l.width, height: l.height, pixels: this.pixels(l), points: [...task.points], labels: [...task.labels] });
      if (token !== this.request || task !== this.task) return;
      task.candidate = mask; l.selection = combineMasks(task.base ?? null, mask, this.option('mode').value as Combine); l.constraints = null; this.message(); this.draw();
    } catch (error) { if (token === this.request && task === this.task) this.fail(error); }
    finally { this.operations.delete(token); this.refresh(); }
  }
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    if (this.saveTimer) clearTimeout(this.saveTimer); if (this.colorTimer) clearTimeout(this.colorTimer);
    this.cancel(); await this.save(); this.destroyed = true;
    this.abort.abort(); this.resizeObserver.disconnect(); if (this.frame) cancelAnimationFrame(this.frame);
    this.stopAlgorithms(); this.disableModel(); await this.saveChain;
    try { await this.storage.close(); }
    finally { for (const asset of this.assets.values()) asset.bitmap.close(); this.renderer.dispose(); this.root.replaceChildren(); this.root.classList.remove('ie-host'); }
  }
}
