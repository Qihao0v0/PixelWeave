export type Point = { x: number; y: number };
export type Combine = 'replace' | 'add' | 'subtract' | 'intersect';
export type Tool = 'move' | 'pan' | 'quick' | 'color' | 'wand' | 'brush' | 'rect' | 'lasso' | 'mask' | 'refine' | 'model' | 'crop';
export interface Transform { x: number; y: number; sx: number; sy: number; angle: number }
export interface Layer {
  id: string; asset: string; name: string; width: number; height: number;
  transform: Transform; visible: boolean; opacity: number; maskEnabled: boolean;
  mask: Uint8Array | null; selection: Uint8Array | null; constraints: Uint8Array | null;
}
export interface DocumentState {
  width: number; height: number; autoSize: boolean; layers: Layer[]; active: string | null;
}
export interface View { zoom: number; x: number; y: number; background: string }
export interface Asset { id: string; blob: Blob; bitmap: ImageBitmap; pixels?: Uint8ClampedArray }
export interface Snapshot { document: DocumentState; label: string }
export interface AlgorithmInput {
  kind: 'color' | 'wand' | 'quick' | 'refine'; width: number; height: number;
  pixels: Uint8ClampedArray; selection: Uint8Array | null; constraints: Uint8Array | null;
  points: Point[]; radius: number; tolerance: number; subtract: boolean;
}
export interface AlgorithmOutput { selection: Uint8Array; constraints?: Uint8Array }
export const tools: [Tool, string, string][] = [
  ['move', '变换', 'V'], ['pan', '平移', 'H'], ['quick', '快速选择', 'W'],
  ['color', '颜色范围', 'C'], ['wand', '魔棒', 'G'], ['brush', '选择笔', 'B'],
  ['rect', '矩形', 'M'], ['lasso', '套索', 'L'], ['mask', '蒙版笔', 'E'],
  ['refine', '细化边缘', 'R'], ['model', '模型选择', 'S'], ['crop', '裁切', 'K'],
];
