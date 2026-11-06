import { Compartment, StateEffect, StateField, RangeSet, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, ViewPlugin, gutter, type DecorationSet } from '@codemirror/view';
import { editorInfoField } from 'obsidian';
import type { PairRow } from './diff/mddiff.ts';
import { reviewRegions } from './editorPresentation.ts';
import { NativeTablePresentation } from './nativeTablePresentation.ts';

export interface Presentation { filePath: string; revision: number; text: string; rows: PairRow[] }
export const presentReview = StateEffect.define<Presentation | null>();
class ChangeMarker extends GutterMarker {
  readonly elementClass: string;
  constructor(readonly kind: string, readonly message: string) {
    super(); this.elementClass = kind === 'ins' ? 'lgd-gutter-ins' : 'lgd-gutter-mod';
  }
  eq(other: ChangeMarker): boolean { return this.kind === other.kind && this.message === other.message; }
  toDOM(view: EditorView): HTMLElement {
    const element = view.dom.ownerDocument.createElement('span');
    element.textContent = this.kind === 'ins' ? '+' : '│';
    element.title = this.message;
    return element;
  }
}
interface ReviewMarks { decorations: DecorationSet; markers: RangeSet<GutterMarker>; revision: number; rows: PairRow[] | null }
const empty = (): ReviewMarks => ({ decorations: Decoration.none, markers: RangeSet.empty, revision: -1, rows: null });
export const reviewMarks = StateField.define<ReviewMarks>({
  create: empty,
  update(value, transaction) {
    // Never map stale highlights through edits. The next worker result replaces them.
    if (transaction.docChanged) return empty();
    const info = transaction.state.field(editorInfoField, false);
    for (const effect of transaction.effects) if (effect.is(presentReview)) {
      const data = effect.value;
      if (!data || data.filePath !== info?.file?.path || data.text !== transaction.state.doc.toString()) return empty();
      const decorations: Range<Decoration>[] = [], markers: Range<GutterMarker>[] = [];
      for (const { block, row, gutterOnly, gutter: showGutter } of reviewRegions(data.rows)) {
        const message = row.structural || (row.simplified ? 'Changed; details simplified.' : row.kind === 'ins' ? 'Added block.' : 'Changed block.');
        for (let number = block.lineStart + 1; number <= Math.min(block.lineEnd + 1, transaction.state.doc.lines); number++) {
          const line = transaction.state.doc.line(number);
          if (showGutter !== false) markers.push(new ChangeMarker(row.kind, message).range(line.from));
          // Native tables get cell presentation below; these also cover Source mode.
          if (!gutterOnly) decorations.push(Decoration.line({ class: row.kind === 'ins' ? 'lgd-editor-ins' : 'lgd-editor-mod' }).range(line.from));
        }
        if (gutterOnly) continue;
        for (const [start, end] of row.sourceDetail?.b || []) {
          const from = block.sourceStart + start, to = block.sourceStart + end;
          if (to > from && to <= transaction.state.doc.length) decorations.push(Decoration.mark({ class: 'lgd-char-ins' }).range(from, to));
        }
      }
      value = { decorations: Decoration.set(decorations, true), markers: RangeSet.of(markers, true), revision: data.revision, rows: data.rows };
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});
// Installing even an empty gutter reserves space in Obsidian's native editor.
// Keep it out of the extension tree until this particular note is under review.
const reviewGutter = new Compartment();
const changeGutter = gutter({ class: 'lgd-gutter', markers: view => view.state.field(reviewMarks).markers });

export interface EditorHost {
  editorAttached(view: EditorView): void;
  editorDetached(view: EditorView): void;
  editorChanged(view: EditorView, filePath: string): void;
  editorGeometryChanged(): void;
  editorTablePresentationIssue?(view: EditorView, message: string | null): void;
}
export function reviewExtension(host: EditorHost): Extension {
  return [reviewMarks, reviewGutter.of([]),
    ViewPlugin.fromClass(class {
      private view: EditorView;
      private tables: NativeTablePresentation;
      constructor(view: EditorView) {
        this.view = view;
        this.tables = new NativeTablePresentation(view, message => host.editorTablePresentationIssue?.(view, message));
        host.editorAttached(view);
      }
      update(update: import('@codemirror/view').ViewUpdate): void {
        const marks = update.state.field(reviewMarks);
        this.tables.update(marks.rows, marks.revision);
        const path = update.state.field(editorInfoField, false)?.file?.path;
        if (update.docChanged && path) host.editorChanged(update.view, path);
        if (update.geometryChanged || update.viewportChanged) host.editorGeometryChanged();
      }
      destroy(): void { this.tables.destroy(); host.editorDetached(this.view); }
    })];
}

export function editorPath(view: EditorView): string | undefined { return view.state.field(editorInfoField, false)?.file?.path; }

/** Only presentation effects; selection, document and undo history belong to Obsidian. */
export function publish(view: EditorView, value: Presentation | null, reviewing = !!value): void {
  const effects: StateEffect<unknown>[] = [presentReview.of(value)];
  if ((reviewGutter.get(view.state) === changeGutter) !== reviewing) {
    effects.push(reviewGutter.reconfigure(reviewing ? changeGutter : []));
  }
  view.dispatch({ effects: effects });
}

export function editorTopLine(view: EditorView): number {
  const top = view.scrollDOM.getBoundingClientRect().top;
  const position = view.posAtCoords({ x: view.contentDOM.getBoundingClientRect().left + 5, y: top + 4 }, false);
  if (position !== null) {
    const line = view.state.doc.lineAt(position), block = view.lineBlockAt(position);
    const fraction = Math.max(0, Math.min(1, (top - view.documentTop - block.top) / Math.max(1, block.height)));
    return line.number - 1 + fraction;
  }
  const block = view.lineBlockAtHeight(Math.max(0, top - view.documentTop));
  return view.state.doc.lineAt(block.from).number - 1;
}
export function scrollEditorToLine(view: EditorView, value: number): void {
  const line = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, Math.floor(value) + 1)));
  view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 0 }) });
}
