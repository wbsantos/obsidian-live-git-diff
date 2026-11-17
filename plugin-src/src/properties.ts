import { MarkdownRenderer, parseYaml, setIcon } from 'obsidian';
import type { App, Component } from 'obsidian';

/** Render the historical values with Obsidian's property layout, without editable controls. */
export async function renderProperties(app: App, source: string, container: HTMLElement, sourcePath: string, component: Component): Promise<void> {
  let properties: Record<string, unknown>;
  try {
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const closing = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
    const parsed: unknown = parseYaml(lines.slice(1, closing < 0 ? undefined : closing).join('\n'));
    if (parsed == null) properties = {};
    else if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a mapping');
    else properties = parsed as Record<string, unknown>;
  } catch {
    container.createDiv({ cls: 'lgd-properties-error', text: 'Unable to render properties: invalid YAML.' });
    container.createEl('pre').createEl('code', { text: source });
    return;
  }
  const metadata = container.createDiv({ cls: 'metadata-container lgd-properties', attr: { 'data-property-count': String(Object.keys(properties).length) } });
  metadata.createDiv({ cls: 'metadata-properties-heading' }).createDiv({ cls: 'metadata-properties-title', text: 'Properties' });
  const list = metadata.createDiv({ cls: 'metadata-content' }).createDiv({ cls: 'metadata-properties' });
  for (const [key, value] of Object.entries(properties)) {
    const tags = key.toLowerCase() === 'tags';
    const type = tags ? 'tags' : Array.isArray(value) ? 'multitext' : typeof value === 'boolean' ? 'checkbox' : typeof value === 'number' ? 'number' : 'text';
    const row = list.createDiv({ cls: 'metadata-property', attr: { 'data-property-key': key, 'data-property-type': type } });
    const name = row.createDiv({ cls: 'metadata-property-key' });
    const icon = name.createSpan({ cls: 'metadata-property-icon' });
    setIcon(icon, tags ? 'tags' : type === 'checkbox' ? 'check-square' : type === 'number' ? 'hash' : type === 'multitext' ? 'list' : 'text');
    name.createSpan({ cls: 'metadata-property-key-input', text: key, attr: { title: key } });
    const content = row.createDiv({ cls: 'metadata-property-value lgd-property-value' });
    if (typeof value === 'boolean') {
      const checkbox = content.createEl('input', { type: 'checkbox', attr: { 'aria-label': key } });
      checkbox.checked = value; checkbox.disabled = true;
      continue;
    }
    for (const item of Array.isArray(value) ? value : [value]) {
      const text = item == null ? '' : item instanceof Date ? item.toISOString() : typeof item === 'object' ? JSON.stringify(item) : String(item);
      const el = content.createDiv({ cls: Array.isArray(value) ? 'lgd-property-item multi-select-pill' : 'lgd-property-item' });
      if (!text) el.createSpan({ cls: 'lgd-property-empty', text: 'Empty' });
      else if (typeof item === 'object' || typeof item === 'number') el.setText(text);
      else await MarkdownRenderer.render(app, tags ? `#${text.replace(/^#/, '')}` : text, el, sourcePath, component);
    }
  }
}
