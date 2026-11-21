import { useRef, useState, useEffect, type ReactNode } from 'react';
import { ArrowUp, RotateCw, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, errorText, pathFor, type Answer, type SummaryAnswer, type Message, type Incident } from './api';
import { useLive } from './live';

function AnswerText({text}:{text:string}) {
  const {snapshot} = useLive();
  const ids = (snapshot?.incidents || []).map(i=>i.id).sort((a,b)=>b.length-a.length);
  let tail = text;
  const parts:ReactNode[] = [];
  // Match only exact identifiers from the current snapshot. Never render model HTML.
  while (tail && ids.length) {
    let pos = -1, match = '';
    for (const id of ids) {
      if (!id) continue;
      const at=tail.indexOf(id);
      if (at>=0 && (pos<0 || at<pos)) {pos=at;match=id;}
    }
    if (pos<0) break;
    parts.push(tail.slice(0,pos), <Link key={parts.length} to={pathFor(match)}>{match}</Link>);
    tail=tail.slice(pos+match.length);
  }
  return <>{parts}{tail}</>;
}
export function Chat() {
  const {snapshot,aiConfigured:configured} = useLive();
  const [messages,setMessages] = useState<(Message & {source?:Answer})[]>([]);
  const [draft,setDraft] = useState('');
  const [error,setError] = useState('');
  const [pending,setPending] = useState(false);
  const history = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(()=>()=>abort.current?.abort(),[]);
  useEffect(()=>{if(history.current)history.current.scrollTop=history.current.scrollHeight;},[messages,pending,error]);
  async function submit() {
    const text = draft.trim();
    if (!text || pending || configured===false) return;
    const turn:Message = {role:'user',content:text};
    const previous=messages, next=[...messages,turn];
    const controller = new AbortController(); abort.current=controller;
    setMessages(next); setPending(true); setDraft(''); setError('');
    try {
      const answer=await api<Answer>('ai/chat',{messages:next.slice(-7).map(({role,content})=>({role,content:content.slice(0,role==='user'?2000:4000)}))},controller.signal);
      setMessages([...next,{role:'assistant',content:answer.answer,source:answer}]);
    } catch (err) {
      if (!controller.signal.aborted) {setMessages(previous);setError(errorText(err));setDraft(text);}
    } finally {setPending(false);}
  }
  return <section className="incident-chat" aria-labelledby="chat-title"><h2 id="chat-title"><span><Sparkles size={17}/></span> ИИ-чат</h2>
    <div className="chat-log" role="log" aria-label="Переписка по инцидентам" ref={history}>
      <div className="chat-message"><strong>Ассистент</strong><p>{configured===false?'ИИ не настроен. Для чата требуется подключение провайдера на сервере.':'Что проверить по смене? Могу подсказать сроки инцидентов и назначенные команды.'}</p></div>
      {!messages.length && configured!==false && <div className="chat-suggestions">{['У какого инцидента ближайший срок?','Какие инциденты на координаторах?'].map(s=><button key={s} onClick={()=>{setDraft(s);input.current?.focus();}}>{s}</button>)}</div>}
      {messages.map((m,k)=><div className={'chat-message '+(m.role==='user'?'from-user':'')} key={k}><strong>{m.role==='user'?'Вы':'Ассистент'}</strong><p><AnswerText text={m.content}/></p>
        {m.source && <small>Снимок {m.source.snapshotVersion}{m.source.stale || m.source.epoch!==snapshot?.epoch || m.source.snapshotVersion!==snapshot?.snapshotVersion?' · данные обновились':''}</small>}</div>)}
    </div>
    {pending && <p className="chat-status" role="status">Ассистент готовит ответ…</p>}
    {error && <p className="chat-error" role="alert">{error} <button className="text-action" onClick={submit}>Повторить</button></p>}
    <form className="chat-form" onSubmit={e=>{e.preventDefault();void submit();}}><input ref={input} aria-label="Вопрос об инцидентах" placeholder="Спросить об инцидентах…" maxLength={2000} value={draft} onChange={e=>setDraft(e.target.value)} disabled={pending || configured===false}/>
      <button type="submit" aria-label="Отправить сообщение" disabled={pending || configured===false || !draft.trim()}><ArrowUp size={18}/></button></form>
  </section>;
}

export function Summary({item}:{item:Incident}) {
  const {snapshot,aiConfigured:configured,formats:{stamp,zoneLabel}} = useLive();
  const [result,setResult] = useState<SummaryAnswer | null>(null);
  const [pending,setPending] = useState(false), [error,setError] = useState('');
  const abort = useRef<AbortController | null>(null);
  useEffect(()=>()=>abort.current?.abort(),[]);
  const stale = result && (result.stale || result.epoch!==snapshot?.epoch || result.snapshotVersion!==snapshot?.snapshotVersion);
  const notes = result?.assessment;
  const routing = !stale && notes?.routing;
  const generate = async () => {
    if (pending) return;
    const controller = new AbortController(); abort.current=controller;
    setPending(true); setError('');
    try {setResult(await api<SummaryAnswer>('ai/summary',{incidentId:item.id},controller.signal));}
    catch(e) {if(!controller.signal.aborted)setError(errorText(e));} finally {setPending(false);}
  };
  return <section className="ai-note"><h2 className="eyebrow"><Sparkles size={16}/> ИИ-сводка</h2>
    {configured===false && <p>ИИ не настроен. Для сводки требуется подключение провайдера на сервере.</p>}
    {notes && <div className="summary-sections">
      <p className="answer-text"><AnswerText text={notes.situation}/></p>
      <section><h3>Влияние</h3><p className="answer-text"><AnswerText text={notes.impact}/></p></section>
      {routing && <section className="summary-routing"><h3>Рекомендация по команде</h3>
        {routing.team && <strong>{routing.team}</strong>}
        <p>{routing.reason}</p>
        {routing.exampleId && <Link to={pathFor(routing.exampleId)}>Похожий инцидент · {routing.exampleId}</Link>}
      </section>}
      <section><h3>Что проверить</h3><p className="answer-text"><AnswerText text={notes.check}/></p></section>
    </div>}
    {result && <>{!notes && <p className="answer-text"><AnswerText text={result.answer}/></p>}
      <small>Снимок {result.snapshotVersion} · {stamp(result.asOf)} {zoneLabel}{stale?' · данные изменились':''}</small></>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {configured!==false && <button className="summary-action" disabled={pending} onClick={generate}><RotateCw size={14}/>{pending?'Готовим сводку…':error?'Повторить':result?'Обновить сводку':'Сформировать сводку'}</button>}
  </section>;
}
