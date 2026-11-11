// MD Notepad - preview page shown inside the Notepad++ panel (WebView2).
//
// Messages from the plugin:  a plain string is the Markdown text to render;
//                            an object is a command ({type: 'settings' | 'doc' | 'eol' | 'scroll' | ...}).
// Messages to the plugin:    plain strings: 'ready', 'print-ready', 'open:<url>', 'log:<text>',
//                            'edit:<whole new text>', 'undo', 'redo', 'save'.
//
// Editing in the preview: the page never lets the browser change the rendered HTML. Every edit is turned into a
// change of the Markdown source (see "source map" below), the page renders the new source at once and sends the
// whole new text to the plugin, which writes only the changed part into the editor.
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';

const STYLE_LIGHT = 'github-markdown-light.css';
const STYLE_DARK = 'github-markdown-dark-dimmed.css';
const MERMAID_DELAY_MS = 150;
const SVG_CACHE_SIZE = 64;

const bridge = window.chrome && window.chrome.webview;
const output = document.getElementById('output');
const styleLink = document.getElementById('gh-markdown-link');
const page = document.documentElement;

const tell = (text) => {
    if (bridge) {
        bridge.postMessage(text);
    }
};

const app = {
    dark: false,
    editable: true,
    docBase: '',
    printing: false,
    source: '',          // the document exactly as the editor has it (line ends included)
    eol: '\r\n',         // line end used for text typed in the preview
    pending: null,       // source offset of the empty paragraph made by Enter, until something is typed in it
    composing: false,
    deferredDoc: null,   // a document that arrived during IME composition
    firstElement: null,  // the first rendered element (gets class md-first: no top margin)
    caret: null,         // {src, node, offset}: where the last edit left the caret (see render)
};

// ---------------------------------------------------------------------------- markdown

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text) => text.replace(/[&<>"']/g, (ch) => ENTITIES[ch]);

const isMermaid = (lang) => (lang || '').trim().split(/\s+/)[0].toLowerCase() === 'mermaid';

const markdown = new Marked({
    gfm: true,
    renderer: {
        code(token) {
            if (!isMermaid(token.lang)) {
                return false; // default code block
            }
            return `<pre class="mermaid">${escapeHtml(token.text)}</pre>\n`;
        },
    },
});
// (heading ids are set after rendering, see assignAnchors)

const isRelative = (url) => !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url);

// Images with a relative path are loaded from the folder of the open document.
const resolveImages = (root) => {
    if (!app.docBase) {
        return;
    }
    for (const img of root.querySelectorAll('img[src]')) {
        const src = img.getAttribute('src');
        if (src && isRelative(src)) {
            try {
                img.setAttribute('src', new URL(src, app.docBase).href);
            } catch (e) {
                // keep the original value
            }
        }
    }
};

// ---------------------------------------------------------------------------- source map
//
// The rendered page is a list of blocks, one per top-level Markdown token, each preceded by an invisible marker
// element. A block remembers its token, its source offset and its text nodes; every character shown in it has the
// offset of the source character it came from (block.src, relative to block.start) and how many source characters it
// stands for (block.len: 1, the length of an entity such as "&amp;", or 0 when it has no source of its own).
// Offsets are in the source with line ends turned into "\n" (view.norm).
// A positions in the shown text ("pos") counts the characters of all blocks in order.
//
// After an edit only the blocks whose Markdown changed are parsed and rendered again; the others keep their HTML,
// text nodes and map, so typing stays fast in long documents.

const PHANTOM = '​'; // invisible character that gives an empty heading or list item a place for the caret
const BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,td,th,pre,blockquote,dt,dd';
const STRUCTURAL = new Set(['#document-fragment', 'ARTICLE', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'TABLE', 'THEAD',
    'TBODY', 'TFOOT', 'TR', 'DIV', 'DL', 'DETAILS', 'SECTION']);
const NO_TEXT_TOKENS = new Set(['space', 'hr', 'def', 'html', 'image', 'br', 'checkbox']);
const ENTITY = /&(?:#\d{1,7}|#x[\da-f]{1,6}|[a-z][a-z\d]{1,31});/iy;
const LINK_DEFINITION = /^ {0,3}\[[^\]]+\]:/m;
const SEARCH_WINDOW = 64;
const MATCH_LOOKAHEAD = 16;
const HEADING_MARK = /^ {0,3}#{1,6}[ \t]*/;
const ITEM_MARK = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?[ \t]*/;

const decoder = document.createElement('textarea');
const decodeEntity = (entity) => {
    decoder.innerHTML = entity;
    return decoder.value;
};

const emptyView = () => ({
    norm: '', toRaw: null, blocks: [], index: [], length: 0, links: '{}', docBase: '', flat: true, pendingNode: null,
});

let view = emptyView();

// "\r\n" and "\r" become "\n" (as marked does); toRaw[i] is the offset in the original text of normalized offset i.
const normalize = (raw) => {
    if (raw.indexOf('\r') < 0) {
        return { norm: raw, toRaw: null };
    }
    const toRaw = new Int32Array(raw.length + 1);
    let n = 0;
    for (let i = 0; i < raw.length; i++) {
        toRaw[n++] = i;
        if (raw[i] === '\r' && raw[i + 1] === '\n') {
            i++;
        }
    }
    toRaw[n] = raw.length;
    return { norm: raw.replace(/\r\n?/g, '\n'), toRaw };
};

// The visible characters of one top-level token, each with its source offset: [{ch, src, len}].
const sourceChars = (token, start, norm) => {
    const out = [];
    const end = start + token.raw.length;
    let cursor = start;

    const find = (piece, from, limit) => {
        const at = norm.substring(from, Math.min(limit, from + SEARCH_WINDOW)).indexOf(piece);
        return at < 0 ? -1 : from + at;
    };
    const locate = (raw) => {
        if (!raw) {
            return -1;
        }
        const at = norm.indexOf(raw, cursor);
        return at >= 0 && at + raw.length <= end ? at : -1;
    };
    const pushText = (text, limit, decode) => {
        for (let k = 0; k < text.length;) {
            ENTITY.lastIndex = k;
            const entity = decode ? ENTITY.exec(text) : null;
            const piece = entity ? entity[0] : text[k];
            const shown = entity ? decodeEntity(piece) : piece;
            let at = find(piece, cursor, limit);
            let width = piece.length;
            if (at < 0 && entity) {
                at = find(shown, cursor, limit); // the source has the character itself
                width = shown.length;
            }
            for (let u = 0; u < shown.length; u++) {
                out.push({ ch: shown[u], src: at < 0 ? cursor : at, len: at < 0 || u > 0 ? 0 : width });
            }
            if (at >= 0) {
                cursor = at + width;
            }
            k += piece.length;
        }
    };
    // marked may leave the spaces after an empty marker ("2. ") out of the token; they still belong to it
    const phantomAt = (src) => {
        let at = src;
        while (at < norm.length && (norm[at] === ' ' || norm[at] === '\t')) {
            at++;
        }
        out.push({ ch: PHANTOM, src: at, len: 0 });
    };

    const walk = (tok) => {
        const at = locate(tok.raw);
        const rawEnd = at >= 0 ? at + tok.raw.length : end;
        if (NO_TEXT_TOKENS.has(tok.type) || (tok.type === 'code' && isMermaid(tok.lang))) {
            if (at >= 0) {
                cursor = rawEnd;
            }
            return;
        }
        if (at >= 0) {
            cursor = at;
        }
        if (tok.type === 'escape') {
            out.push({ ch: tok.text, src: at >= 0 ? at : cursor, len: at >= 0 ? tok.raw.length : 0 });
        } else if (tok.type === 'heading' && !tok.text.trim()) {
            phantomAt(cursor + (HEADING_MARK.exec(tok.raw) || [''])[0].length);
        } else if (tok.type === 'list_item' && !tok.text.trim()) {
            phantomAt(cursor + (ITEM_MARK.exec(tok.raw) || [''])[0].length);
        } else if (tok.type === 'table') {
            for (const cell of [...tok.header, ...tok.rows.flat()]) {
                cell.tokens.forEach(walk);
            }
        } else if (tok.type === 'list') {
            tok.items.forEach(walk);
        } else if (tok.tokens) {
            tok.tokens.forEach(walk);
        } else if (typeof tok.text === 'string') {
            const literal = tok.type === 'code' || tok.type === 'codespan';
            pushText(tok.text, rawEnd, !literal);
        }
        if (at >= 0 && rawEnd > cursor) {
            cursor = rawEnd;
        }
    };

    if (token.type === 'pending') {
        phantomAt(start);
    } else {
        walk(token);
    }
    return out;
};

// Text nodes that hold document text, grouped by the block marker before them. Diagrams and other non-editable
// parts and the whitespace between block elements are left out.
const textFilter = {
    acceptNode(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.hasAttribute('data-b')) {
                return NodeFilter.FILTER_ACCEPT;
            }
            if (node.getAttribute('contenteditable') === 'false' || node.namespaceURI !== output.namespaceURI) {
                return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_SKIP;
        }
        if (!node.data.length || (!node.data.trim() && STRUCTURAL.has(node.parentNode.nodeName))) {
            return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
    },
};

const textGroups = (root) => {
    const groups = [];
    let current = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, textFilter);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.nodeType === Node.ELEMENT_NODE) {
            current = { marker: node, nodes: [] };
            groups.push(current);
        } else if (current) {
            current.nodes.push(node);
        }
    }
    return groups;
};

const closestBlock = (node) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return (element && element.closest(BLOCK_SELECTOR)) || output;
};

// Matches the shown text of one block with its source characters; unmatched shown characters get len 0.
// Offsets are stored relative to base (the block's source offset).
const align = (text, chars, base, src, len) => {
    let j = 0;
    for (let i = 0; i < text.length; i++) {
        let k = -1;
        for (let t = j; t < Math.min(chars.length, j + MATCH_LOOKAHEAD); t++) {
            if (chars[t].ch === text[i]) {
                k = t;
                break;
            }
        }
        if (k >= 0) {
            src[i] = chars[k].src - base;
            len[i] = chars[k].len;
            j = k + 1;
        } else {
            const next = chars[j] || chars[chars.length - 1];
            src[i] = (chars[j] ? next.src : next ? next.src + next.len : base) - base;
            len[i] = 0;
        }
    }
};

const makeBlock = (token, start, norm, group) => {
    const nodes = group ? group.nodes : [];
    const text = nodes.map((node) => node.data).join('');
    const block = {
        type: token.type, raw: token.raw, token, start, marker: group ? group.marker : null, nodes, text,
        src: new Int32Array(text.length), len: new Int32Array(text.length), index: 0, offset: 0, ix: -1,
    };
    align(text, sourceChars(token, start, norm), start, block.src, block.len);
    let at = 0;
    for (const node of nodes) {
        node.__md = { block, start: at, len: node.data.length };
        at += node.data.length;
    }
    return block;
};

// ---- positions in the shown text

// pos -> {block, i}; null outside the text
const locate = (pos) => {
    const index = view.index;
    let lo = 0;
    let hi = index.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (index[mid].offset <= pos) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (found < 0) {
        return null;
    }
    const block = index[found];
    const i = pos - block.offset;
    return i < block.text.length ? { block, i } : null;
};

const chAt = (pos) => {
    const at = locate(pos);
    return at ? at.block.text[at.i] : '';
};
const srcAt = (pos) => {
    const at = locate(pos);
    return at ? at.block.start + at.block.src[at.i] : view.norm.length;
};
const lenAt = (pos) => {
    const at = locate(pos);
    return at ? at.block.len[at.i] : 0;
};
const srcEnd = (pos) => srcAt(pos) + lenAt(pos);
const tokenAt = (pos) => {
    const at = locate(pos);
    return at ? at.block.index : -1;
};
const nodeIn = (block, i) => block.nodes.find((node) => i >= node.__md.start && i < node.__md.start + node.__md.len);
const nodeAt = (pos) => {
    const at = locate(pos);
    return at ? nodeIn(at.block, at.i) : null;
};
const blockElAt = (pos) => {
    const node = nodeAt(pos);
    return node ? closestBlock(node) : null;
};
const posOf = (node) => node.__md.block.offset + node.__md.start;

// ---------------------------------------------------------------------------- rendering

const lexAll = (norm) => {
    const tokens = markdown.lexer(norm);
    const starts = [];
    let cursor = 0;
    for (const token of tokens) {
        const at = norm.indexOf(token.raw, cursor);
        starts.push(at >= 0 ? at : cursor);
        cursor = (at >= 0 ? at : cursor) + token.raw.length;
    }
    return { tokens, starts, links: JSON.stringify(tokens.links || {}) };
};

// Parses only the part of the document around a change: from two blocks before it to two blocks after it. The
// result is used only if that part parses into blocks that cover it exactly and it ends with the same block as
// before (so the blocks after it are unaffected); otherwise null, and the whole document is parsed.
const lexChange = (old, norm) => {
    const before = old.norm;
    const real = old.blocks.filter((b) => b.type !== 'pending');
    if (!real.length || old.links !== '{}') {
        return null;
    }
    const max = Math.min(before.length, norm.length);
    let p = 0;
    while (p < max && before.charCodeAt(p) === norm.charCodeAt(p)) {
        p++;
    }
    if (p === before.length && p === norm.length) {
        return { tokens: real.map((b) => b.token), starts: real.map((b) => b.start), links: old.links };
    }
    let q = 0;
    while (q < max - p && before.charCodeAt(before.length - 1 - q) === norm.charCodeAt(norm.length - 1 - q)) {
        q++;
    }
    const changeEnd = before.length - q;
    let first = real.findIndex((b) => b.start + b.raw.length >= p);
    let last = -1;
    for (let k = real.length - 1; k >= 0; k--) {
        if (real[k].start <= changeEnd) {
            last = k;
            break;
        }
    }
    if (first < 0 || last < 0) {
        return null;
    }
    first = Math.min(first, last);
    let from = first;
    for (let k = 0; k < 2 && from > 0;) {
        from--;
        if (real[from].type !== 'space') {
            k++;
        }
    }
    let to = last;
    for (let k = 0; k < 2 && to < real.length - 1;) {
        to++;
        if (real[to].type !== 'space') {
            k++;
        }
    }
    const delta = norm.length - before.length;
    const regionStart = real[from].start;
    const oldEnd = real[to].start + real[to].raw.length;
    const region = norm.slice(regionStart, oldEnd + delta);
    if (oldEnd + delta < regionStart || LINK_DEFINITION.test(region) || LINK_DEFINITION.test(before.slice(regionStart, oldEnd))) {
        return null;
    }
    const tokens = markdown.lexer(region);
    if (Object.keys(tokens.links || {}).length || tokens.map((t) => t.raw).join('') !== region) {
        return null;
    }
    const lastToken = tokens[tokens.length - 1];
    if (to < real.length - 1 && (!lastToken || lastToken.type !== real[to].type || lastToken.raw !== real[to].raw)) {
        return null;
    }
    const starts = [];
    let cursor = regionStart;
    for (const token of tokens) {
        starts.push(cursor);
        cursor += token.raw.length;
    }
    return {
        tokens: [...real.slice(0, from).map((b) => b.token), ...tokens, ...real.slice(to + 1).map((b) => b.token)],
        starts: [...real.slice(0, from).map((b) => b.start), ...starts, ...real.slice(to + 1).map((b) => b.start + delta)],
        links: old.links,
    };
};

// GitHub-like heading anchors: lower case, punctuation dropped, spaces -> '-', repeats get -1, -2, ...
const assignAnchors = () => {
    const used = new Map();
    for (const heading of output.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
        const plain = heading.textContent.split(PHANTOM).join('').trim().toLowerCase();
        const base = plain.replace(/[^\p{L}\p{N}\p{M}\- _]/gu, '').replace(/ /g, '-') || 'section';
        const seen = used.get(base) ?? 0;
        used.set(base, seen + 1);
        heading.id = seen ? `${base}-${seen}` : base;
    }
};

const addPhantoms = (root) => {
    for (const element of root.querySelectorAll('h1,h2,h3,h4,h5,h6,li')) {
        if (!element.textContent.trim() && !element.querySelector('img,svg,pre,ul,ol')) {
            element.append(PHANTOM);
        }
    }
};

const render = (source, caretAt = null) => {
    app.source = source;
    const { norm, toRaw } = normalize(source);
    const old = view;
    const lexed = (old.flat && lexChange(old, norm)) || lexAll(norm);
    const { tokens, starts } = lexed;
    // the empty paragraph made by Enter is shown as a token of its own
    if (app.pending !== null) {
        const at = starts.filter((s) => s < app.pending).length;
        tokens.splice(at, 0, { type: 'pending', raw: '' });
        starts.splice(at, 0, app.pending);
    }

    // blocks that did not change at the start and at the end are kept as they are
    const oldBlocks = old.blocks;
    let head = 0;
    let tail = 0;
    if (old.flat && old.docBase === app.docBase && old.links === lexed.links) {
        const same = (block, token) => block.type === token.type && block.raw === token.raw;
        while (head < oldBlocks.length && head < tokens.length && same(oldBlocks[head], tokens[head])) {
            head++;
        }
        while (tail < oldBlocks.length - head && tail < tokens.length - head &&
            same(oldBlocks[oldBlocks.length - 1 - tail], tokens[tokens.length - 1 - tail])) {
            tail++;
        }
    }
    const boundary = tail ? oldBlocks[oldBlocks.length - tail].marker : null;
    if (!head && !tail) {
        output.textContent = '';
    } else if (head < oldBlocks.length - tail) {
        for (let node = oldBlocks[head].marker; node && node !== boundary;) {
            const next = node.nextSibling;
            node.remove();
            node = next;
        }
    }

    const middle = tokens.slice(head, tokens.length - tail);
    const html = middle.map((token) => {
        const body = token.type === 'pending' ? `<p class="md-pending">${PHANTOM}</p>` : markdown.parser([token]);
        return `<span data-b="1"></span>${body}`;
    }).join('');
    const fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true });
    addPhantoms(fragment);
    diagrams.prepare(fragment);
    resolveImages(fragment);
    const groups = textGroups(fragment);
    // raw HTML that leaves a tag open can pull later markers inside it; then the page is always rendered whole
    const flat = groups.length === middle.length && groups.every((g) => g.marker.parentNode === fragment);
    const fresh = middle.map((token, k) => makeBlock(token, starts[head + k], norm, groups[k]));
    output.insertBefore(fragment, boundary);

    const blocks = [...oldBlocks.slice(0, head), ...fresh, ...oldBlocks.slice(oldBlocks.length - tail)];
    const index = [];
    let offset = 0;
    blocks.forEach((block, i) => {
        block.token = tokens[i];
        block.start = starts[i];
        block.index = i;
        block.offset = offset;
        block.ix = block.text.length ? index.push(block) - 1 : -1;
        offset += block.text.length;
    });
    const pending = blocks.find((b) => b.type === 'pending');
    view = {
        norm, toRaw, blocks, index, length: offset, links: lexed.links, docBase: app.docBase,
        flat: flat && (old.flat || (!head && !tail)), pendingNode: pending ? pending.nodes[0] : null,
    };
    assignAnchors();
    const first = output.firstElementChild && output.firstElementChild.nextElementSibling;
    if (first !== app.firstElement) {
        app.firstElement?.classList.remove('md-first');
        first?.classList.add('md-first');
        app.firstElement = first;
    }
    app.caret = null;
    if (caretAt !== null) {
        placeCaret(caretAt);
        // Remember the exact source offset of the caret: text that is not shown (a space typed at the end of a line)
        // has no character to put the caret after, so the next keystroke continues from here, not before it.
        const selection = window.getSelection();
        if (selection.rangeCount) {
            app.caret = { src: caretAt, node: selection.focusNode, offset: selection.focusOffset };
        }
    }
    diagrams.schedule();
};

const isEditing = () => app.editable && document.hasFocus() && document.activeElement === output;

// A document from the plugin (the editor changed it, or it was opened / switched).
const show = (source) => {
    if (app.composing) {
        app.deferredDoc = source;
        return;
    }
    const caret = isEditing() ? currentSourceCaret() : null;
    app.pending = null;
    render(source, caret);
};

// ---------------------------------------------------------------------------- caret and selection

const recordedText = {
    acceptNode: (node) => (node.__md ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
};

// A DOM point -> {pos, after}: pos is an offset in the shown text; after means the point sticks to the character
// before it (end of a text node) rather than to the one after it.
const pointToText = (container, offset) => {
    if (container.nodeType === Node.TEXT_NODE && container.__md) {
        return { pos: posOf(container) + Math.min(offset, container.__md.len), after: offset > 0 };
    }
    // the nearest document text nodes before and after the point
    const walker = document.createTreeWalker(output, NodeFilter.SHOW_TEXT, recordedText);
    const anchor = container.childNodes[offset] || null;
    let previous;
    let next;
    if (anchor) {
        walker.currentNode = anchor;
        next = anchor.__md ? anchor : walker.nextNode();
        walker.currentNode = anchor;
        previous = walker.previousNode();
    } else {
        let last = container;
        while (last.lastChild) {
            last = last.lastChild;
        }
        walker.currentNode = last;
        previous = last.__md ? last : walker.previousNode();
        walker.currentNode = last;
        next = walker.nextNode();
    }
    const block = closestBlock(container);
    if (previous && (!next || block.contains(previous))) {
        return { pos: posOf(previous) + previous.__md.len, after: true };
    }
    return next ? { pos: posOf(next), after: false } : { pos: view.length, after: true };
};

const readSelection = () => {
    const selection = window.getSelection();
    if (!selection.rangeCount) {
        return null;
    }
    const range = selection.getRangeAt(0);
    if (!output.contains(range.startContainer) || !output.contains(range.endContainer)) {
        return null;
    }
    const a = pointToText(range.startContainer, range.startOffset);
    const b = range.collapsed ? a : pointToText(range.endContainer, range.endOffset);
    const block = closestBlock(range.startContainer);
    return {
        a,
        b,
        collapsed: b.pos <= a.pos,
        block,
        inPending: range.collapsed && block.classList.contains('md-pending'),
        node: range.startContainer,
        offset: range.startOffset,
    };
};

// Where text typed at a caret goes in the source.
const insertionPoint = ({ pos, after }) => {
    const n = view.length;
    if (!n) {
        return view.norm.length;
    }
    if ((after && pos > 0) || pos >= n) {
        return srcEnd(Math.min(pos, n) - 1);
    }
    return srcAt(pos);
};

// The source range behind shown characters [a, b).
const sourceRange = (a, b) => {
    let s = Infinity;
    let e = -Infinity;
    const at = locate(a);
    if (!at) {
        return null;
    }
    let { block, i } = at;
    for (let pos = a; pos < b; pos++, i++) {
        while (block && i >= block.text.length) {
            block = view.index[block.ix + 1];
            i = 0;
        }
        if (!block) {
            break;
        }
        const src = block.start + block.src[i];
        s = Math.min(s, src);
        e = Math.max(e, src + block.len[i]);
    }
    return s <= e ? { s, e } : null;
};

const currentSourceCaret = () => {
    const selection = readSelection();
    return selection ? insertionPoint(selection.b) : null;
};

// Puts the caret at a source offset, choosing the shown character that fits best. Only the blocks around that
// offset are looked at.
const placeCaret = (pos) => {
    if (view.pendingNode) {
        setCaret(view.pendingNode, 1);
        return;
    }
    const index = view.index;
    if (!index.length) {
        return;
    }
    let lo = 0;
    let hi = index.length - 1;
    let k = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (index[mid].start <= pos) {
            k = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    const chars = [];
    for (const block of index.slice(Math.max(0, k - 1), k + 2)) {
        for (let i = 0; i < block.text.length; i++) {
            const src = block.start + block.src[i];
            chars.push({ block, i, src, len: block.len[i], ch: block.text[i] });
        }
    }
    const findLast = (test) => {
        for (let c = chars.length - 1; c >= 0; c--) {
            if (test(chars[c])) {
                return chars[c];
            }
        }
        return null;
    };
    let after = true;
    let found = findLast((c) => c.len > 0 && c.src + c.len === pos) ||
        chars.find((c) => c.ch === PHANTOM && c.src === pos);
    if (!found) {
        found = chars.find((c) => c.len > 0 && c.src === pos);
        after = !found;
    }
    if (!found) {
        found = findLast((c) => c.len > 0 && c.src + c.len < pos);
    }
    if (!found) {
        found = chars[0];
        after = false;
    }
    const node = nodeIn(found.block, found.i);
    if (node) {
        setCaret(node, found.i - node.__md.start + (after ? 1 : 0));
    }
};

const setCaret = (node, offset) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStart(node, Math.min(offset, node.length));
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
};

// ---------------------------------------------------------------------------- edits

// Replaces source range [s, e) (normalized offsets) with text and renders the result.
// Source offset for typing at a collapsed caret: where the last edit left it, if the caret has not moved since.
const caretSource = (selection) => {
    const c = app.caret;
    if (c && selection.collapsed && selection.node === c.node && selection.offset === c.offset) {
        return c.src;
    }
    return insertionPoint(selection.a);
};

const applyEdit = (s, e, text, { caret = s + text.length, pending = null } = {}) => {
    const raw = (p) => (view.toRaw ? view.toRaw[p] : p);
    const next = app.source.slice(0, raw(s)) + text.replace(/\n/g, app.eol) + app.source.slice(raw(e));
    app.pending = pending;
    render(next, caret);
    tell(`edit:${next}`);
};

const clean = (text) => text.replace(/\r\n?/g, '\n').split(PHANTOM).join('');

const insertText = (data, selection) => {
    const text = clean(data);
    if (selection.inPending) {
        // text typed into the empty paragraph made by Enter: keep blank lines around it
        const p = app.pending;
        const norm = view.norm;
        // spaces and tabs next to line ends do not count: they are invisible and do not separate blocks
        const head = norm.slice(Math.max(0, p - 200), p);
        const rest = norm.slice(p, p + 200);
        const before = p === 0 || /\n[ \t]*\n[ \t]*$/.test(head) ? '' : /\n[ \t]*$/.test(head) ? '\n' : '\n\n';
        const after = /^[ \t]*(\n[ \t]*\n|$)/.test(rest) ? '' : /^[ \t]*\n/.test(rest) ? '\n' : '\n\n';
        applyEdit(p, p, before + text + after, { caret: p + before.length + text.length });
        return;
    }
    if (!selection.collapsed) {
        const range = sourceRange(selection.a.pos, selection.b.pos);
        if (range) {
            applyEdit(range.s, range.e, text);
        }
        return;
    }
    const p = caretSource(selection);
    // typing into an empty heading or list item ("##", "- [ ]"): keep a space after the marker
    const nextToPhantom = chAt(selection.a.pos - 1) === PHANTOM || chAt(selection.a.pos) === PHANTOM;
    const space = nextToPhantom && p > 0 && !/[ \t]/.test(view.norm[p - 1]) ? ' ' : '';
    applyEdit(p, p, space + text);
};

// Tokens strictly between two top-level tokens must be blank for their blocks to be joined; this keeps a
// diagram, a rule or raw HTML between them from being deleted by one key press.
const onlyBlankBetween = (t1, t2) => {
    for (let t = Math.min(t1, t2) + 1; t < Math.max(t1, t2); t++) {
        const block = view.blocks[t];
        if (block && block.type !== 'space' && block.type !== 'pending') {
            return false;
        }
    }
    return true;
};

const isCell = (element) => element && (element.nodeName === 'TD' || element.nodeName === 'TH');

// Joins the block of shown character `second` to the block before it by deleting the source between them.
const joinBlocks = (first, second) => {
    if (first < 0 || second >= view.length || isCell(blockElAt(first)) || isCell(blockElAt(second))) {
        return;
    }
    if (!onlyBlankBetween(tokenAt(first), tokenAt(second))) {
        return;
    }
    let a = first;
    while (a > 0 && lenAt(a) === 0 && chAt(a) !== PHANTOM) {
        a--;
    }
    const s = srcEnd(a);
    const e = srcAt(second);
    if (e > s) {
        applyEdit(s, e, '', { caret: s });
    }
};

// An empty heading or list item (shown as a phantom character) is removed with its marker.
const removeEmptyBlock = (phantom) => {
    if (view.pendingNode && nodeAt(phantom) === view.pendingNode) {
        app.pending = null;
        render(app.source, srcAt(phantom));
        return;
    }
    const s = phantom > 0 ? srcEnd(phantom - 1) : 0;
    const e = srcAt(phantom);
    if (e > s && (phantom === 0 || onlyBlankBetween(tokenAt(phantom - 1), tokenAt(phantom)))) {
        applyEdit(s, e, '', { caret: s });
    }
};

const charWidth = (pos, forward) => {
    const code = chAt(forward ? pos : pos - 1).charCodeAt(0);
    if (forward) {
        return code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    }
    return code >= 0xdc00 && code <= 0xdfff ? 2 : 1;
};

const deleteText = (forward, event, selection) => {
    if (!selection.collapsed) {
        const range = sourceRange(selection.a.pos, selection.b.pos);
        if (range) {
            applyEdit(range.s, range.e, '', { caret: range.s });
        }
        return;
    }
    const type = event.inputType;
    if (type !== 'deleteContentBackward' && type !== 'deleteContentForward') {
        // word / line deletes: the browser knows the extent
        const target = event.getTargetRanges()[0];
        if (target) {
            const a = pointToText(target.startContainer, target.startOffset).pos;
            const b = pointToText(target.endContainer, target.endOffset).pos;
            const range = b > a ? sourceRange(a, b) : null;
            if (range) {
                applyEdit(range.s, range.e, '', { caret: range.s });
                return;
            }
        }
    }
    const a = selection.a.pos;
    if (!forward) {
        if (a === 0) {
            return;
        }
        if (chAt(a - 1) === PHANTOM) {
            removeEmptyBlock(a - 1);
        } else if (a < view.length && chAt(a) === PHANTOM && blockElAt(a) === selection.block) {
            removeEmptyBlock(a);
        } else if (blockElAt(a - 1) !== selection.block) {
            joinBlocks(a - 1, a);
        } else {
            const range = sourceRange(a - charWidth(a, false), a);
            if (range) {
                applyEdit(range.s, range.e, '', { caret: range.s });
            }
        }
        return;
    }
    if (a >= view.length) {
        return;
    }
    if (chAt(a) === PHANTOM) {
        removeEmptyBlock(a);
    } else if (a > 0 && blockElAt(a) !== selection.block) {
        joinBlocks(a - 1, a);
    } else {
        const range = sourceRange(a, a + charWidth(a, true));
        if (range) {
            applyEdit(range.s, range.e, '', { caret: range.s });
        }
    }
};

// The list marker of the item that contains source offset pos: {indent, marker, gap, task}.
const listMarkerAt = (pos) => {
    const norm = view.norm;
    let lineStart = norm.lastIndexOf('\n', pos - 1) + 1;
    for (let tries = 0; tries < 50 && lineStart >= 0; tries++) {
        const line = norm.slice(lineStart, norm.indexOf('\n', lineStart) < 0 ? norm.length : norm.indexOf('\n', lineStart));
        const m = /^((?:[ \t]*>[ \t]?)*)([ \t]*)([-*+]|(\d{1,9})([.)]))([ \t]+|$)(\[[ xX]\][ \t]*)?/.exec(line);
        if (m) {
            const marker = m[4] !== undefined ? `${Number(m[4]) + 1}${m[5]}` : m[3];
            return { lineStart, quote: m[1], indent: m[2], marker, gap: m[6] || ' ', task: !!m[7], line };
        }
        if (lineStart === 0) {
            break;
        }
        lineStart = norm.lastIndexOf('\n', lineStart - 2) + 1;
    }
    return null;
};

const newLine = (hard, selection) => {
    const block = selection.block;
    if (isCell(block)) {
        return;
    }
    const norm = view.norm;
    let s;
    let e;
    if (selection.collapsed) {
        s = e = caretSource(selection);
    } else {
        const range = sourceRange(selection.a.pos, selection.b.pos);
        if (!range) {
            return;
        }
        ({ s, e } = range);
    }
    const lineStart = norm.lastIndexOf('\n', s - 1) + 1;
    const quote = (/^(?:[ \t]*>[ \t]?)+/.exec(norm.slice(lineStart, s)) || [''])[0];

    if (block.closest('pre')) {
        applyEdit(s, e, `\n${quote}`);
        return;
    }
    if (hard) {
        applyEdit(s, e, `  \n${quote}`);
        return;
    }
    if (selection.inPending) {
        return; // a second Enter in the empty paragraph changes nothing
    }

    const a = selection.a.pos;
    const atStart = selection.collapsed && (a === 0 || blockElAt(a - 1) !== block);
    const atEnd = selection.collapsed && (a >= view.length || blockElAt(a) !== block ||
        (chAt(a) === PHANTOM && a + 1 >= view.length));
    const item = block.closest('li') ? listMarkerAt(s) : null;

    if (item) {
        const empty = !block.textContent.split(PHANTOM).join('').trim();
        if (empty) {
            // Enter in an empty item ends the list
            const lineEnd = norm.indexOf('\n', item.lineStart) < 0 ? norm.length : norm.indexOf('\n', item.lineStart);
            applyEdit(item.lineStart, lineEnd, '', { pending: item.lineStart, caret: item.lineStart });
            return;
        }
        applyEdit(s, e, `\n${item.quote}${item.indent}${item.marker}${item.gap}${item.task ? '[ ] ' : ''}`);
        return;
    }
    if (atEnd && !quote) {
        // new empty paragraph after the block; it gets into the source when something is typed in it
        app.pending = s;
        render(app.source, s);
        return;
    }
    if (atStart && !quote && chAt(a) !== PHANTOM) {
        // empty paragraph before the block; the caret stays at the start of the block
        app.pending = lineStart;
        render(app.source, lineStart);
        return;
    }
    applyEdit(s, e, quote ? `\n${quote.trimEnd()}\n${quote}` : '\n\n');
};

const wrapSelection = (mark, selection) => {
    if (selection.collapsed) {
        return;
    }
    const range = sourceRange(selection.a.pos, selection.b.pos);
    if (range) {
        // spaces at the ends of the selection (a double-clicked word includes the space after it) stay outside
        const [, lead, inner, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(view.norm.slice(range.s, range.e));
        if (!inner) {
            return;
        }
        const text = lead + mark + inner + mark + trail;
        applyEdit(range.s, range.e, text, { caret: range.s + text.length - trail.length });
    }
};

// Applies whatever the browser changed itself (IME composition) by comparing the shown text with the last render.
const syncFromDom = () => {
    const now = textGroups(output).map((g) => g.nodes.map((node) => node.data).join('')).join('');
    const old = view.blocks.map((b) => b.text).join('');
    if (now === old) {
        return;
    }
    let p = 0;
    while (p < now.length && p < old.length && now[p] === old[p]) {
        p++;
    }
    let q = 0;
    while (q < now.length - p && q < old.length - p && now[now.length - 1 - q] === old[old.length - 1 - q]) {
        q++;
    }
    const text = clean(now.slice(p, now.length - q));
    const range = old.length - q > p ? sourceRange(p, old.length - q) : null;
    if (range) {
        applyEdit(range.s, range.e, text);
    } else {
        const at = insertionPoint({ pos: p, after: p > 0 });
        applyEdit(at, at, text);
    }
};

output.addEventListener('beforeinput', (event) => {
    if (!app.editable) {
        event.preventDefault();
        return;
    }
    const type = event.inputType;
    if (type === 'insertCompositionText') {
        return; // cannot be cancelled; applied on compositionend
    }
    event.preventDefault();
    const selection = readSelection();
    if (!selection) {
        return;
    }
    if (type === 'insertText' || type === 'insertReplacementText' || type === 'insertFromPaste' ||
        type === 'insertFromYank') {
        const data = event.data ?? (event.dataTransfer && event.dataTransfer.getData('text/plain'));
        if (data) {
            insertText(data, selection);
        }
    } else if (type === 'insertParagraph') {
        newLine(false, selection);
    } else if (type === 'insertLineBreak') {
        newLine(true, selection);
    } else if (type.startsWith('delete') && type !== 'deleteByDrag') {
        deleteText(type.endsWith('Forward'), event, selection);
    } else if (type === 'formatBold') {
        wrapSelection('**', selection);
    } else if (type === 'formatItalic') {
        wrapSelection('*', selection);
    } else if (type === 'formatStrikeThrough') {
        wrapSelection('~~', selection);
    } else if (type === 'historyUndo') {
        tell('undo');
    } else if (type === 'historyRedo') {
        tell('redo');
    }
    // anything else (drag and drop, other formatting) is ignored
});

output.addEventListener('compositionstart', () => {
    app.composing = true;
});

output.addEventListener('compositionend', () => {
    app.composing = false;
    syncFromDom();
    if (app.deferredDoc !== null) {
        const doc = app.deferredDoc;
        app.deferredDoc = null;
        show(doc);
    }
});

// The invisible phantom characters are not copied.
const copySelection = (event) => {
    const text = window.getSelection().toString().split(PHANTOM).join('');
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
};
output.addEventListener('copy', copySelection);
output.addEventListener('cut', (event) => {
    copySelection(event);
    const selection = app.editable ? readSelection() : null;
    if (selection && !selection.collapsed) {
        deleteText(false, { inputType: 'deleteByCut', getTargetRanges: () => [] }, selection);
    }
});
output.addEventListener('dragstart', (event) => event.preventDefault());
output.addEventListener('drop', (event) => event.preventDefault());

document.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || event.altKey) {
        return;
    }
    // event.code is the physical key: Ctrl+Z is "KeyZ" also with a Russian (or any other) keyboard layout,
    // where event.key would be "я"
    const key = event.code;
    const editing = app.editable && document.activeElement === output;
    if (key === 'KeyS') {
        event.preventDefault();
        tell('save');
    } else if (editing && (key === 'KeyZ' || key === 'KeyY')) {
        event.preventDefault();
        tell(key === 'KeyY' || event.shiftKey ? 'redo' : 'undo');
    } else if (editing && (key === 'KeyB' || key === 'KeyI') && !event.shiftKey) {
        event.preventDefault();
        const selection = readSelection();
        if (selection) {
            wrapSelection(key === 'KeyB' ? '**' : '*', selection);
        }
    }
});

// ---------------------------------------------------------------------------- diagrams

const diagrams = {
    generation: 0,
    timer: null,
    cache: new Map(), // theme + source -> svg, so that unchanged diagrams do not flicker while typing

    theme: () => (page.getAttribute('data-theme') === 'dark' ? 'dark' : 'default'),

    key: (theme, source) => `${theme}\n${source}`,

    // Called for newly rendered HTML: diagrams are not editable; known ones are drawn from the cache at once.
    prepare(root) {
        const theme = this.theme();
        for (const block of root.querySelectorAll('.mermaid')) {
            block.setAttribute('contenteditable', 'false');
            block.dataset.source = block.textContent;
            const svg = this.cache.get(this.key(theme, block.dataset.source));
            if (svg) {
                block.innerHTML = svg;
                block.dataset.theme = theme;
            }
        }
    },

    schedule() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.draw(), MERMAID_DELAY_MS);
    },

    drawNow(theme) {
        clearTimeout(this.timer);
        return this.draw(theme);
    },

    remember(theme, source, svg) {
        const key = this.key(theme, source);
        this.cache.delete(key);
        this.cache.set(key, svg);
        if (this.cache.size > SVG_CACHE_SIZE) {
            this.cache.delete(this.cache.keys().next().value);
        }
    },

    async draw(theme = this.theme()) {
        const mine = ++this.generation;
        const blocks = [...output.querySelectorAll('.mermaid')];
        if (!blocks.length) {
            return;
        }
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, suppressErrorRendering: true });

        for (const [i, block] of blocks.entries()) {
            if (mine !== this.generation) {
                return;
            }
            if (block.dataset.theme === theme) {
                continue;
            }
            // The first render replaces the text with SVG, so the source is remembered on the element.
            const source = block.dataset.source ?? block.textContent;
            block.dataset.source = source;
            block.classList.remove('mermaid-error');
            try {
                const { svg, bindFunctions } = await mermaid.render(`mmd-${mine}-${i}-${Date.now()}`, source, block);
                if (mine !== this.generation) {
                    return;
                }
                block.innerHTML = svg;
                block.dataset.theme = theme;
                this.remember(theme, source, svg);
                if (typeof bindFunctions === 'function') {
                    bindFunctions(block);
                }
            } catch (error) {
                delete block.dataset.theme;
                block.classList.add('mermaid-error');
                block.textContent = `Mermaid error: ${error && error.message ? error.message : 'cannot render diagram'}`;
            }
        }
    },
};

// ---------------------------------------------------------------------------- theme and printing

const loadStyle = (href) => {
    if (styleLink.getAttribute('href') === href) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        styleLink.addEventListener('load', resolve, { once: true });
        styleLink.addEventListener('error', resolve, { once: true });
        styleLink.setAttribute('href', href);
    });
};

const setTheme = async (dark) => {
    app.dark = dark;
    page.setAttribute('data-theme', dark ? 'dark' : 'light');
    await loadStyle(dark ? STYLE_DARK : STYLE_LIGHT);
    await diagrams.drawNow();
};

const setEditable = (editable) => {
    app.editable = editable;
    output.setAttribute('contenteditable', editable ? 'true' : 'false');
    output.setAttribute('spellcheck', 'false');
};

// PDF export: always print with the light theme, then switch back.
const prepareForPrint = async () => {
    app.printing = true;
    page.setAttribute('data-theme', 'light');
    await loadStyle(STYLE_LIGHT);
    await diagrams.drawNow('default');
    tell('print-ready');
};

const finishPrint = () => {
    if (app.printing) {
        app.printing = false;
        setTheme(app.dark);
    }
};

window.addEventListener('afterprint', finishPrint);

// ---------------------------------------------------------------------------- page events

// Reports failures to the plugin log (the plugin writes it only when MDNOTEPAD_LOG is set).
document.addEventListener('error', (event) => {
    if (event.target && event.target.tagName === 'IMG') {
        tell(`log:image failed ${event.target.src}`);
    }
}, true);

document.addEventListener('securitypolicyviolation', (event) => {
    tell(`log:csp ${event.violatedDirective} ${event.blockedURI}`);
});

// Links: a click follows them; while the preview is editable a click places the caret and Ctrl+click follows them.
document.addEventListener('click', (event) => {
    const link = event.target.closest && event.target.closest('a[href]');
    if (!link) {
        return;
    }
    event.preventDefault();
    if (app.editable && !event.ctrlKey) {
        return;
    }
    const href = link.getAttribute('href') || '';

    if (href.startsWith('#')) {
        let id = href.slice(1);
        try {
            id = decodeURIComponent(id);
        } catch (e) {
            // use the id as written
        }
        const target = id && document.getElementById(id);
        if (target) {
            target.scrollIntoView();
        } else if (!id) {
            window.scrollTo(0, 0);
        }
    } else if (/^(https?:|mailto:)/i.test(href)) {
        tell(`open:${link.href}`);
    }
});

// ---------------------------------------------------------------------------- commands from the plugin

const commands = {
    settings: (m) => {
        setEditable(m.editable !== false);
        return setTheme(!!m.dark);
    },

    // {drive: 'c', dir: 'Users/me/notes'} -> https://c.mdnotepad.plugin/Users/me/notes/
    doc: (m) => {
        const folders = String(m.dir || '').split('/').filter(Boolean).map((part) => `${encodeURIComponent(part)}/`);
        app.docBase = m.drive ? `https://${m.drive}.mdnotepad.plugin/${folders.join('')}` : '';
    },

    // line end mode of the editor: 0 CRLF, 1 CR, 2 LF
    eol: (m) => {
        app.eol = ['\r\n', '\r', '\n'][m.mode] ?? '\r\n';
    },

    // the editor scrolled; ignored while the user is typing in the preview
    scroll: (m) => {
        if (isEditing()) {
            return;
        }
        const room = page.scrollHeight - page.clientHeight;
        const share = Math.min(1, Math.max(0, m.ppm / 1e6));
        window.scrollTo(0, room > 0 ? room * share : 0);
    },

    'prepare-print': () => prepareForPrint(),

    'restore-theme': () => finishPrint(),
};

if (bridge) {
    bridge.addEventListener('message', ({ data }) => {
        if (typeof data === 'string') {
            show(data);
        } else if (data && commands[data.type]) {
            commands[data.type](data);
        }
    });
}

setEditable(true);
tell('ready');
