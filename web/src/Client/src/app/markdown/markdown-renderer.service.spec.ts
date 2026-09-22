import { MarkdownRendererService } from './markdown-renderer.service';

describe('MarkdownRendererService', () => {
  let service: MarkdownRendererService;

  beforeEach(() => service = new MarkdownRendererService());

  it('renders the supported GFM structures', () => {
    const source = '# Заголовок\n\n~~старое~~\n\n- [x] готово\n- [ ] позже\n\n| A | B |\n| - | - |\n| 1 | 2 |';
    const result = service.render('message-1', 1, source);

    expect(result.html).toContain('<h1>Заголовок</h1>');
    expect(result.html).toContain('<s>старое</s>');
    expect(result.html).toContain('aria-label="Выполнено">☑</span>');
    expect(result.html).toContain('<table>');
  });

  it('does not execute raw HTML, unsafe links, or remote images', () => {
    const source = '<script>alert(1)</script> [bad](javascript:alert(1)) ![tracker](https://example.test/pixel.png)';
    const result = service.render('message-2', 1, source);

    expect(result.html).not.toContain('<script>');
    expect(result.html).not.toContain('href="javascript:');
    expect(result.html).not.toContain('<img');
    expect(result.html).toContain('[Изображение: tracker]');
  });

  it('keeps exact fenced source and falls back safely for unknown languages', () => {
    const source = '```not-a-language\nconst raw = "<&";  \n```';
    const result = service.render('message-3', 'partial', source);

    expect(result.codeBlocks).toEqual(['const raw = "<&";  \n']);
    expect(result.html).toContain('not-a-language');
    expect(result.html).toContain('&lt;&amp;');
  });

  it('renders an unfinished fence during streaming', () => {
    const result = service.render('message-4', 2, 'before\n\n```ts\nconst active = true;');

    expect(result.codeBlocks).toEqual(['const active = true;']);
    expect(result.html).toContain('markdown-code');
    expect(result.html).toContain('hljs-keyword');
  });

  it('keys cached values by identity, version, and content', () => {
    const first = service.render('message-5', 1, 'alpha');
    const same = service.render('message-5', 1, 'alpha');
    const changed = service.render('message-5', 2, 'beta');

    expect(same).toBe(first);
    expect(changed).not.toBe(first);
    expect(changed.html).toContain('beta');
  });

  it('bounds very large message rendering', () => {
    const result = service.render('message-large', 1, 'x'.repeat(300 * 1024));

    expect(result.truncated).toBeTrue();
    expect(result.html).toContain('первые 256 КиБ');
    expect(result.html.length).toBeLessThan(270 * 1024);
  });
});
