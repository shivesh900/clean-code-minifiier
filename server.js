const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Minification helpers ───────────────────────────────────────────────

/**
 * Minify JavaScript code.
 * - Strips single-line comments (//)
 * - Strips multi-line comments (/* … *\/)
 * - Collapses whitespace
 * - Tightens spacing around common symbols
 */
function minifyJS(code) {
  let result = code;

  // 1. Remove multi-line comments  /* ... */
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');

  // 2. Remove single-line comments  // ...
  //    Negative look-behind so we don't strip URLs (http:// , https://)
  result = result.replace(/(^|[^:])\/\/.*$/gm, '$1');

  // 3. Collapse multiple blank lines / whitespace into single spaces
  result = result.replace(/\s+/g, ' ');

  // 4. Tighten spacing around symbols
  result = result.replace(/\s*([{}();,:<>=+\-*\/!&|?])\s*/g, '$1');

  // 5. Restore necessary space after keywords
  const keywords = ['var', 'let', 'const', 'return', 'function', 'if', 'else', 'for', 'while', 'switch', 'case', 'typeof', 'instanceof', 'new', 'throw', 'in', 'of', 'class', 'extends', 'import', 'export', 'default', 'from', 'async', 'await', 'yield'];
  keywords.forEach((kw) => {
    const re = new RegExp(`\\b${kw}([^ ;({\\n])`, 'g');
    result = result.replace(re, `${kw} $1`);
  });

  return result.trim();
}

/**
 * Minify CSS code.
 * - Strips comments
 * - Collapses whitespace
 * - Removes spaces around CSS-specific symbols
 * - Removes trailing semicolons before closing braces
 */
function minifyCSS(code) {
  let result = code;

  // 1. Remove comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, '');

  // 2. Collapse whitespace
  result = result.replace(/\s+/g, ' ');

  // 3. Tighten around symbols
  result = result.replace(/\s*([{}:;,>~+])\s*/g, '$1');

  // 4. Remove last semicolon before }
  result = result.replace(/;}/g, '}');

  // 5. Remove spaces around !important
  result = result.replace(/\s*!\s*important/gi, '!important');

  return result.trim();
}

// ── Symbol Table Analyzer ────────────────────────────────────────────

/**
 * Analyze JS code and build a symbol table of variables, functions & classes.
 * Returns an array of { name, type, keyword, line } objects.
 */
function analyzeSymbols(code) {
  const symbols = [];
  const seen    = new Set();

  // Strip comments so they don't pollute matches
  let clean = code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')) // keep line numbers intact
    .replace(/(^|[^:])(\/\/.*$)/gm, '$1');

  const lines = clean.split('\n');

  const add = (name, type, keyword, lineNo) => {
    if (seen.has(name)) return;
    seen.add(name);
    symbols.push({ name, type, keyword, line: lineNo });
  };

  // 1. Function declarations:  function foo (...)
  const reFuncDecl = /\bfunction\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
  lines.forEach((line, i) => {
    let m;
    const re = new RegExp(reFuncDecl.source, 'g');
    while ((m = re.exec(line)) !== null) add(m[1], 'Function', 'function', i + 1);
  });

  // 2. Class declarations:  class Foo
  const reClassDecl = /\bclass\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
  lines.forEach((line, i) => {
    let m;
    const re = new RegExp(reClassDecl.source, 'g');
    while ((m = re.exec(line)) !== null) add(m[1], 'Class', 'class', i + 1);
  });

  // 3. var / let / const declarations
  //    Detect if the RHS looks like a function/arrow-fn
  const reVarDecl = /\b(var|let|const)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:=([^;\n]*))?/g;
  lines.forEach((line, i) => {
    let m;
    const re = new RegExp(reVarDecl.source, 'g');
    while ((m = re.exec(line)) !== null) {
      const keyword = m[1];
      const name    = m[2];
      const rhs     = (m[3] || '').trim();
      const isFn    = /^(async\s+)?function\b/.test(rhs) ||
                      /=>/.test(rhs) ||
                      /^(async\s+)?\(/.test(rhs);
      add(name, isFn ? 'Function' : 'Variable', keyword, i + 1);
    }
  });

  // Sort by line number, then alphabetically
  symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
  return symbols;
}

// ── API Routes ─────────────────────────────────────────────────────────

app.post('/minify', (req, res) => {
  const { code, language } = req.body;

  if (!code || !language) {
    return res.status(400).json({ error: 'Both "code" and "language" fields are required.' });
  }

  if (!['js', 'css'].includes(language)) {
    return res.status(400).json({ error: 'Language must be "js" or "css".' });
  }

  const originalSize = Buffer.byteLength(code, 'utf8');
  const output = language === 'js' ? minifyJS(code) : minifyCSS(code);
  const minifiedSize = Buffer.byteLength(output, 'utf8');

  res.json({
    originalSize,
    minifiedSize,
    output,
  });
});

app.post('/symbol-table', (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: '"code" field is required.' });
  }
  const symbols = analyzeSymbols(code);
  res.json({ symbols, count: symbols.length });
});

// ── Syntax Checker ─────────────────────────────────────────────────────

/**
 * Check bracket balance in source code.
 * Correctly skips string literals, line comments, and block comments
 * so brackets inside them don't produce false positives.
 *
 * Returns { valid: bool, errors: [{ type, message, line, col }] }
 */
function checkSyntax(code) {
  const errors  = [];
  const stack   = [];   // { ch, line, col }
  const PAIRS   = { ')': '(', '}': '{', ']': '[' };
  const OPENERS = new Set(['(', '{', '[']);
  const CLOSERS = new Set([')', '}', ']']);

  const lines = code.split('\n');

  let inBlockComment = false;
  let inLineComment  = false;
  let inString       = false;
  let stringChar     = '';

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    inLineComment = false;          // reset at every line

    for (let ci = 0; ci < line.length; ci++) {
      const ch   = line[ci];
      const next = line[ci + 1] ?? '';

      /* ── Inside block comment ── */
      if (inBlockComment) {
        if (ch === '*' && next === '/') { inBlockComment = false; ci++; }
        continue;
      }

      /* ── Inside line comment ── */
      if (inLineComment) continue;

      /* ── Inside string literal ── */
      if (inString) {
        if (ch === '\\') { ci++; continue; }      // skip escaped char
        if (ch === stringChar) inString = false;  // closing quote
        continue;
      }

      /* ── Detect start of block comment ── */
      if (ch === '/' && next === '*') { inBlockComment = true; ci++; continue; }

      /* ── Detect start of line comment ── */
      if (ch === '/' && next === '/') { inLineComment = true; continue; }

      /* ── Detect start of string ── */
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = true; stringChar = ch; continue;
      }

      /* ── Bracket logic ── */
      if (OPENERS.has(ch)) {
        stack.push({ ch, line: li + 1, col: ci + 1 });

      } else if (CLOSERS.has(ch)) {
        if (stack.length === 0) {
          errors.push({
            type: 'unexpected',
            message: `Unexpected closing '${ch}' — no matching opener`,
            line: li + 1,
            col: ci + 1,
          });
        } else {
          const top = stack[stack.length - 1];
          const expected = Object.keys(PAIRS).find(k => PAIRS[k] === top.ch);

          if (top.ch !== PAIRS[ch]) {
            errors.push({
              type: 'mismatch',
              message: `Bracket mismatch: '${ch}' found but expected '${expected}' to close '${top.ch}' (opened at line ${top.line}, col ${top.col})`,
              line: li + 1,
              col: ci + 1,
            });
            stack.pop(); // recover and continue
          } else {
            stack.pop(); // correctly matched
          }
        }
      }
    }
  }

  /* ── Unclosed openers still on the stack ── */
  for (const item of stack) {
    const closeChar = Object.keys(PAIRS).find(k => PAIRS[k] === item.ch);
    errors.push({
      type: 'unclosed',
      message: `Missing closing '${closeChar}' for '${item.ch}' opened at line ${item.line}, col ${item.col}`,
      line: item.line,
      col: item.col,
    });
  }

  /* ── Also flag unclosed string or block-comment ── */
  if (inString) {
    errors.push({
      type: 'unclosed',
      message: `Unterminated string literal (started with '${stringChar}')`,
      line: lines.length,
      col: null,
    });
  }
  if (inBlockComment) {
    errors.push({
      type: 'unclosed',
      message: `Unterminated block comment /* ... */ — missing closing '*/'`,
      line: lines.length,
      col: null,
    });
  }

  return { valid: errors.length === 0, errors };
}

app.post('/syntax-check', (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: '"code" field is required.' });
  }
  const result = checkSyntax(code);
  res.json(result);
});

// ── Start server ───────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✨ CleanCode Minifier running → http://localhost:${PORT}`);
});
