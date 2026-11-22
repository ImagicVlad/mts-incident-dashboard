import { useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ExternalLink } from 'lucide-react';
import { IncidentActivity } from './IncidentActivity';
import { FilterPicker } from './filters/FilterTools';
import { active, api, errorText, finished, remaining, type Incident, type Snapshot } from './api';
import { overviewStatus, Pill } from './Dashboard';
import { Summary } from './Intelligence';
import { useLive } from './live';
import type { ConsoleOutlet } from './Console';

function observeDataHeight(paper: HTMLElement | null) {
  const grid = paper?.parentElement;
  if (!paper || !grid) return;
  const observer = new ResizeObserver(([entry]) => {
    grid.style.setProperty('--incident-data-height', `${entry.borderBoxSize[0].blockSize}px`);
  });
  observer.observe(paper, {box: 'border-box'});
  return () => observer.disconnect();
}

function Assignment({item, incidents}: {item: Incident; incidents: Incident[]}) {
  const {applyAssignment} = useLive();
  const [open, setOpen] = useState(false);
  const [team, setTeam] = useState('');
  const [employee, setEmployee] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  if (!open) return <button className="button secondary assignment-start" onClick={()=>setOpen(true)}><svg width="18" height="18" aria-hidden="true"><use href="/queue-icons.svg#users-plus"/></svg>Назначить команду</button>;
  function options(values:(string | null)[]) {
    return [...new Set(values.filter((v): v is string => Boolean(v)))].sort((a,b)=>a.localeCompare(b,'ru')).map(value=>({value,label:value}));
  }
  const teams = options(incidents.filter(i=>i.assignedGroupName!==item.assignedGroupName).map(i=>i.assignedGroupName));
  const members = options(incidents.filter(i=>i.assignedGroupName===team).map(i=>i.assignedEmployee));
  return <form className="assignment-form" onSubmit={async event=>{
    event.preventDefault();
    setPending(true); setError('');
    try {
      const updated = await api<Snapshot>('incidents/'+encodeURIComponent(item.id)+'/assignment?includeSnapshot=true', {team, employee:employee || null,
        expectedEmployee:item.assignedEmployee, expectedTime:item.lastAssignmentToTeamDateTime});
      applyAssignment(updated);
      setOpen(false);
    } catch (err) {setError(errorText(err));}
    finally {setPending(false);}
  }}>
    <fieldset disabled={pending}>
      <div className="assignment-fields">
        <div><label htmlFor="assignment-team">Профильная команда</label>
          {teams.length ? <FilterPicker id="assignment-team" name="Профильная команда" selected={team} display={team || 'Выберите команду'} options={teams}
            onSelect={value=>{if (value!==team) {setTeam(value); setEmployee('');}}}/> : <small>В данных смены нет профильных команд.</small>}</div>
        <div><label htmlFor="assignment-employee">Исполнитель</label>
          {team && members.length ? <FilterPicker id="assignment-employee" name="Исполнитель" selected={employee} display={employee || 'Без исполнителя'}
            options={[{value:'',label:'Без исполнителя'},...members]} onSelect={setEmployee}/> :
            <button type="button" className="sort-picker-trigger" id="assignment-employee" disabled>{team?'Без исполнителя':'Сначала выберите команду'}</button>}</div>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="assignment-actions"><button className="button primary" disabled={!team}>{pending?'Передаём…':'Передать команде'}</button>
        <button type="button" className="button secondary" onClick={()=>{setOpen(false); setTeam(''); setEmployee(''); setError('');}}>Отмена</button></div>
    </fieldset>
  </form>;
}

export function Details() {
  const {id} = useParams();
  const {user} = useOutletContext<ConsoleOutlet>();
  const {snapshot,now,bootstrapError,formats:{stamp,time,dateFormat,zoneLabel}} = useLive();
  const item = snapshot?.incidents.find(i=>i.id===id);
  useEffect(()=>{document.title = (item?.header || 'Инцидент')+' · Пульт координатора';},[item?.header]);
  useEffect(()=>{window.scrollTo(0,0);},[id]);
  if (!item) return <main className="container waiting"><h1>{snapshot?.hasSnapshot ? 'Инцидент не найден' : bootstrapError || snapshot?.sourceStatus==='error' ? 'Данные недоступны' : 'Загружаем инцидент…'}</h1>
    {snapshot?.hasSnapshot && <p>В текущей выгрузке нет записи с номером {id}.</p>}<Link to="/dashboard" className="button secondary">Вернуться на дашборд</Link></main>;
  const research = item.stateEnum==='Research';
  const onCoordinators = snapshot?.groups.assigned.includes(item.id);
  const countdown = active(item)?remaining(item.deadline,now):null;
  const rows = [
    ...(item.dataOrigin === 'defense-scenario' ? [['Источник', 'Сценарий защиты']] : []),
    ['Продукт',item.productName],['Сервис',item.service],['Приоритет',item.priority],
    [onCoordinators ? 'Профильная команда' : 'Команда назначения',onCoordinators ? 'Ещё не назначена' : item.assignedGroupName],
    [onCoordinators ? 'Координатор' : 'Исполнитель',item.assignedEmployee],
    ...(onCoordinators ? [['Следующий шаг', research
      ? 'Передать разбор причин профильной команде' : 'Передать инцидент профильной команде']] : []),
  ];
  const showAssignment = !onCoordinators && (active(item) || research) && item.assignedGroupName;
  const dates = [
    {label:'Начало', value:item.submitDate},
    {label:'У команды с', value:showAssignment ? item.lastAssignmentToTeamDateTime : null},
    {label:'Срок решения', value:item.deadline},
    {label:'Завершение', value:item.completionDate},
  ].flatMap(({label,value}) => value ? [{label,value,day:dateFormat.format(new Date(value))}] : []);
  const sharedDay = dates.length && dates.every(entry => entry.day === dates[0].day) ? dates[0].day : null;
  const description = item.description || item.shortDescription;
  return <main className="container record-page"><nav className="crumb" aria-label="Путь"><Link to="/dashboard"><ChevronLeft size={15}/> Дашборд</Link><span>/</span>{item.id}</nav>
    <article className="record default-record"><h1>{item.header || 'Без заголовка'}</h1>
    <div className="record-grid"><section className="paper" ref={observeDataHeight}>
      <header className="paper-heading"><h2>Данные инцидента</h2><div className="record-label"><span className="mono">{item.id}</span><Pill item={item} label={active(item) ? overviewStatus(item,Boolean(onCoordinators)) : undefined}/></div></header>
      <dl className="facts">{rows.map(([name,value])=><div key={name}><dt>{name}</dt><dd>{value || 'Не указан'}</dd></div>)}</dl>
      {dates.length > 0 && <section className="incident-dates" aria-label="Даты инцидента">
        <div className="incident-dates-heading"><CalendarDays size={15} aria-hidden="true"/>
          <span>{sharedDay || 'Даты инцидента'}</span><span className="dates-zone">{zoneLabel}</span>
        </div>
        <dl>{dates.map(({label,value,day})=><div key={label}>
          <dt>{label}</dt>
          <dd><time dateTime={value} title={stamp(value)+' '+zoneLabel}>
            {time(value)}{!sharedDay && <small>{day}</small>}
          </time></dd>
        </div>)}</dl>
      </section>}
      <section className="record-text"><h3>Описание</h3><p>{description || 'Описание отсутствует.'}</p></section>
      {item.solution && <section className="record-text"><h3>Решение из источника</h3><p>{item.solution}</p></section>}
      {item.diagnostics?.length>0 && <details className="record-text"><summary>Замечания к записи</summary><ul>{item.diagnostics.map((d,k)=><li key={k}>{d}</li>)}</ul></details>}
      {onCoordinators && user.role==='coordinator' && snapshot && <footer className="assignment-footer">
        <Assignment key={JSON.stringify([item.id,item.assignedEmployee,item.lastAssignmentToTeamDateTime])} item={item} incidents={snapshot.incidents}/>
      </footer>}
    </section><aside><div className="record-panels">
      <section className="focus compact-focus"><div className="focus-pattern" aria-hidden="true"/><p className="eyebrow"><span className="signal red-dot"/>{research ? 'Сбой устранён' : finished(item) ? 'Завершение' : 'Срок решения'}</p>
        <strong className="big-clock">{time((research || finished(item)) ? item.completionDate : item.deadline)}</strong>
        {research && <p>Идёт разбор причин</p>}
        <p className="clock-note">{research || finished(item) ? (item.completionDate?'По данным источника · '+stamp(item.completionDate)+' '+zoneLabel:'Дата завершения не указана') : (countdown?.text || 'Срок не указан')}</p>
      </section>
      <Summary key={item.id} item={item}/>
      </div>
      {item.itsmUrl && /^https?:\/\//i.test(item.itsmUrl) && <a className="button secondary" href={item.itsmUrl} target="_blank" rel="noopener noreferrer">Открыть в ITSM <ExternalLink size={16}/></a>}
    </aside></div></article>
    <IncidentActivity key={item.id} item={item}/>
  </main>;
}
