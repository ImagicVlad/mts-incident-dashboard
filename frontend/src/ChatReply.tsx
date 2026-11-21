import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { active, overviewStatus, pathFor, remaining, type ChatAnswer } from './api';
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

const PAGE_SIZE = 4;
export function ChatResults({reply}: {reply: ChatAnswer}) {
  const {snapshot, now} = useLive();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const byId = useMemo(() => new Map(snapshot?.incidents.map(row => [row.id, row])), [snapshot?.incidents]);
  const rows = (reply.incidents ?? []).flatMap(id => byId.get(id) ?? []);
  const relations = (reply.relations ?? []).filter(group => group.ids.every(id => byId.has(id)));
  return <>
    {rows.length > 0 && <ul className="chat-incidents">{rows.slice(0, limit).map(row => {
      const timer = reply.metric !== 'status' && active(row) ? remaining(row.deadline, now) : null;
      return <li key={row.id}><Link to={pathFor(row.id)}>
        <span className="chat-incident-meta">{row.id}{row.productName && ' · ' + row.productName}</span>
        <span className="chat-incident-title">{row.header || 'Название не указано'}</span>
        <span className="chat-incident-metric">{timer?.text ?? overviewStatus(row, !!snapshot?.groups.assigned.includes(row.id))}</span>
      </Link></li>;
    })}</ul>}
    {rows.length > limit && <button className="text-action chat-more" type="button" onClick={() => setLimit(n => n + PAGE_SIZE)}>
      Показать ещё ({rows.length - limit})
    </button>}
    {relations.length > 0 && <section className="chat-relations"><h3>Возможно связаны</h3>
      {relations.map(group => <div key={group.ids.join('/')} className="chat-relation">
        {group.ids.map(id => <Link key={id} to={pathFor(id)}><span className="chat-incident-meta">{id}</span> · {byId.get(id)?.header || 'Название не указано'}</Link>)}
        <p>{group.reason}</p>
      </div>)}
    </section>}
  </>;
}
