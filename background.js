// background.js - 负责调用可配置的 OpenAI 兼容 API / 免费词典
// API 地址和模型不再写死：用户在设置页填 Base URL + 模型，默认是 DeepSeek。
// 兼容任何 OpenAI 格式的接口：DeepSeek、OpenAI、硅基流动、本地 Ollama 兼容服务等。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'LOOKUP_WORD') {
    lookupWord(msg.word).then(sendResponse).catch(e => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === 'EXPLAIN_TEXT') {
    explainText(msg.text).then(sendResponse).catch(e => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === 'TEST_API') {
    testApi().then(sendResponse).catch(e => sendResponse({ error: String(e) }));
    return true;
  }
});

const DEFAULT_BASE = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-flash';

async function getApiConfig() {
  const s = await chrome.storage.local.get({
    deepseekApiKey: '', apiBaseUrl: DEFAULT_BASE, apiModel: DEFAULT_MODEL
  });
  const base = (s.apiBaseUrl || DEFAULT_BASE).trim().replace(/\/+$/, '');
  return {
    apiKey: (s.deepseekApiKey || '').trim(),
    model: (s.apiModel || DEFAULT_MODEL).trim(),
    // 允许两种填法：填 Base（如 https://api.deepseek.com）或完整地址（如 .../chat/completions），都归一化
    endpoint: base.endsWith('/chat/completions') ? base : base + '/chat/completions',
    base
  };
}

async function chatCompletions(messages, temperature = 0.2) {
  const cfg = await getApiConfig();
  if (!cfg.apiKey) throw new Error('NO_API_KEY');
  const resp = await fetch(cfg.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, temperature, messages })
  });
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json()).error?.message || ''; } catch (e) {}
    throw new Error(`API HTTP ${resp.status}${detail ? ': ' + detail : ''}（地址：${cfg.endpoint}，模型：${cfg.model}）`);
  }
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error('API 返回为空');
  return { cfg, text };
}

function parseJsonLoose(text) {
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}

async function lookupWord(word) {
  const w = word.toLowerCase();
  const cached = await chrome.storage.local.get(['dictCache']);
  const cache = cached.dictCache || {};
  if (cache[w]) return { ...cache[w], fromCache: true };

  const cfg = await getApiConfig();
  let result = null;
  if (cfg.apiKey) {
    try {
      const { text } = await chatCompletions([
        { role: 'system', content: 'You are a dictionary. Reply ONLY with valid JSON, no markdown fences.' },
        { role: 'user', content: `单词 "${w}"，请返回JSON: {"phonetic":"英式音标,如 /əˈbændən/","pos":"词性,如 vt.","meaning_cn":"最常用的中文释义,2-3个以内","meaning_en":"简短英文释义","example":"一个简单英文例句","example_cn":"例句中文翻译"} 如果是变形词请按原形释义。` }
      ]);
      const p = parseJsonLoose(text);
      result = { word: w, phonetic: p.phonetic || '', pos: p.pos || '', meaning_cn: p.meaning_cn || '', meaning_en: p.meaning_en || '', example: p.example || '', example_cn: p.example_cn || '', source: cfg.model };
    } catch (e) { console.warn('API lookup failed', e); result = { errorDetail: String(e) }; }
  }
  if (!result || result.errorDetail) {
    const fallback = await lookupViaFreeDict(w).catch(() => null);
    if (fallback) result = fallback;
    else if (result?.errorDetail) return { word: w, error: result.errorDetail };
    else result = { word: w, phonetic: '', pos: '', meaning_cn: '暂未查到释义', meaning_en: '', example: '', example_cn: '', needApiKey: !cfg.apiKey };
  }
  cache[w] = result;
  const keys = Object.keys(cache);
  if (keys.length > 2000) keys.slice(0, keys.length - 2000).forEach(k => delete cache[k]);
  await chrome.storage.local.set({ dictCache: cache });
  return result;
}

// 划词 / 划句解释：单个词走查词；词组或句子走翻译 + 结构讲解 + 生词拆解
async function explainText(rawText) {
  const text = (rawText || '').trim().replace(/\s+/g, ' ');
  if (!text) return { error: '空选区' };
  const isSingleWord = /^[A-Za-z][A-Za-z'-]*$/.test(text);
  if (isSingleWord) {
    const r = await lookupWord(text);
    return { kind: 'word', ...r };
  }
  const cached = await chrome.storage.local.get(['explainCache']);
  const cache = cached.explainCache || {};
  if (cache[text]) return { kind: 'sentence', ...cache[text], fromCache: true };

  const cfg = await getApiConfig();
  if (!cfg.apiKey) return { kind: 'sentence', error: 'NO_API_KEY', text };
  try {
    const { text: out } = await chatCompletions([
      { role: 'system', content: 'You are an English tutor for Chinese learners. Reply ONLY with valid JSON, no markdown fences. Keep it concise.' },
      { role: 'user', content: `请解释这段英文（可能是词组或句子）："${text}"。返回JSON: {"translation_cn":"自然流畅的中文翻译","explanation":"用中文讲清这句话的结构、难句点或词组用法，2-4句，不要啰嗦","key_words":[{"word":"生词或难词","phonetic":"/音标/","meaning_cn":"中文释义"}]} key_words 最多 5 个，只挑真正值得记的词，不要把简单词也列进来。` }
    ], 0.3);
    const p = parseJsonLoose(out);
    const result = { kind: 'sentence', text, translation_cn: p.translation_cn || '', explanation: p.explanation || '', key_words: Array.isArray(p.key_words) ? p.key_words.slice(0, 5) : [], source: cfg.model };
    cache[text] = result;
    const keys = Object.keys(cache);
    if (keys.length > 500) keys.slice(0, keys.length - 500).forEach(k => delete cache[k]);
    await chrome.storage.local.set({ explainCache: cache });
    return result;
  } catch (e) {
    return { kind: 'sentence', text, error: String(e) };
  }
}

async function testApi() {
  const cfg = await getApiConfig();
  if (!cfg.apiKey) return { error: '请先填写 API Key' };
  try {
    const { text } = await chatCompletions([
      { role: 'system', content: 'Reply ONLY with valid JSON.' },
      { role: 'user', content: '单词 "abandon"，返回JSON: {"phonetic":"/əˈbændən/","meaning_cn":"放弃"}' }
    ]);
    return { ok: true, model: cfg.model, endpoint: cfg.endpoint, sample: parseJsonLoose(text) };
  } catch (e) { return { error: String(e), model: cfg.model, endpoint: cfg.endpoint }; }
}

async function lookupViaFreeDict(word) {
  const resp = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
  if (!resp.ok) return null;
  const arr = await resp.json();
  const entry = arr[0];
  if (!entry) return null;
  const meaning = entry.meanings?.[0];
  return {
    word,
    phonetic: entry.phonetic || entry.phonetics?.find(p => p.text)?.text || '',
    pos: meaning?.partOfSpeech || '',
    meaning_cn: '(未设置 API Key，仅显示英文释义 — 在插件设置里填 Key 后可看中文)',
    meaning_en: meaning?.definitions?.[0]?.definition || '',
    example: meaning?.definitions?.[0]?.example || '',
    example_cn: '',
    source: 'FreeDictionary'
  };
}
