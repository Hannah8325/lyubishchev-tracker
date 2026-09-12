/*
 * 柳比歇夫时间账本 · Obsidian 插件
 * 双向同步：读取网页版导出的 *.time.json，合并后在 Obsidian 内编辑类别/归档类别，
 * 写回 sync.time.json，网页版可再导入 —— 形成双向闭环。
 */
const { Plugin, PluginSettingTab, Setting, ItemView, Notice, TFile, moment } = require('obsidian');

const VIEW_TYPE = 'lyubishchev-stats';
const SYNC_FILE = 'sync.time.json';
const DAY = 86400000;

const DEFAULT_SETTINGS = { folder: '时间账本' };

module.exports = class TimeLogPlugin extends Plugin {
  async onload() {
    const raw = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw && raw.settings);
    this.data = (raw && raw.data) || { categories: [], records: [] };

    this.registerView(VIEW_TYPE, (leaf) => new StatsView(leaf, this));
    this.addRibbonIcon('clock-3', '时间账本统计', () => this.activateView());
    this.addCommand({ id: 'open-stats', name: '打开时间账本统计视图', callback: () => this.activateView() });
    this.addCommand({ id: 'sync-now', name: '从导出文件同步数据', callback: () => this.syncFromExports() });
    this.addCommand({ id: 'daily-log', name: '把今日时间日志写入日记', callback: () => this.insertDailyLog() });
    this.addSettingTab(new TimeLogSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => this.syncFromExports(true));
  }

  async saveAll() {
    await this.saveData({ settings: this.settings, data: this.data });
    await this.writeSyncFile();
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf ? workspace.getRightLeaf(false) : workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  /* ---------- 同步 ---------- */
  async syncFromExports(silent) {
    const folder = this.settings.folder;
    const dir = this.app.vault.getAbstractFileByPath(folder);
    if (!dir) { if (!silent) new Notice(`请先创建文件夹「${folder}」，并把网页版导出的 .time.json 放进去`); return; }
    const files = this.app.vault.getFiles().filter(f =>
      f.path.startsWith(folder + '/') && f.name.endsWith('.time.json') && f.name !== SYNC_FILE);
    if (!files.length) { if (!silent) new Notice('没有找到 .time.json 导出文件'); return; }
    const byId = {};
    this.data.records.forEach(r => (byId[r.id] = r));
    const catById = {};
    this.data.categories.forEach(c => (catById[c.id] = c));
    let n = 0;
    for (const f of files) {
      try {
        const j = JSON.parse(await this.app.vault.read(f));
        (j.categories || []).forEach(c => { catById[c.id] = c; });
        (j.records || []).forEach(r => { byId[r.id] = r; n++; });
      } catch (e) { new Notice(`解析失败：${f.name}`); }
    }
    this.data.records = Object.values(byId).sort((a, b) => a.start - b.start);
    this.data.categories = Object.values(catById);
    await this.saveAll();
    if (!silent) new Notice(`已同步 ${n} 条记录 / ${this.data.categories.length} 个类别`);
    this.refreshView();
  }

  async writeSyncFile() {
    const folder = this.settings.folder;
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder).catch(() => {});
    const path = `${folder}/${SYNC_FILE}`;
    const payload = { app: 'lyubishchev-tracker', version: 1, updatedAt: Date.now(), ...this.data };
    const content = JSON.stringify(payload, null, 2);
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f && f instanceof TFile) await this.app.vault.modify(f, content);
    else await this.app.vault.create(path, content);
  }

  /* ---------- 今日日记 ---------- */
  async insertDailyLog() {
    const ds = new Date(); ds.setHours(0, 0, 0, 0);
    const recs = this.data.records.filter(r => r.start < ds.getTime() + DAY && r.end > ds.getTime());
    if (!recs.length) { new Notice('今天还没有记录'); return; }
    const cat = (id) => (this.data.categories.find(c => c.id === id) || { name: '未分类' }).name;
    const hm = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : m + 'm'; };
    const clock = (ts) => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
    const agg = {};
    recs.forEach(r => (agg[r.cat] = (agg[r.cat] || 0) + (r.end - r.start)));
    let md = `\n## ⏱ 时间日志\n\n`;
    Object.entries(agg).sort((a, b) => b[1] - a[1]).forEach(([id, ms]) => (md += `- **${cat(id)}** ${hm(ms)}\n`));
    md += `\n| 时间 | 事件 | 类别 | 时长 |\n|---|---|---|---|\n`;
    recs.forEach(r => (md += `| ${clock(r.start)}–${clock(r.end)} | ${r.name} | ${cat(r.cat)} | ${hm(r.end - r.start)} |\n`));
    // 优先追加到日记插件的今日笔记，否则新建独立文件
    const today = moment().format('YYYY-MM-DD');
    const candidates = [`${today}.md`, `日记/${today}.md`, `Daily/${today}.md`];
    let target = candidates.map(p => this.app.vault.getAbstractFileByPath(p)).find(f => f && f instanceof TFile);
    if (target) { await this.app.vault.append(target, md); new Notice(`已追加到 ${target.path}`); }
    else {
      const p = `${this.settings.folder}/${today}.md`;
      await this.app.vault.create(p, `# ${today}${md}`);
      new Notice(`已创建 ${p}`);
    }
  }

  refreshView() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (leaf && leaf.view instanceof StatsView) leaf.view.render();
  }
};

/* ================= 统计视图（含编辑 → 写回） ================= */
class StatsView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.p = plugin; this.mode = 'week'; this.off = 0; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return '时间账本'; }
  async onOpen() { this.render(); }
  range() {
    const now = new Date();
    if (this.mode === 'week') {
      const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) + this.off * 7);
      return [mon.getTime(), mon.getTime() + 7 * DAY];
    }
    const m = new Date(now.getFullYear(), now.getMonth() + this.off, 1);
    return [m.getTime(), new Date(now.getFullYear(), now.getMonth() + this.off + 1, 1).getTime()];
  }
  render() {
    const d = this.p.data;
    const [s, e] = this.range();
    const recs = d.records.filter(r => r.start < e && r.end > s);
    const agg = {}; recs.forEach(r => (agg[r.cat] = (agg[r.cat] || 0) + (r.end - r.start)));
    const cats = d.categories.length ? d.categories : [{ id: 'x', name: '未分类', color: '#94a3b8' }];
    const total = Object.values(agg).reduce((a, b) => a + b, 0) || 1;
    const items = Object.entries(agg).map(([id, ms]) => ({ c: cats.find(c => c.id === id) || { name: '未分类', color: '#94a3b8', id }, ms })).sort((a, b) => b.ms - a.ms);
    const hm = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : m + 'm'; };

    this.contentEl.empty();
    this.contentEl.style.padding = '10px';
    const ctrl = this.contentEl.createDiv({ attr: { style: 'display:flex;gap:6px;align-items:center;margin-bottom:10px' } });
    const seg = ctrl.createDiv({ attr: { style: 'display:flex;gap:2px;flex:1' } });
    ['week', 'month'].forEach(m => {
      const b = seg.createEl('button', { text: m === 'week' ? '本周' : '本月' });
      if (this.mode === m) b.classList.add('mod-cta');
      b.onclick = () => { this.mode = m; this.off = 0; this.render(); };
    });
    const prev = ctrl.createEl('button', { text: '‹' }); prev.onclick = () => { this.off--; this.render(); };
    const next = ctrl.createEl('button', { text: '›' }); next.onclick = () => { if (this.off < 0) { this.off++; this.render(); } };
    const resync = ctrl.createEl('button', { text: '⟳ 同步' }); resync.onclick = () => this.p.syncFromExports();

    const cvs = this.contentEl.createEl('canvas', { attr: { width: 460, height: 300, style: 'width:100%;max-width:460px;display:block;margin:0 auto' } });
    this.drawPie(cvs, items, total);
    const leg = this.contentEl.createDiv();
    items.forEach(i => {
      const row = leg.createDiv({ attr: { style: 'display:flex;align-items:center;gap:8px;font-size:13px;padding:4px 0;border-bottom:1px dashed var(--background-modifier-border)' } });
      row.createSpan({ attr: { style: `width:10px;height:10px;border-radius:3px;background:${i.c.color};flex:none` } });
      const name = row.createEl('input', { value: i.c.name, attr: { style: 'flex:1;border:none;background:transparent;color:var(--text-normal)' } });
      name.onchange = async () => { const c = d.categories.find(x => x.id === i.c.id); if (c) { c.name = name.value || c.name; await this.p.saveAll(); new Notice('类别已改名并写回同步文件'); } };
      const col = row.createEl('input', { attr: { type: 'color', value: i.c.color, style: 'width:26px;height:22px;border:none;background:none;padding:0' } });
      col.onchange = async () => { const c = d.categories.find(x => x.id === i.c.id); if (c) { c.color = col.value; await this.p.saveAll(); this.render(); } };
      row.createSpan({ text: `${hm(i.ms)} · ${(i.ms / total * 100).toFixed(1)}%`, attr: { style: 'color:var(--text-muted);font-size:12px' } });
    });
    if (!items.length) this.contentEl.createEl('p', { text: '该周期暂无记录。把网页版导出的 .time.json 放入同步文件夹后点「⟳ 同步」。', attr: { style: 'color:var(--text-muted)' } });
  }
  drawPie(cvs, items, total) {
    const ctx = cvs.getContext('2d'); ctx.clearRect(0, 0, cvs.width, cvs.height);
    const cx = cvs.width / 2, cy = cvs.height / 2, R = 118;
    let a = -Math.PI / 2;
    const hm = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h${m % 60}m` : m + 'm'; };
    items.forEach(i => {
      const a2 = a + i.ms / total * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, a, a2); ctx.closePath();
      ctx.fillStyle = i.c.color; ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1;
      const mid = (a + a2) / 2;
      if (i.ms / total > 0.04) {
        ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText((i.ms / total * 100).toFixed(0) + '%', cx + Math.cos(mid) * R * 0.68, cy + Math.sin(mid) * R * 0.68 + 4);
      }
      a = a2;
    });
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--background-primary') || '#fff';
    ctx.beginPath(); ctx.arc(cx, cy, 56, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = getComputedStyle(document.body).getPropertyValue('--text-normal') || '#222';
    ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(hm(total), cx, cy + 4);
    ctx.font = '11px sans-serif'; ctx.fillStyle = '#888'; ctx.fillText('总计', cx, cy + 22);
  }
}

/* ================= 设置页 ================= */
class TimeLogSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.p = plugin; }
  display() {
    const { containerEl } = this; containerEl.empty();
    containerEl.createEl('h2', { text: '柳比歇夫时间账本设置' });
    new Setting(containerEl)
      .setName('同步文件夹').setDesc('网页版导出的 .time.json 放在此文件夹；插件的修改会写回其中的 sync.time.json')
      .addText(t => t.setValue(this.p.settings.folder).onChange(async v => { this.p.settings.folder = v || '时间账本'; await this.p.saveAll(); }));
    new Setting(containerEl)
      .setName('立即同步').setDesc('扫描同步文件夹内的所有导出文件并合并')
      .addButton(b => b.setButtonText('同步').onClick(() => this.p.syncFromExports()));
  }
}
