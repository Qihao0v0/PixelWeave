import './style.css';
import { mountEditor } from './editor';
const editor = mountEditor(document.querySelector<HTMLElement>('#editor')!);
if (import.meta.hot) import.meta.hot.dispose(() => editor.destroy());
