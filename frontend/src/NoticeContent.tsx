import { AlarmClock, CircleCheck, ScanSearch, Siren, TriangleAlert, UsersRound } from 'lucide-react';
import type { Notice, displayFormats } from './api';

const glyphs = {
  critical: TriangleAlert, critical_assigned: Siren, assigned: UsersRound,
  overdue: AlarmClock, research: ScanSearch, resolved: CircleCheck,
};

interface Props {
  event: Notice;
  title?: string | null;
  formats: ReturnType<typeof displayFormats>;
  today: string;
}

export function NoticeContent({event, title, formats, today}: Props) {
  const Glyph = glyphs[event.kind];
  const timestamp = Date.parse(event.time);
  const fullTime = formats.stamp(event.time);
  const isToday = Number.isFinite(timestamp) && formats.dateFormat.format(timestamp) === today;
  return <>
    <span className="notice-glyph" aria-hidden="true"><Glyph size={18} strokeWidth={1.8}/></span>
    <span className="notice-copy">
      <span className="notice-label">{event.label}</span>
      <strong className="notice-title" title={title || undefined}>{title || event.incidentId}</strong>
      <span className="notice-meta">
        {title && <span className="notice-id">{event.incidentId}</span>}
        <time dateTime={event.time} title={fullTime + ' ' + formats.zoneLabel}>
          {isToday ? formats.time(event.time) : fullTime}
        </time>
      </span>
    </span>
  </>;
}
