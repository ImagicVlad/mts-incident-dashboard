import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { pathFor, remaining } from './api';
import { useLive } from './live';
import type { DeadlineEntry } from './filters/incidentViews';

export function DeadlineFocus({ entries, showingAll, onToggleAll }: {
  entries: DeadlineEntry[]; showingAll: boolean; onToggleAll: () => void;
}) {
  const { now, formats: { stamp, time, dateFormat, zoneLabel } } = useLive();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const choices = entries.slice(0, 3);
  const picked = choices.find(entry => entry.item.id === selectedId);
  const pickedId = picked?.item.id;
  const selected = picked ?? choices[0];
  const title = selected?.item.header || 'Без заголовка';
  const countdown = selected && remaining(selected.deadline, now);
  const today = dateFormat.format(now);

  useEffect(() => {
    if (selectedId !== null && pickedId !== selectedId) setSelectedId(null);
  }, [selectedId, pickedId]);
  const empty = <p className="clock-note empty-clock">Нет активных инцидентов с указанным сроком.</p>;

  return (
    <section className="focus deadline-focus" aria-label="Ближайшие сроки">
      <div className="focus-pattern" aria-hidden="true"/>
      <header className="deadline-head">
        <p className="eyebrow"><span className="signal red-dot"/>Ближайшие сроки</p>
      </header>
      {selected && countdown ? <>
        <div className="deadline-body">
          <strong className="big-clock" role="timer" aria-label={countdown.text}>{countdown.overdue && '−'}{countdown.clock}</strong>
        </div>
        <div className="deadline-switch" role="group" aria-label="Выбор ближайшего срока">
          {choices.map(entry => {
            const fullDate = stamp(entry.deadline);
            const sameMinute = choices.some(other => other !== entry && stamp(other.deadline) === fullDate);
            const date = dateFormat.format(entry.at);
            const description = [fullDate + ' ' + zoneLabel, entry.item.id, entry.item.productName,
              entry.at <= now && 'Просрочен'].filter(Boolean).join(' · ');
            return <button type="button" key={entry.item.id} aria-pressed={selected.item.id === entry.item.id}
              aria-label={description} title={description} onClick={() => setSelectedId(entry.item.id)}>
              <time dateTime={entry.deadline}>{time(entry.deadline)}</time>
              {sameMinute ? <small>{entry.item.id}</small> : date !== today && <small>{date}</small>}
            </button>;
          })}
        </div>
        <div className="deadline-incident">
          <div className="deadline-meta"><span className="mono">{selected.item.id}</span>
            <span>{selected.item.productName || 'Продукт не указан'}</span></div>
          <h3><Link to={pathFor(selected.item.id)} title={title}>
            <span className="deadline-title">{title}</span>
            <ChevronRight size={15} aria-hidden="true"/>
          </Link></h3>
          <p className="deadline-team">{selected.item.assignedGroupName || 'Команда не назначена'}</p>
        </div>
      </> : empty}
      {(entries.length > 0 || showingAll) && (
        <button className="deadline-all" type="button" aria-pressed={showingAll} aria-controls="dashboard-queue" onClick={onToggleAll}>
          <span>{showingAll ? 'Сбросить фильтры' : 'Все сроки · ' + entries.length}</span>
          {!showingAll && <ArrowRight size={20} aria-hidden="true"/>}
        </button>
      )}
    </section>
  );
}
