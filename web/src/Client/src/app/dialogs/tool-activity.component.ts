import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { ToolCallSummary } from './dialogs.models';
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

  @Output() readonly inspect = new EventEmitter<ToolActivitySelection>();
  @Output() readonly loadMore = new EventEmitter<ToolActivityGroup>();

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
    this.inspect.emit({
      requestId: this.group.requestId,
      attemptId: this.group.attemptId,
      toolCall
    });
  }

  duration(toolCall: ToolCallSummary): string {
    return toolCallDuration(toolCall);
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
