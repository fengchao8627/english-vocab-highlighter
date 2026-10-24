// content.js - 扫描网页、生词标黄、悬停查词、隐式学习（没查看 = 会了）
(async function () {
  const S = await chrome.storage.local.get({
    enabled: true, level: 'senior', learnedWords: [], vocabBook: [],
    seenWithoutHover: {}, autoLearnThreshold: 3, selectionExplain: true
  });
  if (!S.enabled) return;

  const cutoff = LEVEL_CUTOFF[S.level] || 3500;
  const knownSet = new Set(FREQ_WORDS.slice(0, cutoff));
  (S.learnedWords || []).forEach(w => knownSet.add(w));
  const vocabSet = new Set(S.vocabBook || []); // 生词本里的词：用户明确说不会，一直标记直到手动点“我会了”

  const rankMap = new Map(FREQ_WORDS.map((w, i) => [w, i]));
  // 简单词形还原：复数/过去式/进行时先粗略还原再判断，避免把 knows/looked 误标成生词
  function lemma(word) {
    let w = word;
    if (w.length > 4 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (w.length > 3 && w.endsWith('es')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
    return w;
  }
  function isUnknown(raw) {
    const w = raw.toLowerCase();
    if (w.length <= 2) return false;
    if (knownSet.has(w) && !vocabSet.has(w)) return false;
    if (knownSet.has(lemma(w)) && !vocabSet.has(w)) return false;
    // 词频表里根本没有的长词/专名：只标记像正常英文单词的（全小写字母且长度>=4），大写开头视作专有名词跳过
    if (!rankMap.has(w) && !rankMap.has(lemma(w))) {
      if (/^[A-Z]/.test(raw)) return false;
      return w.length >= 4;
    }
    return true;
  }

  const pageWords = new Set();   // 本页出现过的生词（小写）
  const hoveredWords = new Set(); // 本页查看过的生词

  // ---- Tooltip ----
  const tip = document.createElement('div');
  tip.id = 'vocab-tooltip'; tip.style.display = 'none';
  document.documentElement.appendChild(tip);
  let hideTimer = null, currentWord = null, stickyTip = false;
  // 根因 1：悬停卡片和选区卡片共用同一个 tip，而 mouseleave 都会 350ms 后自动隐藏。
  // 选区卡片必须常驻：鼠标移开去滚动、复制翻译时也不应消失，只能点 ×、点空白处或按 Esc 关闭。
  function closeTip() { stickyTip = false; clearTimeout(hideTimer); tip.style.display = 'none'; }
  tip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  tip.addEventListener('mouseleave', () => { if (!stickyTip) scheduleHide(); });
  // 卡片内的 × 关闭按钮（委托绑定，innerHTML 重写后依然有效）
  tip.addEventListener('click', (e) => { if (e.target.closest?.('#vt-close')) closeTip(); });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---- 划词 / 划句解释：选中文字后弹出「解释」小按钮，点开看翻译 + 讲解 ----
  const selBtn = document.createElement('button');
  selBtn.id = 'vocab-select-btn'; selBtn.textContent = '✦ 解释选区'; selBtn.style.display = 'none';
  document.documentElement.appendChild(selBtn);
  let selRect = null, selText = '';
  function hideSelBtn() { selBtn.style.display = 'none'; selText = ''; }
  if (S.selectionExplain !== false) {
    // 根因 2：点「解释选区」时浏览器默认的 mousedown 会把焦点移到按钮上、导致选区塌陷，
    // 随后 document 的 mouseup 定时器看到选区已空就把按钮/状态清掉。preventDefault 保住选区。
    selBtn.addEventListener('mousedown', (e) => e.preventDefault());
    document.addEventListener('mouseup', (e) => {
      // 常驻卡片已打开时不再重新弹小按钮；点卡片/按钮本身的 mouseup 也不处理
      if (stickyTip) return;
      if (e.target.closest?.('#vocab-select-btn, #vocab-tooltip')) return;
      setTimeout(() => {
        if (stickyTip) return;
        const sel = window.getSelection();
        if (!sel || sel.isCollapsed) { hideSelBtn(); return; }
        const text = sel.toString().trim().replace(/\s+/g, ' ');
        const anchor = sel.anchorNode?.parentElement;
        if (!text || text.length < 2 || text.length > 600) { hideSelBtn(); return; }
        // 在输入框、卡片、按钮内部的选区不触发
        if (anchor?.closest?.('#vocab-tooltip, #vocab-select-btn, input, textarea, [contenteditable="true"]')) { hideSelBtn(); return; }
        if (!/[A-Za-z]/.test(text)) { hideSelBtn(); return; }
        try { selRect = sel.getRangeAt(0).getBoundingClientRect(); } catch (e) { hideSelBtn(); return; }
        selText = text;
        selBtn.style.display = 'block';
        selBtn.style.left = Math.min(selRect.right, window.innerWidth - 110) + 'px';
        selBtn.style.top = (selRect.bottom + 6) + 'px';
      }, 10);
    });
    document.addEventListener('mousedown', (e) => {
      if (e.target.closest?.('#vocab-select-btn, #vocab-tooltip')) return;
      hideSelBtn();
      if (stickyTip) closeTip(); // 常驻卡片：点空白处才关闭，鼠标移开不关闭
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { hideSelBtn(); closeTip(); } });
    selBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const text = selText, rect = selRect;
      hideSelBtn(); if (!text) return;
      clearTimeout(hideTimer);
      stickyTip = true; // 从这里起，mouseleave 不再自动隐藏
      tip.style.display = 'block';
      tip.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 360)) + 'px';
      tip.style.top = (rect.bottom + 8 + 240 > window.innerHeight ? Math.max(8, rect.top - 250) : rect.bottom + 8) + 'px';
      tip.innerHTML = `<button id="vt-close" title="关闭">×</button><div class="vt-quote">“${esc(text)}”</div><div class="vt-en">解释中…</div>`;
      chrome.runtime.sendMessage({ type: 'EXPLAIN_TEXT', text }, (res) => {
        // 注意：每次 innerHTML 重写都会丢掉 × 按钮，所以每个分支都要重新带上它
        const closeBtn = `<button id="vt-close" title="关闭">×</button>`;
        if (!res) { tip.innerHTML = `${closeBtn}<div class="vt-en">解释失败，请重试</div>`; return; }
        if (res.error === 'NO_API_KEY') {
          tip.innerHTML = `${closeBtn}<div class="vt-quote">“${esc(text)}”</div><div class="vt-en">未设置 API Key：请在插件设置里填入 API 地址、模型和 Key 后再试。</div>`;
          return;
        }
        if (res.error) { tip.innerHTML = `${closeBtn}<div class="vt-quote">“${esc(text)}”</div><div class="vt-en">解释失败：${esc(res.error)}</div>`; return; }
        if (res.kind === 'word') {
          tip.innerHTML = `${closeBtn}<div><span class="vt-word">${esc(res.word)}</span><span class="vt-phonetic">${esc(res.phonetic || '')}</span></div>${res.pos ? `<span class="vt-pos">${esc(res.pos)}</span>` : ''}<div class="vt-cn">${esc(res.meaning_cn || '')}</div><div class="vt-en">${esc(res.meaning_en || '')}</div>${res.example ? `<div class="vt-ex">${esc(res.example)}<br><span style="color:#888">${esc(res.example_cn || '')}</span></div>` : ''}`;
          return;
        }
        const kw = (res.key_words || []).map(k => `<span class="vt-kw"><b>${esc(k.word)}</b> ${esc(k.phonetic || '')} ${esc(k.meaning_cn || '')}</span>`).join('');
        tip.innerHTML = `${closeBtn}<div class="vt-quote">“${esc(res.text)}”</div><div class="vt-cn">${esc(res.translation_cn || '')}</div>${res.explanation ? `<div class="vt-en" style="margin-top:6px">${esc(res.explanation)}</div>` : ''}${kw ? `<div style="margin-top:8px">${kw}</div>` : ''}<div class="vt-hint">卡片常驻：点右上角 ×、点页面空白处或按 Esc 关闭；鼠标移开不再自动消失。选区解释结果同样会被缓存。</div>`;
      });
    });
  }

  function scheduleHide() { if (stickyTip) return; hideTimer = setTimeout(() => { tip.style.display = 'none'; }, 350); }
  function showTip(rect, word) {
    stickyTip = false; // 悬停卡片恢复原来的“移开 350ms 后消失”行为，不跟常驻卡片混用
    tip.style.display = 'block';
    const x = Math.min(rect.left, window.innerWidth - 360);
    const y = rect.bottom + 8 + 220 > window.innerHeight ? Math.max(8, rect.top - 230) : rect.bottom + 8;
    tip.style.left = Math.max(8, x) + 'px'; tip.style.top = y + 'px';
    tip.innerHTML = `<span class="vt-word">${word}</span><div class="vt-en">查询中…（DeepSeek）</div>`;
    chrome.runtime.sendMessage({ type: 'LOOKUP_WORD', word }, (res) => {
      if (currentWord !== word) return;
      if (!res || res.error) { tip.innerHTML = `<span class="vt-word">${word}</span><div class="vt-en">查询失败，请检查 DeepSeek Key / 网络</div>`; return; }
      tip.innerHTML = `
        <div><span class="vt-word">${res.word}</span><span class="vt-phonetic">${res.phonetic || ''}</span></div>
        ${res.pos ? `<span class="vt-pos">${res.pos}</span>` : ''}
        <div class="vt-cn">${res.meaning_cn || ''}</div>
        <div class="vt-en">${res.meaning_en || ''}</div>
        ${res.example ? `<div class="vt-ex">${res.example}<br><span style="color:#888">${res.example_cn || ''}</span></div>` : ''}
        <div class="vt-actions">
          <button class="primary" id="vt-known">✓ 我会了</button>
          <button id="vt-book">＋ 生词本</button>
        </div>
        <div class="vt-hint">点“我会了”后不再标记；加入生词本后会一直标记，直到你点“我会了”。</div>`;
      tip.querySelector('#vt-known')?.addEventListener('click', () => markKnown(word, true));
      tip.querySelector('#vt-book')?.addEventListener('click', (e) => { addToVocabBook(word); e.target.textContent = '✓ 已加入'; });
    });
  }

  async function markKnown(word, unhighlight) {
    const st = await chrome.storage.local.get({ learnedWords: [], vocabBook: [] });
    const learned = new Set(st.learnedWords); learned.add(word.toLowerCase());
    const book = (st.vocabBook || []).filter(w => w !== word.toLowerCase());
    await chrome.storage.local.set({ learnedWords: [...learned], vocabBook: book });
    if (unhighlight) {
      document.querySelectorAll(`.vocab-highlight[data-word="${CSS.escape(word.toLowerCase())}"]`).forEach(el => el.replaceWith(document.createTextNode(el.textContent)));
      tip.style.display = 'none';
    }
  }
  async function addToVocabBook(word) {
    const st = await chrome.storage.local.get({ vocabBook: [] });
    const book = new Set(st.vocabBook); book.add(word.toLowerCase());
    // 加入生词本的同时清掉隐式学习计数
    const seenSt = await chrome.storage.local.get({ seenWithoutHover: {} });
    const seen = seenSt.seenWithoutHover; delete seen[word.toLowerCase()];
    await chrome.storage.local.set({ vocabBook: [...book], seenWithoutHover: seen });
  }

  function bindMark(el, word) {
    const key = word.toLowerCase();
    el.addEventListener('mouseenter', () => {
      clearTimeout(hideTimer); currentWord = key; hoveredWords.add(key);
      showTip(el.getBoundingClientRect(), key);
    });
    el.addEventListener('mouseleave', scheduleHide);
  }

  // ---- 扫描文本节点并标记 ----
  const SKIP = new Set(['SCRIPT','STYLE','CODE','PRE','TEXTAREA','INPUT','NOSCRIPT','SVG']);
  function processNode(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !/[A-Za-z]/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        let p = node.parentElement;
        while (p) { if (SKIP.has(p.tagName) || p.classList?.contains('vocab-highlight') || p.id === 'vocab-tooltip' || p.isContentEditable) return NodeFilter.FILTER_REJECT; p = p.parentElement; }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    const WORD_RE = /[A-Za-z][A-Za-z'-]*/g;
    nodes.forEach(node => {
      const text = node.nodeValue; if (!WORD_RE.test(text)) return; WORD_RE.lastIndex = 0;
      const frag = document.createDocumentFragment(); let last = 0, m, changed = false;
      while ((m = WORD_RE.exec(text))) {
        const raw = m[0].replace(/^[-']+|[-']+$/g, '');
        if (!raw || !isUnknown(raw)) continue;
        changed = true;
        frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const mark = document.createElement('mark');
        mark.className = 'vocab-highlight'; mark.textContent = m[0]; mark.dataset.word = raw.toLowerCase();
        bindMark(mark, raw); frag.appendChild(mark);
        pageWords.add(raw.toLowerCase());
        last = m.index + m[0].length;
      }
      if (changed) { frag.appendChild(document.createTextNode(text.slice(last))); node.parentNode.replaceChild(frag, node); }
    });
  }
  processNode(document.body);

  // 动态内容（滚动加载/SPA）
  let debounce = null;
  new MutationObserver(muts => {
    clearTimeout(debounce);
    debounce = setTimeout(() => muts.forEach(mu => mu.addedNodes.forEach(n => { if (n.nodeType === 1 && n.tagName !== 'MARK') processNode(n); })), 600);
  }).observe(document.body, { childList: true, subtree: true });

  // ---- 隐式学习结算：页面隐藏/离开时，没被查看过的生词计数+1，达到阈值自动学会 ----
  let settled = false;
  async function settle() {
    if (settled) return; settled = true;
    const notViewed = [...pageWords].filter(w => !hoveredWords.has(w) && !vocabSet.has(w));
    if (!notViewed.length) return;
    const st = await chrome.storage.local.get({ seenWithoutHover: {}, learnedWords: [] });
    const seen = st.seenWithoutHover || {}; const learned = new Set(st.learnedWords || []);
    const pageKey = location.origin + location.pathname;
    notViewed.forEach(w => {
      const rec = seen[w] || { count: 0, pages: [] };
      if (!rec.pages.includes(pageKey)) { rec.count += 1; rec.pages.push(pageKey); if (rec.pages.length > 10) rec.pages.shift(); }
      seen[w] = rec;
      if (rec.count >= (S.autoLearnThreshold || 3)) { learned.add(w); delete seen[w]; }
    });
    await chrome.storage.local.set({ seenWithoutHover: seen, learnedWords: [...learned] });
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') settle(); });
  window.addEventListener('pagehide', settle);
})();
