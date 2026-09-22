import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { SafeContent, ToolCallDetail, ToolCallSummary } from './dialogs.models';
import { ToolActivityGroup, ToolActivitySelection } from './tool-activity.models';
import { toolCallDuration } from './tool-activity';

@Component({
  selector: 'app-tool-activity',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './tool-activity.component.html',
  styleUrl: './tool-activity.component.css'
})
export class ToolActivityComponent implements OnChanges {
  @Input({ required: true }) group!: ToolActivityGroup;
  @Input() selectedToolCallId: string | null = null;
  @Input() toolDetail: ToolCallDetail | null = null;
  @Input() loading = false;

  @Output() readonly inspect = new EventEmitter<ToolActivitySelection>();
  @Output() readonly close = new EventEmitter<void>();
  @Output() readonly loadMore = new EventEmitter<ToolActivityGroup>();
  @Output() readonly loadMoreOutputs = new EventEmitter<void>();

  open = false;
  private currentKey = '';
  private manuallyToggled = false;

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['group'] || !this.group) return;
    if (this.currentKey !== this.group.key) {
      this.currentKey = this.group.key;
      this.manuallyToggled = false;
      this.open = this.group.state === 'running';
      return;
    }
    if (!this.manuallyToggled && this.group.state === 'running') this.open = true;
  }

  toggle(event: Event): void {
    this.open = (event.currentTarget as HTMLDetailsElement).open;
    if (event.isTrusted) this.manuallyToggled = true;
  }

  select(toolCall: ToolCallSummary): void {
    if (this.selectedToolCallId === toolCall.toolCallId) {
      this.close.emit();
      return;
    }
    this.inspect.emit({
      requestId: this.group.requestId,
      attemptId: this.group.attemptId,
      toolCall
    });
  }

  duration(toolCall: ToolCallSummary): string {
    return toolCallDuration(toolCall);
  }

  detailFor(toolCall: ToolCallSummary): ToolCallDetail | null {
    return this.toolDetail?.toolCallId === toolCall.toolCallId ? this.toolDetail : null;
  }

  actionKind(toolCall: ToolCallSummary): string {
    const name = toolCall.toolName.toLocaleLowerCase('en');
    if (/command|shell|terminal|exec/.test(name)) return 'Терминал';
    if (/read|fetch|get|open/.test(name)) return 'Чтение';
    if (/write|edit|patch|change/.test(name)) return 'Изменение';
    if (/find|search|query|list/.test(name)) return 'Поиск';
    if (/browser|navigate|click/.test(name)) return 'Браузер';
    return 'Инструмент';
  }

  actionLabel(toolCall: ToolCallSummary): string {
    const detail = this.detailFor(toolCall);
    const preview = detail ? this.inputPreview(detail.input) : '';
    if (preview) return preview;
    const friendly: Record<string, string> = {
      'cursor.command': 'Выполнение команды',
      'shell.command': 'Выполнение команды',
      read_file: 'Чтение файла',
      write_file: 'Запись файла',
      list_files: 'Просмотр файлов'
    };
    return friendly[toolCall.toolName] ?? toolCall.toolName.replace(/[._-]+/g, ' ');
  }

  toolName(toolCall: ToolCallSummary): string {
    return toolCall.toolName.replace(/[._-]+/g, ' ');
  }

  safeContentText(content?: SafeContent): string {
    if (!content) return 'Нет данных';
    if (content.kind === 'inline') return content.content;
    if (content.kind === 'artifact') return `Артефакт ${content.artifactId} · ${this.fileSize(content.sizeBytes)}`;
    return `Содержимое недоступно: ${content.reason}`;
  }

  safeContentNote(content?: SafeContent): string {
    if (!content) return '';
    const notes: string[] = [];
    if (content.redaction === 'applied') notes.push('секреты скрыты');
    else if (content.redaction === 'unknown') notes.push('статус редактирования неизвестен');
    if (content.truncated) notes.push('содержимое сокращено');
    return notes.join(' · ');
  }

  private inputPreview(content?: SafeContent): string {
    if (content?.kind !== 'inline') return '';
    const source = content.content.trim();
    try {
      const parsed = JSON.parse(source) as Record<string, unknown>;
      for (const key of ['command', 'path', 'query', 'url']) {
        const value = parsed[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    } catch {
      const value = source.match(/(?:Команда|command|path|query|url)\s*:\s*([^\r\n]+)/i)?.[1]?.trim();
      if (value) return value;
    }
    return '';
  }

  private fileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КиБ`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} МиБ`;
  }

  countLabel(count: number): string {
    const remainder = count % 100;
    const digit = count % 10;
    const noun = remainder >= 11 && remainder <= 14
      ? 'действий'
      : digit === 1 ? 'действие' : digit >= 2 && digit <= 4 ? 'действия' : 'действий';
    return `${count} ${noun}`;
  }

  stateLabel(state: ToolCallSummary['state']): string {
    switch (state) {
      case 'running': return 'Выполняется';
      case 'succeeded': return 'Завершено';
      case 'failed': return 'Ошибка';
      default: return 'Результат неизвестен';
    }
  }

  groupStateLabel(state: ToolActivityGroup['state']): string {
    switch (state) {
      case 'running': return 'В процессе';
      case 'succeeded': return 'Завершено';
      case 'failed': return 'Есть ошибка';
      case 'interrupted': return 'Прервано';
      default: return 'Состояние неизвестно';
    }
  }
}
