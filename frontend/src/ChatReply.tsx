import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Link2 } from 'lucide-react';
import { active, overviewStatus, pathFor, remaining, type ChatAnswer, type GroupId, type Incident } from './api';
import { useLive } from './live';

export function AnswerText({text}: {text: string}) {
  const {snapshot} = useLive();
  const pattern = useMemo(() => {
    const ids = (snapshot?.incidents ?? []).map(row => row.id).sort((a, b) => b.length - a.length);
    const escaped = ids.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return escaped.length ? new RegExp('(?<![\\p{L}\\p{N}_-])(' + escaped.join('|') + ')(?![\\p{L}\\p{N}_-])', 'gu') : null;
  }, [snapshot?.incidents]);
  // React renders text, and only a complete ID from this snapshot can become a local link.
  return <>{pattern ? text.split(pattern).map((part, index) =>
    index % 2 ? <Link key={index} to={pathFor(part)}>{part}</Link> : part) : text}</>;
}

function statLabel(group: GroupId, count: number) {
  const singular = count % 10 === 1 && count % 100 !== 11;
  switch (group) {
    case 'critical': return singular ? 'критический' : 'критических';
    case 'assigned': return 'на координаторах';
    case 'high': return 'с высоким приоритетом';
    case 'review': return 'на исследовании';
    case 'history': return singular ? 'решённый' : 'решённых';
  }
}

function IncidentRow({row, metric}: {row: Incident; metric?: ChatAnswer['metric']}) {
  const {snapshot, now} = useLive();
  const groups = snapshot!.groups;
  const assigned = groups.assigned.includes(row.id);
  const tone = groups.critical.includes(row.id) ? 'critical' : groups.high.includes(row.id) ? 'high'
    : assigned ? 'assigned' : 'neutral';
  const timer = active(row) ? remaining(row.deadline, now) : null;
  const showQueue = assigned && tone !== 'critical' && (metric === 'status' || (tone === 'assigned' && metric !== 'sla'));
  const label = showQueue ? 'На координаторах' : timer?.text ?? overviewStatus(row, assigned);
  return <li><Link to={pathFor(row.id)} className="chat-incident-row" data-tone={tone}>
    <span className="chat-incident-meta"><span className="chat-id">{row.id}</span>{row.productName && <span>{row.productName}</span>}</span>
    <span className="chat-incident-title">{row.header || 'Название не указано'}</span>
    <span className="chat-incident-metric">{label}</span>
    <ArrowUpRight className="chat-open-icon" size={15} aria-hidden="true"/>
  </Link></li>;
}

function RelatedIncidents({rows, reason}: {rows: Incident[]; reason: string}) {
  const [open, setOpen] = useState(false);
  return <section className="chat-relation">
    <header><h4><Link2 size={15} aria-hidden="true"/>Возможно связаны</h4><span>{rows.length} инцидента</span></header>
    <p>{reason}</p>
    {open ? <ul className="chat-incidents">{rows.map(row => <IncidentRow key={row.id} row={row}/>)}</ul>
      : <ul className="related-links">{rows.map(row => <li key={row.id}><Link to={pathFor(row.id)}>
          <span className="chat-id">{row.id}</span> {row.header || 'Название не указано'}
        </Link></li>)}</ul>}
    <footer><span>Связь не подтверждена</span><button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
      {open ? 'Свернуть' : 'Открыть инциденты'} <ArrowUpRight size={14} aria-hidden="true"/>
    </button></footer>
  </section>;
}

export function ChatResults({reply}: {reply: ChatAnswer}) {
  const {snapshot} = useLive();
  const [limit, setLimit] = useState(2);
  const [relationLimit, setRelationLimit] = useState(1);
  const byId = useMemo(() => new Map(snapshot?.incidents.map(row => [row.id, row])), [snapshot?.incidents]);
  const rows = (reply.incidents ?? []).flatMap(id => byId.get(id) ?? []);
  const relations = (reply.relations ?? []).filter(group => group.ids.every(id => byId.has(id)));
  const stats = Object.entries(reply.stats ?? {}) as [GroupId, number][];
  const lead = /^В снимке (\d+ инцидент(?:ов|а)?)\.(.*)$/u.exec(reply.answer);
  return <>
    <p className="chat-lead">{lead ? <>В снимке <b>{lead[1]}</b>.{lead[2]}</> : <AnswerText text={reply.answer}/>}</p>
    {stats.length > 0 && <div className="chat-stats">{stats.map(([group, count]) =>
      <span key={group} data-group={group}>{count} {statLabel(group, count)}</span>)}</div>}
    {rows.length > 0 && <section className="chat-priorities">
      {rows.length > 1 && <h4>В первую очередь</h4>}
      <ul className="chat-incidents">{rows.slice(0, limit).map(row => <IncidentRow key={row.id} row={row} metric={reply.metric}/>)}</ul>
    </section>}
    {relations.slice(0, relationLimit).map(group => <RelatedIncidents key={group.ids.join('/')}
      rows={group.ids.map(id => byId.get(id)!)} reason={group.reason}/>)}
    {relations.length > relationLimit && <button className="chat-more" type="button" onClick={() => setRelationLimit(n => n + 1)}>
      Показать следующую связь <ArrowRight size={14} aria-hidden="true"/></button>}
    {rows.length > limit && <button className="chat-more" type="button" onClick={() => setLimit(n => n + 4)}>
      Показать остальные инциденты <ArrowRight size={14} aria-hidden="true"/></button>}
  </>;
}
