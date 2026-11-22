import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { finished, type Incident } from '../api';
import { overviewStatus } from '../Dashboard';
import { useLive } from '../live';

type Size = {width: number; height: number};
type Anchor = {x: number; y: number; bottom: number};

export function IncidentTooltip({id, item, anchor, bounds}: {
  id: string; item: Incident; anchor: Anchor; bounds: Size;
}) {
  const {snapshot, formats: {stamp, zoneLabel}} = useLive();
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<Size>({width: 240, height: 140});
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const {width, height} = el.getBoundingClientRect();
      setSize(last => last.width === width && last.height === height ? last : {width, height});
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [item]);

  const margin = 8, gap = 9;
  const below = anchor.y < size.height + gap + margin;
  const x = Math.max(margin + size.width / 2, Math.min(bounds.width - margin - size.width / 2, anchor.x));
  const top = below ? Math.max(margin - gap, Math.min(anchor.bottom, bounds.height - margin - size.height - gap))
    : anchor.y;
  const style = {left:x, top, '--tip-x': Math.max(12, Math.min(size.width - 12, size.width / 2 + anchor.x - x)) + 'px'} as CSSProperties;
  const restored = finished(item) || item.stateEnum === 'Research';
  const date = restored ? item.completionDate : item.deadline;
  const onCoordinators = snapshot?.groups.assigned.includes(item.id) ?? false;

  return <div id={id} ref={ref} role="tooltip" className="graph-tooltip" data-placement={below ? 'below' : 'above'} style={style}>
    <span className="graph-tooltip-id">{item.id}</span>
    <strong>{item.header || 'Без названия'}</strong>
    <dl>
      <dt>Статус</dt><dd>{overviewStatus(item,onCoordinators)}</dd>
      <dt>Команда</dt><dd>{item.assignedGroupName || 'Не назначена'}</dd>
      <dt>{restored ? 'Устранён' : 'Срок SLA'}</dt>
      <dd>{date ? <time dateTime={date}>{stamp(date)} {zoneLabel}</time> : 'Не указан'}</dd>
    </dl>
  </div>;
}
