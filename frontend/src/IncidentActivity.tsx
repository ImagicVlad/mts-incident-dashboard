import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { GitCommitHorizontal, MessageSquare, ArrowRight, Check, LoaderCircle } from 'lucide-react';
import { api, errorText, type Incident } from './api';
import { useLive } from './live';

type Value = string | number | null;
type Entry = {id:string; time:string; author:string} & (
  {kind:'first'|'change'; body:{field:string; before:Value; after:Value}[]} |
  {kind:'comment'; body:string}
);
type Page = {entries:Entry[]; next:number|null};
const fields:Record<string,string> = {
  header:'Название', stateEnum:'Статус', priorityId:'Приоритет', productName:'Продукт', service:'Сервис',
  assignedGroupName:'Команда', assignedEmployee:'Исполнитель', deadline:'Срок решения', submitDate:'Начало',
  lastAssignmentToTeamDateTime:'Время назначения', completionDate:'Завершение',
  description:'Описание', shortDescription:'Краткое описание', solution:'Решение',
};
const states:Record<string,string> = {Assigned:'Назначен', WorkInProgress:'В работе', Research:'Исследование', Resolved:'Решён', Closed:'Закрыт'};
const priorities:Record<string,string> = {'1':'Низкий','2':'Средний','3':'Высокий','4':'Наивысший'};

export function IncidentActivity({item}: {item: Incident}) {
  const client = useQueryClient();
  const {formats:{stamp,zoneLabel}} = useLive();
  const [draft,setDraft] = useState('');
  const commentId = useRef<string | null>(null);
  const [sending,setSending] = useState(false);
  const [error,setError] = useState('');
  const path = 'incidents/'+encodeURIComponent(item.id);
  const history = useInfiniteQuery({
    queryKey:['incident-activity',item.id],
    initialPageParam:null as number|null,
    queryFn:({pageParam,signal})=>api<Page>(path+'/activity'+(pageParam?'?before='+pageParam:''),undefined,signal),
    getNextPageParam:page=>page.next ?? undefined,
    refetchInterval:8000,
  });
  useEffect(()=>{
    void client.invalidateQueries({queryKey:['incident-activity',item.id]});
  },[client,item]);
  function value(field:string, raw:Value) {
    if (raw===null || raw==='') return '—';
    const text=String(raw);
    if (field==='stateEnum') return states[text] ?? text;
    if (field==='priorityId') return priorities[text] ?? text;
    if (['deadline','submitDate','completionDate','lastAssignmentToTeamDateTime'].includes(field)) return stamp(text);
    return text;
  }
  async function submit() {
    if (!draft.trim() || sending) return;
    setSending(true); setError('');
    try {
      commentId.current ??= Array.from(crypto.getRandomValues(new Uint8Array(16)), byte=>byte.toString(16).padStart(2,'0')).join('');
      await api(path+'/comments',{id:commentId.current,text:draft.trim()});
      setDraft(''); commentId.current=null;
      await client.invalidateQueries({queryKey:['incident-activity',item.id]});
    } catch(err) {setError(errorText(err));}
    finally {setSending(false);}
  }
  return <section className="incident-activity" aria-labelledby="activity-title">
    <header><GitCommitHorizontal size={22} aria-hidden="true"/><h2 id="activity-title">История изменений</h2></header>
    <form className="comment-form" onSubmit={e=>{e.preventDefault(); void submit();}}>
      <label htmlFor="incident-comment">Комментарий</label>
      <div className="comment-composer" aria-busy={sending}>
        <textarea id="incident-comment" placeholder="Что проверили или передали команде?" maxLength={2000}
          rows={2} value={draft} readOnly={sending} onChange={e=>{setDraft(e.target.value);commentId.current=null;}}
          onKeyDown={e=>{if ((e.ctrlKey || e.metaKey) && e.key==='Enter') {e.preventDefault(); void submit();}}}/>
        <button type="submit" className="comment-submit" disabled={sending || !draft.trim()}
          aria-label={sending?'Отправляем комментарий':'Добавить комментарий'} title="Отправить комментарий (Ctrl+Enter / ⌘+Enter)">
          {sending ? <LoaderCircle size={20} aria-hidden="true"/> : <Check size={21} strokeWidth={2.5} aria-hidden="true"/>}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
    {history.isPending && <p role="status">Загружаем историю…</p>}
    {history.isError && <p role="alert">Не удалось загрузить историю. <button className="text-action" onClick={()=>void history.refetch()}>Повторить</button></p>}
    <ol className="activity-list">{history.data?.pages.flatMap(page=>page.entries).map(entry=><li key={entry.id}>
      <span className="activity-node">{entry.kind==='comment'?<MessageSquare size={14}/>:<GitCommitHorizontal size={17}/>}</span>
      <div className="activity-meta"><code title={entry.id}>{entry.id.slice(0,7)}</code><span>{entry.author}</span>
        <time dateTime={entry.time}>{stamp(entry.time)} {zoneLabel}</time></div>
      {entry.kind==='comment'? <p className="activity-comment">{entry.body}</p> : entry.kind==='first'?
        <p>Карточка впервые загружена в пульт</p> : entry.body.map(change=><div className="activity-diff" key={change.field}>
          <strong>{fields[change.field] ?? change.field}</strong>
          <span>{value(change.field,change.before)}</span><ArrowRight size={13} aria-label="изменено на"/><b>{value(change.field,change.after)}</b>
        </div>)}
    </li>)}</ol>
    {history.hasNextPage && <button className="button secondary" disabled={history.isFetchingNextPage} onClick={()=>void history.fetchNextPage()}>Показать более ранние записи</button>}
  </section>;
}
