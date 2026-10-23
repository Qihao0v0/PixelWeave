import type { DocumentState, Layer, Snapshot } from './types';
import { multiplyMasks } from './geometry';
export const emptyDocument = (): DocumentState => ({ width: 1200, height: 800, autoSize: true, layers: [], active: null });
export function newLayer(asset: string, name: string, width: number, height: number): Layer {
  return { id: crypto.randomUUID(), asset, name, width, height, transform: { x: 0, y: 0, sx: 1, sy: 1, angle: 0 }, visible: true, opacity: 1, maskEnabled: true, mask: null, selection: null, constraints: null };
}
// Pixel buffers are immutable after a commit, so history shares unchanged buffers.
export function snapshot(doc: DocumentState): DocumentState {
  return { ...doc, layers: doc.layers.map(l => ({ ...l, transform: { ...l.transform } })) };
}
export type MergeMode = 'down' | 'visible';
export function mergeTargets(doc: DocumentState, mode: MergeMode): Layer[] {
  if (mode === 'visible') return doc.layers.filter(l => l.visible);
  const index = doc.layers.findIndex(l => l.id === doc.active);
  if (index < 1 || !doc.layers[index].visible) return [];
  for (let i = index - 1; i >= 0; i--) if (doc.layers[i].visible) return [doc.layers[i], doc.layers[index]];
  return [];
}
export function replaceMergedLayers(doc: DocumentState, sources: Layer[], merged: Layer): void {
  const ids = new Set(sources.map(l => l.id)), top = doc.layers.reduce((last, l, i) => ids.has(l.id) ? i : last, -1);
  doc.layers = doc.layers.flatMap((l, index) => index === top ? [merged] : ids.has(l.id) ? [] : [l]);
  doc.active = merged.id;
}
export function selectionToLayer(doc: DocumentState, cut: boolean): boolean {
  const source = doc.layers.find(l => l.id === doc.active);
  if (!source?.selection?.some(Boolean)) return false;
  const next: Layer = { ...source, id: crypto.randomUUID(), name: `${source.name} ${cut ? '剪切' : '拷贝'}`, transform: { ...source.transform },
    mask: multiplyMasks(source.maskEnabled ? source.mask : null, source.selection), maskEnabled: true, selection: null, constraints: null };
  if (cut) {
    source.mask = multiplyMasks(source.maskEnabled ? source.mask : null, source.selection.map(v => 255 - v));
    source.maskEnabled = true;
  }
  source.selection = null; source.constraints = null;
  doc.layers.splice(doc.layers.indexOf(source) + 1, 0, next); doc.active = next.id;
  return true;
}
export class History {
  past: Snapshot[] = []; future: Snapshot[] = [];
  constructor(public budget = 128 * 1024 * 1024) {}
  push(doc: DocumentState, label: string): void {
    this.past.push({ document: snapshot(doc), label }); this.future = [];
    const seen = new Set<ArrayBufferLike>(); let bytes = 0;
    for (let i = this.past.length - 1; i >= 0; i--) {
      for (const l of this.past[i].document.layers) for (const b of [l.mask, l.selection, l.constraints])
        if (b && !seen.has(b.buffer)) { seen.add(b.buffer); bytes += b.byteLength; }
      if ((bytes > this.budget || this.past.length - i > 80) && i > 0) { this.past.splice(0, i); break; }
    }
  }
  undo(doc: DocumentState): DocumentState | null {
    const s = this.past.pop(); if (!s) return null;
    this.future.push({ document: snapshot(doc), label: s.label }); return snapshot(s.document);
  }
  redo(doc: DocumentState): DocumentState | null {
    const s = this.future.pop(); if (!s) return null;
    this.past.push({ document: snapshot(doc), label: s.label }); return snapshot(s.document);
  }
}
