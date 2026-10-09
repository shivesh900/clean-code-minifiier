/* ================================================================
   CleanCode Minifier — Frontend Logic
   ================================================================ */

// ── DOM references ──────────────────────────────────────────────────
const inputCode     = document.getElementById('input-code');
const outputCode    = document.getElementById('output-code');
const languageSelect = document.getElementById('language-select');
const minifyBtn     = document.getElementById('minify-btn');
const copyBtn       = document.getElementById('copy-btn');
const clearBtn      = document.getElementById('clear-btn');

const inputSizeBadge  = document.getElementById('input-size');
const outputSizeBadge = document.getElementById('output-size');

const statsContainer  = document.getElementById('stats');
const verifyNote      = document.getElementById('verify-note');
const sampleBtn       = document.getElementById('sample-btn');
const statOriginalVal = document.getElementById('stat-original-val');
const statMinifiedVal = document.getElementById('stat-minified-val');
const statSavedVal    = document.getElementById('stat-saved-val');
const ringFg          = document.getElementById('ring-fg');
const ringLabel       = document.getElementById('ring-label');

// ── Helpers ─────────────────────────────────────────────────────────

/** Human-readable byte size */

// ── Local engine ────────────────────────────────────────────────────
// Everything runs in the browser through public/js/cleancode.js, so the
// app also works on static hosting. The Express server (server.js) exposes
// the very same engine as a JSON API for scripts and CI.
function engineFetch(url, opts = {}) {
  const body = JSON.parse(opts.body || '{}');
  const reply = (status, data) => ({ ok: status < 400, status, json: async () => data });
  try {
    if (url === '/minify') {
      if (!['js', 'css'].includes(body.language)) return reply(400, { error: 'Language must be "js" or "css".' });
      return reply(200, CleanCode.minify(body.code, body.language));
    }
    if (url === '/symbol-table') {
      const symbols = CleanCode.analyzeSymbols(body.code);
      return reply(200, { symbols, count: symbols.length });
    }
    if (url === '/syntax-check') return reply(200, CleanCode.checkSyntax(body.code, body.language));
    return reply(404, { error: 'Unknown route' });
  } catch (err) {
    const where = err.line ? ` (line ${err.line}${err.col ? `, col ${err.col}` : ''})` : '';
    return reply(422, { error: `Couldn't parse the input: ${err.message}${where}` });
  }
}

const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/** Quick byte length (matches backend Buffer.byteLength for ASCII-heavy code) */
function byteLen(str) {
  return new Blob([str]).size;
}

/** Show a temporary toast message */
function showToast(msg) {
  let toast = document.querySelector('.toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2200);
}

// ── Live input-size badge ───────────────────────────────────────────
inputCode.addEventListener('input', () => {
  inputSizeBadge.textContent = formatBytes(byteLen(inputCode.value));
});

// ── Minify action ───────────────────────────────────────────────────
minifyBtn.addEventListener('click', async () => {
  const code = inputCode.value.trim();
  if (!code) {
    showToast('⚠️  Paste some code first!');
    return;
  }

  // Indicate loading
  minifyBtn.disabled = true;
  minifyBtn.innerHTML = '<span class="btn__icon">⏳</span> Minifying…';

  try {
    const res = await engineFetch('/minify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        language: languageSelect.value,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }

    const data = await res.json();

    // Populate output
    outputCode.value = data.output;
    outputSizeBadge.textContent = formatBytes(data.minifiedSize);
    copyBtn.disabled = false;

    // ── Stats ──
    statOriginalVal.textContent = formatBytes(data.originalSize);
    statMinifiedVal.textContent = formatBytes(data.minifiedSize);

    const saved = data.originalSize - data.minifiedSize;
    const pct   = data.originalSize > 0
      ? Math.round((saved / data.originalSize) * 100)
      : 0;

    statSavedVal.textContent = `${formatBytes(saved)} (${pct}%)`;

    // Animate ring
    const circumference = 2 * Math.PI * 34; // r=34
    const offset = circumference - (circumference * pct) / 100;
    ringFg.style.strokeDashoffset = offset;
    ringLabel.textContent = `${pct}%`;

    statsContainer.classList.add('visible');
    verifyNote.className = 'verify-note visible ' + (data.verified === false ? 'verify-note--bad' : 'verify-note--ok');
    verifyNote.textContent = data.verified === true
      ? '✓ Verified: the minified code parses to exactly the same program (identical AST) as your input.'
      : data.verified === false
        ? '⚠ Could not verify the output — please report this input.'
        : '✓ CSS minified: comments and redundant whitespace removed; strings, url() and calc() untouched.';
    showToast(data.verified === false ? '⚠️  Minified, but verification failed' : '✅  Minification complete!');
  } catch (err) {
    showToast(`❌  ${err.message}`);
  } finally {
    minifyBtn.disabled = false;
    minifyBtn.innerHTML = '<span class="btn__icon">▶</span> Minify';
  }
});

// ── Copy output ─────────────────────────────────────────────────────
copyBtn.addEventListener('click', async () => {
  if (!outputCode.value) return;
  try {
    await navigator.clipboard.writeText(outputCode.value);
    showToast('📋  Copied to clipboard!');
  } catch {
    showToast('❌  Copy failed — check permissions');
  }
});

// ── Clear ───────────────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  inputCode.value = '';
  outputCode.value = '';
  inputSizeBadge.textContent = '0 B';
  outputSizeBadge.textContent = '0 B';
  copyBtn.disabled = true;
  statsContainer.classList.remove('visible');
  verifyNote.classList.remove('visible');

  // Reset ring
  const circumference = 2 * Math.PI * 34;
  ringFg.style.strokeDashoffset = circumference;
  ringLabel.textContent = '0%';

  // Also close symbol panel
  symPanel.classList.remove('open');

  showToast('🧹  Cleared!');
});

// ── Symbol Table ────────────────────────────────────────────────────
const symbolBtn  = document.getElementById('symbol-btn');
const symPanel   = document.getElementById('sym-panel');
const symClose   = document.getElementById('sym-close');
const symTbody   = document.getElementById('sym-tbody');
const symMeta    = document.getElementById('sym-meta');
const symEmpty   = document.getElementById('sym-empty');

/** Map type → badge CSS modifier */
const typeBadge = (type) => {
  const t = type.toLowerCase();
  const icons = { function: 'ƒ', variable: 'x', class: '◈', parameter: '→', import: '⇣' };
  return `<span class="sym-badge sym-badge--${t}">${icons[t] || ''} ${type}</span>`;
};

/** Map keyword → pill CSS modifier */
const kwPill = (kw) =>
  `<span class="sym-kw sym-kw--${kw}">${kw}</span>`;

symbolBtn.addEventListener('click', async () => {
  const code = inputCode.value.trim();
  if (!code) {
    showToast('⚠️  Paste some JavaScript code first!');
    return;
  }
  if (languageSelect.value !== 'js') {
    showToast('ℹ️  Symbol Table works with JavaScript only.');
    return;
  }

  symbolBtn.disabled = true;
  symbolBtn.innerHTML = '<span class="btn__icon">⏳</span> Analyzing…';

  try {
    const res = await engineFetch('/symbol-table', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }

    const data = await res.json();       // { symbols: [...], count: N }
    const { symbols, count } = data;

    // Update meta pill
    symMeta.textContent = `${count} symbol${count !== 1 ? 's' : ''} found`;

    // Render rows
    symTbody.innerHTML = '';

    if (count === 0) {
      symEmpty.style.display = 'block';
      document.getElementById('sym-table').style.display = 'none';
    } else {
      symEmpty.style.display = 'none';
      document.getElementById('sym-table').style.display = '';

      symbols.forEach((sym, i) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td>${i + 1}</td>
          <td>${escapeHTML(sym.name)}</td>
          <td>${typeBadge(sym.type)}</td>
          <td>${kwPill(sym.keyword)}</td>
          <td>${escapeHTML(sym.scope || 'global')}</td>
          <td>${sym.line}</td>
        `;
        symTbody.appendChild(tr);
      });
    }

    // Open panel with animation
    symPanel.classList.add('open');
    symPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    showToast(`🔍  Found ${count} symbol${count !== 1 ? 's' : ''}!`);

  } catch (err) {
    showToast(`❌  ${err.message}`);
  } finally {
    symbolBtn.disabled = false;
    symbolBtn.innerHTML = '<span class="btn__icon">🔍</span> Symbol Table';
  }
});

// Close panel
symClose.addEventListener('click', () => {
  symPanel.classList.remove('open');
});

// ── Syntax Checker ──────────────────────────────────────────────────
const syntaxBtn   = document.getElementById('syntax-btn');
const sxPanel     = document.getElementById('sx-panel');
const sxClose     = document.getElementById('sx-close');
const sxMeta      = document.getElementById('sx-meta');
const sxPanelTitle = document.getElementById('sx-panel-title');
const sxOk        = document.getElementById('sx-ok');
const sxErrors    = document.getElementById('sx-errors');

/** Icon per error type */
const errorIcon = { unclosed: '🔴', mismatch: '🟠', unexpected: '🟣', syntax: '⛔' };

/** Human label per error type */
const errorLabel = { unclosed: 'Unclosed', mismatch: 'Mismatch', unexpected: 'Unexpected', syntax: 'Parse error' };

syntaxBtn.addEventListener('click', async () => {
  const code = inputCode.value.trim();
  if (!code) {
    showToast('⚠️  Paste some code first!');
    return;
  }

  // Loading state
  syntaxBtn.disabled = true;
  syntaxBtn.classList.add('checking');
  syntaxBtn.innerHTML = '<span class="btn__icon">⏳</span> Checking…';

  try {
    const res = await engineFetch('/syntax-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, language: languageSelect.value }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Server error');
    }

    const data = await res.json();   // { valid, errors, parser }

    // ── Reset panel state ──
    sxPanel.classList.remove('sx-valid', 'sx-invalid');
    sxOk.classList.remove('visible');
    sxErrors.innerHTML = '';

    if (data.valid) {
      // ── VALID ──────────────────────────────────────────────────
      sxPanel.classList.add('open', 'sx-valid');
      sxPanelTitle.textContent = '✓ Syntax Check';
      sxMeta.textContent = data.parser === 'acorn' ? 'No errors · full ES2024 parse' : 'No errors · bracket check';
      sxOk.classList.add('visible');
      showToast('✅  Syntax looks good!');

    } else {
      // ── INVALID ────────────────────────────────────────────────
      const count = data.errors.length;
      sxPanel.classList.add('open', 'sx-invalid');
      sxPanelTitle.textContent = '✗ Syntax Check';
      sxMeta.textContent = `${count} error${count !== 1 ? 's' : ''} found`;

      data.errors.forEach((err, i) => {
        const li = document.createElement('li');
        li.className = 'sx-error-item';
        li.dataset.type = err.type;

        // stagger animation delay
        li.style.animationDelay = `${i * 60}ms`;

        const locParts = [];
        if (err.line) locParts.push(`Line ${err.line}`);
        if (err.col)  locParts.push(`Col ${err.col}`);
        const locText = locParts.length ? locParts.join(' · ') : 'Unknown location';

        li.innerHTML = `
          <span class="sx-error-icon">${errorIcon[err.type] || '🔴'}</span>
          <div class="sx-error-content">
            <div class="sx-error-msg">${escapeHTML(err.message)}</div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span class="sx-error-loc">📍 ${locText}</span>
              <span class="sx-type-pill sx-type-pill--${err.type}">${errorLabel[err.type] || err.type}</span>
            </div>
          </div>
        `;
        sxErrors.appendChild(li);
      });

      showToast(`❌  ${count} syntax error${count !== 1 ? 's' : ''} found`);
    }

    sxPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  } catch (err) {
    showToast(`❌  ${err.message}`);
  } finally {
    syntaxBtn.disabled = false;
    syntaxBtn.classList.remove('checking');
    syntaxBtn.innerHTML = '<span class="btn__icon">✓</span> Check Syntax';
  }
});

// Close syntax panel
sxClose.addEventListener('click', () => {
  sxPanel.classList.remove('open');
});

// Also close syntax panel on Clear
clearBtn.addEventListener('click', () => {
  sxPanel.classList.remove('open', 'sx-valid', 'sx-invalid');
}, { capture: false });

// ── Sample code ─────────────────────────────────────────────────────
const SAMPLES = {
  js: `// Shopping cart helpers — try Minify, Symbol Table and Check Syntax
const TAX_RATE = 0.18; // 18% GST
const information = "Prices include GST // shown at checkout";

function formatPrice(amount) {
  return \`₹\${amount.toFixed(2)}\`;
}

class Cart {
  constructor(owner) {
    this.owner = owner;
    this.items = [];
  }

  add(name, price, qty = 1) {
    this.items.push({ name, price, qty });
    return this;
  }

  get total() {
    const subtotal = this.items.reduce((sum, { price, qty }) => sum + price * qty, 0);
    return subtotal * (1 + TAX_RATE);
  }
}

let newOffer = /^SAVE\\d{2}$/i.test("SAVE10")
let count = 0
++count

const cart = new Cart("Shivesh").add("Keyboard", 2499).add("Mouse", 799, 2);
console.log(information, formatPrice(cart.total), newOffer, count);
`,
  css: `/* Card component */
.card {
  display: grid;
  gap: 1rem;
  padding: calc(1rem + 2px) 1.5rem;
  background: url("img/card bg.png") no-repeat , #0b0e14;
  color : #e6e6e6 ;
}

.card :hover > .title + .subtitle {
  color: hsl(260 80% 70%);
}

@media screen and (max-width: 600px) {
  .card { padding: 0.75rem !important; }
}
`,
};

sampleBtn?.addEventListener('click', () => {
  inputCode.value = SAMPLES[languageSelect.value] || SAMPLES.js;
  inputCode.dispatchEvent(new Event('input'));
  showToast('✨  Sample loaded — hit Minify');
});
