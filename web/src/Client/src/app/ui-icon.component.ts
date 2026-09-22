import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

export type UiIconName =
  | 'chat'
  | 'work'
  | 'history'
  | 'nodes'
  | 'refresh'
  | 'plus'
  | 'send'
  | 'tool'
  | 'request'
  | 'attempt'
  | 'open'
  | 'logout';

@Component({
  selector: 'ui-icon',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      @switch (name) {
        @case ('chat') { <path d="M4 5.5h16v11H9l-5 3v-14Z"/><path d="M8 9h8M8 13h5"/> }
        @case ('work') { <path d="M4 7h16v12H4z"/><path d="M9 7V4h6v3M4 12h16M10 12v2h4v-2"/> }
        @case ('history') { <path d="M4 12a8 8 0 1 0 2.34-5.66L4 8.68"/><path d="M4 4v4.68h4.68M12 8v4l3 2"/> }
        @case ('nodes') { <circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="12" cy="18" r="2"/><path d="m7.7 7.1 3.2 8.8M16.3 7.1l-3.2 8.8M8 6h8"/> }
        @case ('refresh') { <path d="M20 6v5h-5M4 18v-5h5"/><path d="M18.2 9A7 7 0 0 0 6.1 6.1L4 8m2 7a7 7 0 0 0 11.9 2.9L20 16"/> }
        @case ('plus') { <path d="M12 5v14M5 12h14"/> }
        @case ('send') { <path d="m4 4 17 8-17 8 3-8-3-8Z"/><path d="M7 12h14"/> }
        @case ('tool') { <path d="M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.4 2.4-3-3 2.4-2.4Z"/> }
        @case ('request') { <path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/> }
        @case ('attempt') { <path d="M7 7h10v10H7z"/><path d="M4 10V4h6M20 14v6h-6"/> }
        @case ('open') { <path d="M14 5h5v5M10 14l9-9"/><path d="M19 14v5H5V5h5"/> }
        @case ('logout') { <path d="M10 5H5v14h5M14 8l4 4-4 4M8 12h10"/> }
      }
    </svg>
  `,
  styles: [`:host { display: inline-flex; width: 16px; height: 16px; flex: 0 0 16px; align-items: center; justify-content: center; }`]
})
export class UiIconComponent {
  @Input({ required: true }) name!: UiIconName;
}
