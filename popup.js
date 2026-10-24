const $ = id => document.getElementById(id);
async function load() {
  const s = await chrome.storage.local.get({ enabled: true, level: 'senior', autoLearnThreshold: 3, selectionExplain: true, learnedWords: [], vocabBook: [], seenWithoutHover: {} });
  $('enabled').checked = s.enabled; $('selectionExplain').checked = s.selectionExplain !== false; $('level').value = s.level;
  $('threshold').value = s.autoLearnThreshold; $('thLabel').textContent = s.autoLearnThreshold;
  $('stats').innerHTML = `已自动学会：<b>${(s.learnedWords||[]).length}</b> 词<br>生词本：<b>${(s.vocabBook||[]).length}</b> 词<br>正在观察中（已出现未查看）：<b>${Object.keys(s.seenWithoutHover||{}).length}</b> 词`;
}
$('enabled').addEventListener('change', async e => { await chrome.storage.local.set({ enabled: e.target.checked }); });
$('selectionExplain').addEventListener('change', async e => { await chrome.storage.local.set({ selectionExplain: e.target.checked }); });
$('level').addEventListener('change', async e => { await chrome.storage.local.set({ level: e.target.value }); });
$('threshold').addEventListener('input', async e => { $('thLabel').textContent = e.target.value; await chrome.storage.local.set({ autoLearnThreshold: parseInt(e.target.value) }); });
$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('refresh').addEventListener('click', async () => { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); if (t) chrome.tabs.reload(t.id); window.close(); });
load();
