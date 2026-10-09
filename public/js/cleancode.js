/* ================================================================
   CleanCode engine — tokenizer-based JavaScript & CSS minifier,
   symbol table and syntax checker.

   Runs in the browser (window.CleanCode) and in Node (require).
   Uses acorn (MIT) when available to parse JavaScript, so the
   minifier can prove its output has the same AST as the input.
   ================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    let acorn = null;
    try { acorn = require('acorn'); } catch (e) { /* optional */ }
    module.exports = factory(acorn);
  } else {
    root.CleanCode = factory(root.acorn || null);
  }
})(typeof self !== 'undefined' ? self : this, function (acorn) {
  'use strict';

  // ── JavaScript tokenizer ────────────────────────────────────────────
  // Token types: name, num, string, template, regex, punct,
  //              ws (spaces/tabs), nl (line breaks), comment.

  const PUNCTUATORS = [
    '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
    '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=',
    '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '**',
    '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%',
    '&', '|', '^', '!', '~', '?', ':', '=', '.', '@', '#',
  ];

  // After these keywords a "/" starts a regular expression, not a division.
  const REGEX_AFTER_WORDS = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
    'case', 'do', 'else', 'yield', 'await',
  ]);

  const isIdStart = (ch) => /[\p{ID_Start}$_\\]/u.test(ch);
  const isIdPart = (ch) => /[\p{ID_Continue}$_\\\u200c\u200d]/u.test(ch);

  class SyntaxIssue extends Error {
    constructor(message, line, col) {
      super(message);
      this.line = line;
      this.col = col;
    }
  }

  function tokenizeJS(src) {
    const tokens = [];
    const braceStack = []; // 'brace' | 'template'
    let i = 0, line = 1, col = 1;
    let lastSig = null; // last significant (non-ws/comment) token

    const advance = (text) => {
      for (const ch of text) {
        if (ch === '\n') { line++; col = 1; } else col++;
      }
      i += text.length;
    };
    const push = (type, value) => {
      const tok = { type, value, line, col };
      tokens.push(tok);
      advance(value);
      if (type !== 'ws' && type !== 'nl' && type !== 'comment') lastSig = tok;
      return tok;
    };

    const regexAllowed = () => {
      if (!lastSig) return true;
      if (lastSig.type === 'num' || lastSig.type === 'string' || lastSig.type === 'regex') return false;
      if (lastSig.type === 'template') return lastSig.value.endsWith('${');
      if (lastSig.type === 'name') return REGEX_AFTER_WORDS.has(lastSig.value);
      if (lastSig.type === 'punct') return !/^(\)|\]|\+\+|--)$/.test(lastSig.value);
      return true;
    };

    // Reads a template chunk starting at i (just after ` or a closing } of ${…}).
    const readTemplate = (startChar) => {
      let j = i + startChar.length;
      while (j < src.length) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '`') return { text: src.slice(i, j + 1), opensExpr: false };
        if (ch === '$' && src[j + 1] === '{') return { text: src.slice(i, j + 2), opensExpr: true };
        j++;
      }
      throw new SyntaxIssue('Unterminated template literal', line, col);
    };

    while (i < src.length) {
      const ch = src[i];
      const rest2 = src.slice(i, i + 2);

      if (i === 0 && rest2 === '#!') { // hashbang
        const end = src.indexOf('\n');
        push('comment', end === -1 ? src : src.slice(0, end));
        tokens[tokens.length - 1].keep = true;
        continue;
      }
      if (ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029') {
        const m = /^[\r\n\u2028\u2029]+/.exec(src.slice(i));
        push('nl', m[0]);
        continue;
      }
      if (/\s/.test(ch)) {
        const m = /^[^\S\r\n\u2028\u2029]+/.exec(src.slice(i));
        push('ws', m[0]);
        continue;
      }
      if (rest2 === '//') {
        const m = /^\/\/[^\r\n\u2028\u2029]*/.exec(src.slice(i));
        push('comment', m[0]);
        continue;
      }
      if (rest2 === '/*') {
        const end = src.indexOf('*/', i + 2);
        if (end === -1) throw new SyntaxIssue('Unterminated block comment /* … */', line, col);
        push('comment', src.slice(i, end + 2));
        continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < src.length && src[j] !== ch) {
          if (src[j] === '\\') j++;
          else if (src[j] === '\n') throw new SyntaxIssue(`Unterminated string literal (started with ${ch})`, line, col);
          j++;
        }
        if (j >= src.length) throw new SyntaxIssue(`Unterminated string literal (started with ${ch})`, line, col);
        push('string', src.slice(i, j + 1));
        continue;
      }
      if (ch === '`') {
        const t = readTemplate('`');
        push('template', t.text);
        if (t.opensExpr) braceStack.push('template');
        continue;
      }
      if (ch === '}' && braceStack[braceStack.length - 1] === 'template') {
        braceStack.pop();
        const t = readTemplate('}');
        push('template', t.text);
        if (t.opensExpr) braceStack.push('template');
        continue;
      }
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
        const m = /^(0[xX][0-9a-fA-F_]+n?|0[bB][01_]+n?|0[oO][0-7_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?)/.exec(src.slice(i));
        push('num', m[0]);
        continue;
      }
      if (ch === '/' && regexAllowed()) {
        let j = i + 1, inClass = false;
        while (j < src.length) {
          const c = src[j];
          if (c === '\\') { j += 2; continue; }
          if (c === '\n') throw new SyntaxIssue('Unterminated regular expression', line, col);
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) break;
          j++;
        }
        if (j >= src.length) throw new SyntaxIssue('Unterminated regular expression', line, col);
        j++;
        while (j < src.length && /[a-z]/i.test(src[j])) j++;
        push('regex', src.slice(i, j));
        continue;
      }
      if (isIdStart(ch) || (ch === '#' && isIdStart(src[i + 1] || ''))) {
        let j = i + 1;
        while (j < src.length && isIdPart(src[j])) j++;
        push('name', src.slice(i, j));
        continue;
      }
      const p = PUNCTUATORS.find((op) => src.startsWith(op, i));
      if (p) {
        if (p === '?.' && /[0-9]/.test(src[i + 2] || '')) { push('punct', '?'); continue; } // a?.5:b
        if (p === '{') braceStack.push('brace');
        if (p === '}') braceStack.pop();
        push('punct', p);
        continue;
      }
      throw new SyntaxIssue(`Unexpected character '${ch}'`, line, col);
    }
    return tokens;
  }

  // ── JavaScript minifier ─────────────────────────────────────────────
  // Removes comments and whitespace while preserving every token. A line
  // break is only dropped where JavaScript could never have inserted an
  // automatic semicolon (ASI), so the program's meaning cannot change.

  const NEVER_ENDS_STATEMENT = new Set([
    '{', '(', '[', ',', ';', ':', '?', '?.', '.', '...', '=>',
    '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=',
    '==', '===', '!=', '!==', '<', '>', '<=', '>=', '+', '-', '*', '/', '%', '**',
    '<<', '>>', '>>>', '&', '|', '^', '!', '~', '&&', '||', '??',
  ]);
  const NEVER_STARTS_STATEMENT = new Set([
    '}', ')', ']', ',', ';', ':', '?', '?.', '.', '=>',
    '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??=',
    '==', '===', '!=', '!==', '<', '>', '<=', '>=', '*', '%', '**',
    '<<', '>>', '>>>', '&', '|', '^', '&&', '||', '??',
  ]);
  // A line break after these words changes meaning (restricted productions).
  const RESTRICTED_WORDS = new Set(['return', 'break', 'continue', 'throw', 'yield', 'async', 'let', 'get', 'set', 'static']);

  const isWordish = (t) => t.type === 'name' || t.type === 'num' || (t.type === 'punct' && (t.value === '#' || t.value === '@'));

  function needsSpace(prev, next) {
    if (isWordish(prev) && isWordish(next)) return true;
    if (isWordish(prev) && (next.type === 'string' || next.type === 'template' || next.type === 'regex')) return false;
    const a = prev.value, b = next.value;
    if (prev.type === 'num' && b[0] === '.' && !/[.eExXn]/.test(a)) return true; // 1 .toFixed()
    if ((a.endsWith('+') && b.startsWith('+')) || (a.endsWith('-') && b.startsWith('-'))) return true;
    if (a.endsWith('/') && (b.startsWith('/') || b.startsWith('*'))) return true; // would open a comment
    if (a === '<' && b.startsWith('!--')) return true;
    if (a.endsWith('-') && b === '>') return true;
    if (prev.type === 'regex' && (next.type === 'name' || next.type === 'num')) return true; // /x/ in y
    return false;
  }

  function lineBreakNeeded(prev, next) {
    if (prev.type === 'name' && RESTRICTED_WORDS.has(prev.value)) return true;
    if (next.type === 'punct' && (next.value === '++' || next.value === '--')) return true;
    if (prev.type === 'punct' && NEVER_ENDS_STATEMENT.has(prev.value)) return false;
    if (next.type === 'punct' && NEVER_STARTS_STATEMENT.has(next.value)) return false;
    if (next.type === 'name' && (next.value === 'in' || next.value === 'instanceof')) return false;
    return true;
  }

  function minifyJS(code, { keepLicense = true } = {}) {
    const tokens = tokenizeJS(code);
    let out = '';
    let prev = null;
    let sawSpace = false, sawBreak = false;
    for (const t of tokens) {
      if (t.type === 'ws') { sawSpace = true; continue; }
      if (t.type === 'nl') { sawBreak = true; continue; }
      if (t.type === 'comment') {
        const keep = t.keep || (keepLicense && /^\/\*!/.test(t.value));
        if (!keep) {
          sawSpace = true;
          if (t.value.startsWith('//') || /[\r\n\u2028\u2029]/.test(t.value)) sawBreak = sawBreak || !t.value.startsWith('//');
          continue;
        }
        out += (out ? '\n' : '') + t.value + '\n';
        prev = null; sawSpace = sawBreak = false;
        continue;
      }
      if (prev) {
        if (sawBreak && lineBreakNeeded(prev, t)) out += '\n';
        else if ((sawSpace || sawBreak) && needsSpace(prev, t)) out += ' ';
        else if (!sawSpace && !sawBreak && needsSpace(prev, t)) out += ' ';
      }
      out += t.value;
      prev = t;
      sawSpace = sawBreak = false;
    }
    return out;
  }

  // ── AST verification (needs acorn) ──────────────────────────────────
  function parseJS(code) {
    if (!acorn) return null;
    const opts = { ecmaVersion: 'latest', allowHashBang: true, locations: true };
    try {
      return { ast: acorn.parse(code, { ...opts, sourceType: 'script' }), sourceType: 'script' };
    } catch (e1) {
      try {
        return { ast: acorn.parse(code, { ...opts, sourceType: 'module' }), sourceType: 'module' };
      } catch (e2) {
        const e = /import|export/.test(e1.message) ? e2 : e1;
        const err = new SyntaxIssue(e.message.replace(/ \(\d+:\d+\)$/, ''), e.loc ? e.loc.line : null, e.loc ? e.loc.column + 1 : null);
        throw err;
      }
    }
  }

  function stripPositions(node) {
    if (Array.isArray(node)) return node.map(stripPositions);
    if (node && typeof node === 'object') {
      const outObj = {};
      for (const k of Object.keys(node)) {
        if (k === 'start' || k === 'end' || k === 'loc' || k === 'range' || k === 'raw') continue;
        if (k === 'value' && node.type === 'TemplateElement') { outObj.value = { cooked: node.value.cooked }; continue; }
        if (k === 'value' && node.value instanceof RegExp) { outObj.value = String(node.value); continue; }
        if (k === 'value' && typeof node.value === 'bigint') { outObj.value = String(node.value) + 'n'; continue; }
        outObj[k] = stripPositions(node[k]);
      }
      return outObj;
    }
    return node;
  }

  /** True / false when acorn is available, null when it is not. */
  function sameProgram(a, b) {
    if (!acorn) return null;
    const pa = parseJS(a), pb = parseJS(b);
    return JSON.stringify(stripPositions(pa.ast)) === JSON.stringify(stripPositions(pb.ast));
  }

  // ── CSS minifier ─────────────────────────────────────────────────────
  function tokenizeCSS(src) {
    const tokens = [];
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (src.startsWith('/*', i)) {
        const end = src.indexOf('*/', i + 2);
        if (end === -1) throw new SyntaxIssue('Unterminated comment /* … */', lineAt(src, i), null);
        tokens.push({ type: 'comment', value: src.slice(i, end + 2) });
        i = end + 2; continue;
      }
      if (/\s/.test(ch)) {
        let j = i; while (j < src.length && /\s/.test(src[j])) j++;
        tokens.push({ type: 'ws', value: ' ' }); i = j; continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        while (j < src.length && src[j] !== ch) { if (src[j] === '\\') j++; j++; }
        if (j >= src.length) throw new SyntaxIssue('Unterminated string', lineAt(src, i), null);
        tokens.push({ type: 'string', value: src.slice(i, j + 1) }); i = j + 1; continue;
      }
      if (/^url\(/i.test(src.slice(i, i + 4))) {
        const m = /^url\(\s*([^"')\s][^)]*?|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)/i.exec(src.slice(i));
        if (m) { tokens.push({ type: 'url', value: 'url(' + m[1] + ')' }); i += m[0].length; continue; }
      }
      if ('{}:;,>~+()[]'.includes(ch)) { tokens.push({ type: 'punct', value: ch }); i++; continue; }
      let j = i;
      while (j < src.length && !/[\s{}:;,>~+()[\]"'/]/.test(src[j])) j++;
      if (j === i) { j = i + 1; }
      tokens.push({ type: 'word', value: src.slice(i, j) });
      i = j;
    }
    return tokens;
  }

  function lineAt(src, idx) { return src.slice(0, idx).split('\n').length; }

  function minifyCSS(code, { keepLicense = true } = {}) {
    const tokens = tokenizeCSS(code).filter((t) => t.type !== 'comment' || (keepLicense && t.value.startsWith('/*!')));
    // Context: are we in a selector/prelude or inside a declaration value?
    const stack = []; // for each open brace: 'rule' | 'atrule'
    let mode = 'selector'; // 'selector' | 'property' | 'value' | 'atrule'
    let paren = 0;
    let out = '';
    const lastChar = () => out[out.length - 1] || '';

    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.type === 'comment') { out += t.value; continue; }
      if (t.type === 'ws') {
        // Decide lazily: keep one space only if the neighbours require it.
        const next = tokens.slice(k + 1).find((x) => x.type !== 'ws' && x.type !== 'comment');
        if (!next || !out) continue;
        const prevC = lastChar();
        const n = next.value;
        const tight = new Set(['{', '}', ';', ',']);
        if (tight.has(prevC) || tight.has(n)) continue;
        if (n === ')' || prevC === '(') continue;
        if (mode === 'property' && (n === ':' || prevC === ':')) continue;
        if (mode === 'value' && paren === 0 && (prevC === ':' || n === '!')) continue;
        if (mode === 'selector' && paren === 0 && ('>~+'.includes(n) || '>~+'.includes(prevC))) continue;
        if (mode === 'atrule' && paren > 0 && (n === ':' || prevC === ':')) continue;
        out += ' ';
        continue;
      }
      const v = t.value;
      if (t.type === 'word' && v[0] === '@' && (mode === 'selector')) mode = 'atrule';
      if (v === '(') paren++;
      if (v === ')') paren = Math.max(0, paren - 1);
      if (v === '{' && t.type === 'punct') {
        stack.push(mode === 'atrule' ? 'atrule' : 'rule');
        // Inside an at-rule like @media we expect nested selectors; otherwise declarations.
        mode = stack[stack.length - 1] === 'atrule' && !/@(font-face|page|property|counter-style|font-feature-values|viewport)\b/i.test(lastAtRule(out)) ? 'selector' : 'property';
        out += '{'; paren = 0; continue;
      }
      if (v === '}' && t.type === 'punct') {
        if (out.endsWith(';')) out = out.slice(0, -1);
        stack.pop();
        out += '}';
        mode = stack.length && stack[stack.length - 1] === 'rule' ? 'property' : 'selector';
        continue;
      }
      if (v === ';' && t.type === 'punct') {
        if (mode === 'atrule') { mode = 'selector'; out += ';'; continue; } // @import …;
        if (out.endsWith(';') || out.endsWith('{')) continue; // empty declarations
        out += ';'; mode = 'property'; continue;
      }
      if (v === ':' && t.type === 'punct' && mode === 'property') { out += ':'; mode = 'value'; continue; }
      if (mode === 'property' && t.type === 'word' && tokens.slice(k + 1).find((x) => x.type !== 'ws')?.value === '{') mode = 'selector'; // nested rule
      out += v;
    }
    return out.trim();
  }

  function lastAtRule(out) {
    const m = out.match(/@[a-z-]+[^{]*$/i);
    return m ? m[0] : '';
  }

  // What does the initializer starting at toks[s] create?
  function initializerKind(toks, s) {
    let k = s;
    if (toks[k] && toks[k].value === 'async') k++;
    const t = toks[k];
    if (!t) return 'Variable';
    if (t.value === 'function') return 'Function';
    if (t.value === 'class') return 'Class';
    if (t.type === 'name' && toks[k + 1] && toks[k + 1].value === '=>') return 'Function';
    if (t.value === '(') {
      let depth = 0;
      for (let m = k; m < toks.length; m++) {
        if (toks[m].value === '(') depth++;
        else if (toks[m].value === ')') { depth--; if (depth === 0) return toks[m + 1] && toks[m + 1].value === '=>' ? 'Function' : 'Variable'; }
      }
    }
    return 'Variable';
  }

  // ── Symbol table ─────────────────────────────────────────────────────
  function analyzeSymbols(code) {
    const toks = tokenizeJS(code).filter((t) => t.type !== 'ws' && t.type !== 'nl' && t.type !== 'comment');
    const symbols = [];
    const scopes = [{ kind: 'global', name: 'global' }];
    const pendingScope = []; // name for the next '{'
    const seen = new Set();
    const add = (name, type, keyword, line) => {
      const scope = scopes.map((s) => s.name).filter((n) => n !== 'block').pop() || 'global';
      const depth = scopes.length - 1;
      const key = `${name}:${scope}:${depth}`;
      if (seen.has(key)) return;
      seen.add(key);
      symbols.push({ name, type, keyword, line, scope });
    };

    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      const next = toks[k + 1];
      if (t.type === 'punct' && t.value === '{') { scopes.push({ name: pendingScope.pop() || 'block' }); continue; }
      if (t.type === 'punct' && t.value === '}') { if (scopes.length > 1) scopes.pop(); continue; }
      if (t.type !== 'name') continue;

      if ((t.value === 'var' || t.value === 'let' || t.value === 'const') && next) {
        // Walk the declarator list: name [= expr] , name [= expr] ... until ; or newline-level end
        let j = k + 1;
        while (j < toks.length) {
          const d = toks[j];
          if (d.type === 'name') {
            const after = toks[j + 1];
            const kind = after && after.value === '=' ? initializerKind(toks, j + 2) : 'Variable';
            add(d.value, kind, t.value, d.line);
            if (kind !== 'Variable') pendingScope.push(d.value);
          } else if (d.value === '{' || d.value === '[') {
            // destructuring: collect names until the matching bracket
            let depth = 0, m = j;
            for (; m < toks.length; m++) {
              const x = toks[m];
              if (x.value === '{' || x.value === '[') depth++;
              else if (x.value === '}' || x.value === ']') { depth--; if (depth === 0) break; }
              else if (x.type === 'name' && toks[m + 1] && [',', '}', ']', '='].includes(toks[m + 1].value) && toks[m - 1].value !== ':' + '' && toks[m - 1].value !== '=') add(x.value, 'Variable', t.value, x.line);
              else if (x.type === 'name' && toks[m - 1].value === ':' && toks[m + 1] && [',', '}', '='].includes(toks[m + 1].value)) add(x.value, 'Variable', t.value, x.line);
            }
            j = m;
          }
          // skip initializer to the next top-level comma
          let depth = 0; j++;
          while (j < toks.length) {
            const x = toks[j];
            if (['(', '[', '{'].includes(x.value) && x.type === 'punct') depth++;
            else if ([')', ']', '}'].includes(x.value) && x.type === 'punct') { if (depth === 0) break; depth--; }
            else if (depth === 0 && (x.value === ',' || x.value === ';')) break;
            else if (depth === 0 && x.type === 'name' && ['var', 'let', 'const', 'function', 'class', 'if', 'for', 'while', 'return'].includes(x.value) && toks[j - 1].line < x.line) break;
            j++;
          }
          if (toks[j] && toks[j].value === ',') { j++; continue; }
          break;
        }
        continue;
      }
      if (t.value === 'function' && next) {
        const n = next.value === '*' ? toks[k + 2] : next;
        if (n && n.type === 'name') { add(n.value, 'Function', 'function', n.line); pendingScope.push(n.value); }
        else pendingScope.push('anonymous fn');
        // parameters
        const open = toks.findIndex((x, idx) => idx > k && x.value === '(');
        let depth = 0;
        for (let m = open; m < toks.length && open !== -1; m++) {
          const x = toks[m];
          if (x.value === '(') depth++;
          else if (x.value === ')') { depth--; if (depth === 0) break; }
          else if (depth === 1 && x.type === 'name' && [',', ')', '='].includes(toks[m + 1]?.value) && toks[m - 1].value !== '=') {
            seen.delete(`${x.value}:param`);
            symbols.push({ name: x.value, type: 'Parameter', keyword: 'param', line: x.line, scope: n && n.type === 'name' ? n.value : 'anonymous fn' });
          }
        }
        continue;
      }
      if (t.value === 'class' && next && next.type === 'name' && next.value !== 'extends') {
        add(next.value, 'Class', 'class', next.line);
        pendingScope.push(next.value);
        continue;
      }
      if (t.value === 'import' && next) {
        // import a, { b as c, d } from '…' / import * as ns from '…'
        for (let m = k + 1; m < toks.length && toks[m].value !== 'from' && toks[m].type !== 'string'; m++) {
          const x = toks[m];
          if (x.type === 'name' && x.value !== 'as' && [',', 'from', '}'].includes(toks[m + 1]?.value)) add(x.value, 'Import', 'import', x.line);
        }
      }
    }
    symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
    return symbols;
  }

  // ── Syntax checker ───────────────────────────────────────────────────
  function checkBrackets(tokens) {
    const errors = [];
    const stack = [];
    const PAIRS = { ')': '(', '}': '{', ']': '[' };
    const CLOSE = { '(': ')', '{': '}', '[': ']' };
    for (const t of tokens) {
      if (t.type !== 'punct') continue;
      if (t.value in CLOSE) stack.push(t);
      else if (t.value in PAIRS) {
        const top = stack[stack.length - 1];
        if (!top) errors.push({ type: 'unexpected', message: `Unexpected closing '${t.value}' — no matching opener`, line: t.line, col: t.col });
        else if (top.value !== PAIRS[t.value]) {
          errors.push({ type: 'mismatch', message: `Bracket mismatch: '${t.value}' found but expected '${CLOSE[top.value]}' to close '${top.value}' (opened at line ${top.line}, col ${top.col})`, line: t.line, col: t.col });
          stack.pop();
        } else stack.pop();
      }
    }
    for (const t of stack) errors.push({ type: 'unclosed', message: `Missing closing '${CLOSE[t.value]}' for '${t.value}' opened at line ${t.line}, col ${t.col}`, line: t.line, col: t.col });
    return errors;
  }

  function checkSyntax(code, language = 'js') {
    const errors = [];
    if (language === 'css') {
      try {
        const toks = [];
        let line = 1, col = 1;
        for (const t of tokenizeCSSWithPos(code)) toks.push(t);
        errors.push(...checkBrackets(toks.map((t) => ({ ...t, type: 'punct' })).filter((t) => '{}()[]'.includes(t.value))));
      } catch (e) {
        errors.push({ type: 'unclosed', message: e.message, line: e.line || null, col: e.col || null });
      }
      return { valid: errors.length === 0, errors, parser: 'brackets' };
    }
    let tokens;
    try {
      tokens = tokenizeJS(code);
      errors.push(...checkBrackets(tokens));
    } catch (e) {
      errors.push({ type: 'unclosed', message: e.message, line: e.line || null, col: e.col || null });
    }
    if (!errors.length && acorn) {
      try { parseJS(code); } catch (e) {
        errors.push({ type: 'syntax', message: e.message, line: e.line, col: e.col });
      }
    }
    return { valid: errors.length === 0, errors, parser: acorn ? 'acorn' : 'brackets' };
  }

  function tokenizeCSSWithPos(src) {
    const out = [];
    let line = 1, col = 1, inComment = false, quote = '';
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (inComment) { if (ch === '*' && src[i + 1] === '/') { inComment = false; i++; col++; } }
      else if (quote) { if (ch === '\\') { i++; col++; } else if (ch === quote) quote = ''; }
      else if (ch === '/' && src[i + 1] === '*') { inComment = true; i++; col++; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if ('{}()[]'.includes(ch)) out.push({ value: ch, line, col });
      if (ch === '\n') { line++; col = 1; } else col++;
    }
    if (inComment) throw new SyntaxIssue('Unterminated comment /* … */', line, col);
    if (quote) throw new SyntaxIssue(`Unterminated string (started with ${quote})`, line, col);
    return out;
  }

  // ── Public API ───────────────────────────────────────────────────────
  const byteLength = (s) => (typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf8'));

  function minify(code, language) {
    const output = language === 'css' ? minifyCSS(code) : minifyJS(code);
    let verified = null;
    if (language === 'js' && acorn) {
      try { verified = sameProgram(code, output); } catch (e) { verified = false; }
    }
    return { output, originalSize: byteLength(code), minifiedSize: byteLength(output), verified };
  }

  return { tokenizeJS, minifyJS, minifyCSS, minify, analyzeSymbols, checkSyntax, sameProgram, parseJS, byteLength, hasParser: !!acorn };
});
