import { Injectable } from '@angular/core';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import MarkdownIt from 'markdown-it';

export interface RenderedMarkdown {
  readonly html: string;
  readonly codeBlocks: readonly string[];
  readonly truncated: boolean;
}

interface CacheEntry extends RenderedMarkdown {
  readonly source: string;
  readonly sourceLength: number;
}

interface RenderEnvironment {
  codeBlocks: string[];
}

const MAX_SOURCE_LENGTH = 256 * 1024;
const MAX_HIGHLIGHT_LENGTH = 64 * 1024;
const MAX_CACHE_ENTRIES = 160;
const MAX_CACHE_SOURCE_LENGTH = 4 * 1024 * 1024;

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  cs: 'csharp',
  csharp: 'csharp',
  docker: 'dockerfile',
  html: 'xml',
  js: 'javascript',
  md: 'markdown',
  ps1: 'powershell',
  py: 'python',
  shell: 'bash',
  sh: 'bash',
  text: 'plaintext',
  ts: 'typescript',
  yml: 'yaml'
};

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('python', python);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

@Injectable({ providedIn: 'root' })
export class MarkdownRendererService {
  private readonly markdown = this.createMarkdown();
  private readonly cache = new Map<string, CacheEntry>();
  private cachedSourceLength = 0;

  render(identity: string, version: string | number, content: string): RenderedMarkdown {
    const source = content ?? '';
    const key = this.cacheKey(identity, version, source);
    const cached = this.cache.get(key);
    if (cached?.source === source) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const truncated = source.length > MAX_SOURCE_LENGTH;
    const renderSource = truncated ? source.slice(0, MAX_SOURCE_LENGTH) : source;
    const environment: RenderEnvironment = { codeBlocks: [] };
    let html: string;
    try {
      html = this.markdown.render(renderSource, environment);
    } catch {
      html = `<p>${this.markdown.utils.escapeHtml(renderSource)}</p>`;
    }
    if (truncated) {
      html += '<p class="markdown-limit-note" role="note">Сообщение слишком велико: показаны первые 256 КиБ.</p>';
    }

    const entry: CacheEntry = {
      html,
      codeBlocks: Object.freeze([...environment.codeBlocks]),
      truncated,
      source,
      sourceLength: renderSource.length
    };
    if (!truncated) this.remember(key, entry);
    return entry;
  }

  clear(): void {
    this.cache.clear();
    this.cachedSourceLength = 0;
  }

  private createMarkdown(): MarkdownIt {
    const markdown = new MarkdownIt({
      breaks: false,
      html: false,
      linkify: false,
      typographer: false
    });

    markdown.renderer.rules['fence'] = (tokens, index, _options, environment) => {
      const token = tokens[index];
      const renderEnvironment = environment as RenderEnvironment;
      renderEnvironment.codeBlocks.push(token.content);
      const requestedLanguage = token.info.trim().split(/\s+/, 1)[0].toLocaleLowerCase('en');
      const language = LANGUAGE_ALIASES[requestedLanguage] ?? requestedLanguage;
      let highlighted = markdown.utils.escapeHtml(token.content);
      let languageLabel = requestedLanguage || 'текст';

      if (token.content.length <= MAX_HIGHLIGHT_LENGTH && language && hljs.getLanguage(language)) {
        try {
          highlighted = hljs.highlight(token.content, { language, ignoreIllegals: true }).value;
          languageLabel = requestedLanguage || language;
        } catch {
          // Escaped plaintext above is the deliberate fallback for malformed/unknown code.
        }
      }

      const escapedLabel = markdown.utils.escapeHtml(languageLabel);
      return `<div class="markdown-code"><div class="markdown-code-head"><span>${escapedLabel}</span></div><pre><code class="hljs language-${markdown.utils.escapeHtml(language || 'plaintext')}">${highlighted}</code></pre></div>`;
    };

    markdown.renderer.rules['code_block'] = (tokens, index, _options, environment) => {
      const token = tokens[index];
      const renderEnvironment = environment as RenderEnvironment;
      renderEnvironment.codeBlocks.push(token.content);
      return `<div class="markdown-code"><div class="markdown-code-head"><span>текст</span></div><pre><code class="hljs language-plaintext">${markdown.utils.escapeHtml(token.content)}</code></pre></div>`;
    };

    markdown.renderer.rules['image'] = (tokens, index) => {
      const token = tokens[index];
      const alt = token.children?.map(child => child.content).join('') || 'без описания';
      return `<span class="markdown-image-placeholder" role="note">[Изображение: ${markdown.utils.escapeHtml(alt)}]</span>`;
    };

    markdown.renderer.rules['table_open'] = () => '<div class="markdown-table-scroll" tabindex="0" role="region" aria-label="Таблица"><table>\n';
    markdown.renderer.rules['table_close'] = () => '</table></div>\n';

    const defaultLinkOpen = markdown.renderer.rules['link_open']
      ?? ((tokens, index, options, _environment, renderer) => renderer.renderToken(tokens, index, options));
    markdown.renderer.rules['link_open'] = (tokens, index, options, environment, renderer) => {
      const href = tokens[index].attrGet('href') ?? '';
      if (/^https?:\/\//i.test(href)) {
        tokens[index].attrSet('target', '_blank');
        tokens[index].attrSet('rel', 'noopener noreferrer');
      }
      return defaultLinkOpen(tokens, index, options, environment, renderer);
    };

    markdown.core.ruler.after('inline', 'task-lists', state => {
      for (let index = 0; index < state.tokens.length; index += 1) {
        const inline = state.tokens[index];
        const first = inline.type === 'inline' ? inline.children?.[0] : undefined;
        const match = first?.type === 'text' ? /^\[([ xX])\]\s+/.exec(first.content) : null;
        if (!first || !match || !this.isInsideListItem(state.tokens, index)) continue;

        first.content = first.content.slice(match[0].length);
        const checkbox = new state.Token('task_checkbox', 'input', 0);
        checkbox.meta = { checked: match[1].toLocaleLowerCase('en') === 'x' };
        inline.children?.unshift(checkbox);
        this.markTaskList(state.tokens, index);
      }
    });
    markdown.renderer.rules['task_checkbox'] = (tokens, index) => {
      const checked = Boolean(tokens[index].meta?.['checked']);
      return `<span class="markdown-task-checkbox" role="img" aria-label="${checked ? 'Выполнено' : 'Не выполнено'}">${checked ? '☑' : '☐'}</span> `;
    };

    return markdown;
  }

  private isInsideListItem(tokens: readonly { type: string; nesting: number }[], index: number): boolean {
    let depth = 0;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const token = tokens[cursor];
      if (token.type === 'list_item_close') depth += 1;
      if (token.type === 'list_item_open') {
        if (depth === 0) return true;
        depth -= 1;
      }
      if (depth === 0 && (token.type === 'bullet_list_open' || token.type === 'ordered_list_open')) return false;
    }
    return false;
  }

  private markTaskList(tokens: { type: string; attrJoin(name: string, value: string): void }[], index: number): void {
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (tokens[cursor].type === 'list_item_open') {
        tokens[cursor].attrJoin('class', 'markdown-task-item');
        break;
      }
    }
  }

  private remember(key: string, entry: CacheEntry): void {
    this.cache.set(key, entry);
    this.cachedSourceLength += entry.sourceLength;
    while (this.cache.size > MAX_CACHE_ENTRIES || this.cachedSourceLength > MAX_CACHE_SOURCE_LENGTH) {
      const oldest = this.cache.entries().next().value as [string, CacheEntry] | undefined;
      if (!oldest) break;
      this.cache.delete(oldest[0]);
      this.cachedSourceLength -= oldest[1].sourceLength;
    }
  }

  private cacheKey(identity: string, version: string | number, content: string): string {
    let hash = 2166136261;
    for (let index = 0; index < content.length; index += 1) {
      hash ^= content.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${identity}\u0000${version}\u0000${content.length}\u0000${hash >>> 0}`;
  }
}
