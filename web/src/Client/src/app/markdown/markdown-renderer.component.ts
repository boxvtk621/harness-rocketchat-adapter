import { CommonModule } from '@angular/common';
import { AfterViewInit, Component, ElementRef, Input, OnChanges, SimpleChanges, ViewChild, ViewEncapsulation, signal } from '@angular/core';
import { MarkdownRendererService, RenderedMarkdown } from './markdown-renderer.service';

@Component({
  selector: 'app-markdown-renderer',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div #contentRoot class="markdown-renderer__content" [innerHTML]="rendered.html" (click)="handleContentClick($event)"></div>
    <span class="markdown-renderer__status" aria-live="polite">{{ copyStatus() }}</span>
  `,
  styleUrl: './markdown-renderer.component.css',
  encapsulation: ViewEncapsulation.None
})
export class MarkdownRendererComponent implements OnChanges, AfterViewInit {
  @Input({ required: true }) identity = '';
  @Input() version: string | number = '';
  @Input({ required: true }) content = '';

  rendered: RenderedMarkdown = { html: '', codeBlocks: [], truncated: false };
  readonly copyStatus = signal('');
  @ViewChild('contentRoot') private contentRoot?: ElementRef<HTMLElement>;

  constructor(private readonly markdownRenderer: MarkdownRendererService) {}

  ngOnChanges(_changes: SimpleChanges): void {
    this.rendered = this.markdownRenderer.render(this.identity, this.version, this.content);
    this.copyStatus.set('');
    window.setTimeout(() => this.installCopyButtons());
  }

  ngAfterViewInit(): void { this.installCopyButtons(); }

  async handleContentClick(event: MouseEvent): Promise<void> {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('.markdown-copy-code') : null;
    if (!target) return;
    const match = [...target.classList].map(name => /^markdown-copy-(\d+)$/.exec(name)).find(Boolean);
    const index = match ? Number(match[1]) : Number.NaN;
    const source = this.rendered.codeBlocks[index];
    if (source === undefined) return;

    try {
      await navigator.clipboard.writeText(source);
      this.copyStatus.set('Код скопирован.');
    } catch {
      this.copyStatus.set(this.copyWithSelection(source) ? 'Код скопирован.' : 'Не удалось скопировать код.');
    }
  }

  private copyWithSelection(source: string): boolean {
    const textarea = document.createElement('textarea');
    textarea.value = source;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    } finally {
      textarea.remove();
    }
    return copied;
  }

  private installCopyButtons(): void {
    const root = this.contentRoot?.nativeElement;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('.markdown-code-head').forEach((head, index) => {
      if (head.querySelector('.markdown-copy-code')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `markdown-copy-code markdown-copy-${index}`;
      button.setAttribute('aria-label', 'Копировать блок кода');
      button.textContent = 'Копировать';
      head.append(button);
    });
  }
}
