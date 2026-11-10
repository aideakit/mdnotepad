// MD Notepad - preview page shown inside the Notepad++ panel (WebView2).
//
// Messages from the plugin:  a plain string is the Markdown text to render;
//                            an object is a command ({type: 'settings' | 'doc' | 'scroll' | ...}).
// Messages to the plugin:    plain strings: 'ready', 'print-ready', 'open:<url>', 'log:<text>'.
import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import mermaid from 'mermaid';

const STYLE_LIGHT = 'github-markdown-light.css';
const STYLE_DARK = 'github-markdown-dark-dimmed.css';
const MERMAID_DELAY_MS = 150;

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
    docBase: '',
    printing: false,
};

// ---------------------------------------------------------------------------- markdown

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text) => text.replace(/[&<>"']/g, (ch) => ENTITIES[ch]);

// GitHub-like heading anchors: lower case, punctuation dropped, spaces -> '-', repeats get -1, -2, ...
let usedAnchors = new Map();
const anchorFor = (html) => {
    const plain = html.replace(/<[^>]*>/g, '').trim().toLowerCase();
    const base = plain.replace(/[^\p{L}\p{N}\p{M}\- _]/gu, '').replace(/ /g, '-') || 'section';
    const seen = usedAnchors.get(base) ?? 0;
    usedAnchors.set(base, seen + 1);
    return seen ? `${base}-${seen}` : base;
};

const markdown = new Marked({
    gfm: true,
    renderer: {
        code(token) {
            const language = (token.lang || '').trim().split(/\s+/)[0].toLowerCase();
            if (language !== 'mermaid') {
                return false; // default code block
            }
            return `<pre class="mermaid">${escapeHtml(token.text)}</pre>\n`;
        },
        heading(token) {
            const inner = this.parser.parseInline(token.tokens);
            return `<h${token.depth} id="${anchorFor(inner)}">${inner}</h${token.depth}>\n`;
        },
    },
});

const isRelative = (url) => !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url);

// Images with a relative path are loaded from the folder of the open document.
const resolveImages = () => {
    if (!app.docBase) {
        return;
    }
    for (const img of output.querySelectorAll('img[src]')) {
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

const show = (source) => {
    usedAnchors = new Map();
    output.innerHTML = DOMPurify.sanitize(markdown.parse(source));
    resolveImages();
    diagrams.schedule();
};

// ---------------------------------------------------------------------------- diagrams

const diagrams = {
    generation: 0,
    timer: null,

    theme: () => (page.getAttribute('data-theme') === 'dark' ? 'dark' : 'default'),

    schedule() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.draw(), MERMAID_DELAY_MS);
    },

    drawNow(theme) {
        clearTimeout(this.timer);
        return this.draw(theme);
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
                if (typeof bindFunctions === 'function') {
                    bindFunctions(block);
                }
            } catch (error) {
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

document.addEventListener('click', (event) => {
    const link = event.target.closest && event.target.closest('a[href]');
    if (!link) {
        return;
    }
    event.preventDefault();
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
    settings: (m) => setTheme(!!m.dark),

    // {drive: 'c', dir: 'Users/me/notes'} -> https://c.mdnotepad.plugin/Users/me/notes/
    doc: (m) => {
        const folders = String(m.dir || '').split('/').filter(Boolean).map((part) => `${encodeURIComponent(part)}/`);
        app.docBase = m.drive ? `https://${m.drive}.mdnotepad.plugin/${folders.join('')}` : '';
    },

    scroll: (m) => {
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

tell('ready');
