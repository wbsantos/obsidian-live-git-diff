import { App, Modal, Setting } from 'obsidian';
import type { RemoteTarget } from './repositoryRemote.ts';

export interface RemoteTargetModalOptions {
  remotes: string[];
  branches: string[];
  initial?: RemoteTarget;
  title?: string;
  submitLabel?: string;
  onSubmit(target: RemoteTarget): Promise<void>;
  onCancel?(): void;
}

/** Remote selection is stored per repository; opening this dialog never contacts a remote. */
export class RemoteTargetModal extends Modal {
  private options: RemoteTargetModalOptions;
  private saving = false;
  private completed = false;

  constructor(app: App, options: RemoteTargetModalOptions) { super(app); this.options = options; }

  onOpen(): void {
    this.titleEl.setText(this.options.title || 'Remote settings');
    const { contentEl } = this, options = this.options;
    let remote = options.remotes.includes(options.initial?.remote || '') ? options.initial!.remote : options.remotes[0] || '';
    let branch = options.initial?.branch || '';
    new Setting(contentEl).setName('Remote').addDropdown(dropdown => {
      if (!options.remotes.length) dropdown.addOption('', 'No remotes');
      for (const name of options.remotes) dropdown.addOption(name, name);
      dropdown.setValue(remote).setDisabled(!options.remotes.length).onChange(value => { remote = value; update(); });
      dropdown.selectEl.setAttribute('aria-label', 'Remote');
    });
    const listId = `change-review-branches-${Math.random().toString(36).slice(2)}`;
    const suggestions = contentEl.createEl('datalist', { attr: { id: listId } });
    for (const name of [...new Set(options.branches)]) suggestions.createEl('option', { attr: { value: name } });
    let branchInput: HTMLInputElement;
    new Setting(contentEl).setName('Branch').addText(text => {
      branchInput = text.inputEl;
      text.setValue(branch).onChange(value => { branch = value; update(); });
      text.inputEl.setAttribute('list', listId); text.inputEl.setAttribute('aria-label', 'Branch');
      text.inputEl.spellcheck = false;
    });
    const error = contentEl.createDiv({ cls: 'lgd-error', attr: { role: 'alert' } });
    error.hidden = options.remotes.length > 0;
    if (!options.remotes.length) error.setText('Configure a remote in this repository first.');
    const actions = new Setting(contentEl);
    actions.addButton(button => {
      button.setButtonText('Cancel').onClick(() => this.close());
    });
    let save: HTMLButtonElement;
    const update = (): void => { if (save) save.disabled = this.saving || !remote || !branch.trim(); };
    const submit = async (): Promise<void> => {
      if (this.saving || !remote || !branch.trim()) return;
      this.saving = true; error.setText(''); error.hidden = true;
      for (const control of Array.from(contentEl.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button'))) control.disabled = true;
      try {
        await options.onSubmit({ remote, branch: branch.trim() });
        this.completed = true; this.close();
      } catch (failure) {
        error.setText(String((failure as Error).message || failure)); error.hidden = false;
        for (const control of Array.from(contentEl.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input,select,button'))) control.disabled = false;
      } finally { this.saving = false; update(); }
    };
    actions.addButton(button => {
      save = button.buttonEl; button.setButtonText(options.submitLabel || 'Save').setCta().onClick(submit);
    });
    branchInput!.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void submit(); }
    });
    update();
    branchInput!.focus();
  }

  onClose(): void { if (!this.completed) this.options.onCancel?.(); this.contentEl.empty(); }
}
