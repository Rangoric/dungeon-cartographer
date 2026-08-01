import { Plugin, TFile } from 'obsidian';
import { DungeonCartographerView, VIEW_TYPE } from './view';

export default class DungeonCartographerPlugin extends Plugin {
	async onload() {
		this.registerView(VIEW_TYPE, (leaf) => new DungeonCartographerView(leaf, this));
		this.registerExtensions(['dungeon.md'], VIEW_TYPE);

		this.registerEvent(
			this.app.workspace.on('file-open', async (file) => {
				if (!file?.path.endsWith('.dungeon.md')) return;
				await new Promise(r => setTimeout(r, 10));
				const leaves = this.app.workspace.getLeavesOfType('markdown');
				for (const leaf of leaves) {
					if ((leaf.view as any).file?.path === file.path) {
						await leaf.setViewState({ type: VIEW_TYPE, state: { file: file.path } });
					}
				}
			})
		);

		this.registerEvent(
			this.app.workspace.on('active-leaf-change', async (leaf) => {
				const view = leaf?.view as any;
				if (view?.getViewType?.() === 'markdown' && view.file?.path.endsWith('.dungeon.md')) {
					await leaf!.setViewState({ type: VIEW_TYPE, state: { file: view.file.path } });
				}
			})
		);

		this.addCommand({
			id: 'new-dungeon-floor',
			name: 'New Dungeon Floor',
			callback: async () => {
				const path = 'New Floor.dungeon.md';
				let file = this.app.vault.getAbstractFileByPath(path);
				if (!file) {
					file = await this.app.vault.create(path, '{}');
				}
				const leaf = this.app.workspace.getLeaf(false);
				await leaf.setViewState({ type: VIEW_TYPE, state: { file: (file as TFile).path } });
			}
		});
	}

	onunload() {}
}
