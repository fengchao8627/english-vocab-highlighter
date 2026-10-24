const $ = id => document.getElementById(id);
async function saveApiSettings() {
  await chrome.storage.local.set({
    deepseekApiKey: $('apiKey').value.trim(),
    apiBaseUrl: $('apiBaseUrl').value.trim() || 'https://api.deepseek.com',
    apiModel: $('apiModel').value.trim() || 'deepseek-flash',
    selectionExplain: $('selectionExplain').checked
  });
}
async function render() {
  const s = await chrome.storage.local.get({ deepseekApiKey: '', apiBaseUrl: 'https://api.deepseek.com', apiModel: 'deepseek-flash', selectionExplain: true, learnedWords: [], vocabBook: [] });
  $('apiKey').value = s.deepseekApiKey || '';
  $('apiBaseUrl').value = s.apiBaseUrl || 'https://api.deepseek.com';
  $('apiModel').value = s.apiModel || 'deepseek-flash';
  $('selectionExplain').checked = s.selectionExplain !== false;
  const renderList = (el, countEl, words, key) => {
    $(countEl).textContent = words.length;
    $(el).innerHTML = words.length ? words.map(w => `<span class="chip">${w}<b data-k="${key}" data-w="${w}">×</b></span>`).join('') : '<span class="hint">（空）</span>';
  };
  renderList('learnedList', 'learnedCount', s.learnedWords || [], 'learnedWords');
  renderList('bookList', 'bookCount', s.vocabBook || [], 'vocabBook');
  document.querySelectorAll('.chip b').forEach(b => b.addEventListener('click', async () => {
    const st = await chrome.storage.local.get({ learnedWords: [], vocabBook: [] });
    const arr = (st[b.dataset.k] || []).filter(w => w !== b.dataset.w);
    await chrome.storage.local.set({ [b.dataset.k]: arr }); render();
  }));
}
$('saveKey').addEventListener('click', async () => { await saveApiSettings(); $('keyStatus').innerHTML = ' <span class="ok">✓ 已保存</span>'; });
$('selectionExplain').addEventListener('change', saveApiSettings);
$('testKey').addEventListener('click', async () => {
  await saveApiSettings();
  $('keyStatus').textContent = ' 查询中…';
  chrome.runtime.sendMessage({ type: 'LOOKUP_WORD', word: 'abandon' }, res => {
    $('keyStatus').innerHTML = res && !res.error ? ` <span class="ok">✓ 成功：${res.phonetic || ''} ${res.meaning_cn || res.meaning_en || ''}（来源 ${res.source || ''}）</span>` : ` ✗ 失败：${res?.error || '请检查地址 / 模型 / Key'}`;
  });
});
$('testSentence').addEventListener('click', async () => {
  await saveApiSettings();
  $('keyStatus').textContent = ' 划句测试中…';
  chrome.runtime.sendMessage({ type: 'EXPLAIN_TEXT', text: 'It is not simply competition, there is also a surprising amount of cooperation.' }, res => {
    $('keyStatus').innerHTML = res && !res.error ? ` <span class="ok">✓ 成功：${res.translation_cn || ''}</span>` : ` ✗ 失败：${res?.error || '请检查地址 / 模型 / Key'}`;
  });
});
$('exportBtn').addEventListener('click', async () => {
  const s = await chrome.storage.local.get({ learnedWords: [], vocabBook: [], level: 'senior' });
  $('exportBox').value = JSON.stringify(s, null, 2);
});
$('importBtn').addEventListener('click', async () => {
  try { const d = JSON.parse($('exportBox').value); await chrome.storage.local.set({ learnedWords: d.learnedWords || [], vocabBook: d.vocabBook || [] }); render(); alert('导入成功'); }
  catch (e) { alert('JSON 格式不对'); }
});
$('clearSeen').addEventListener('click', async () => { await chrome.storage.local.set({ seenWithoutHover: {} }); alert('已清空'); });
$('clearCache').addEventListener('click', async () => { await chrome.storage.local.set({ dictCache: {}, explainCache: {} }); alert('已清空'); });
render();
