import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft, ExternalLink } from 'lucide-react';
import { active, finished, remaining } from './api';
import { Pill } from './Dashboard';
import { Summary } from './Intelligence';
import { useLive } from './live';

export function Details() {
  const {id} = useParams();
  const {snapshot,now,bootstrapError,formats:{stamp,time,zoneLabel}} = useLive();
  const item = snapshot?.incidents.find(i=>i.id===id);
  useEffect(()=>{document.title = (item?.header || 'Инцидент')+' · Пульт координатора';},[item?.header]);
  useEffect(()=>{window.scrollTo(0,0);},[id]);
  if (!item) return <main className="container waiting"><h1>{snapshot?.hasSnapshot ? 'Инцидент не найден' : bootstrapError || snapshot?.sourceStatus==='error' ? 'Данные недоступны' : 'Загружаем инцидент…'}</h1>
    {snapshot?.hasSnapshot && <p>В текущей выгрузке нет записи с номером {id}.</p>}<Link to="/dashboard" className="button secondary">Вернуться на дашборд</Link></main>;
  const research = item.stateEnum==='Research';
  const countdown = active(item)?remaining(item.deadline,now):null;
  const rows = [
    ...(item.dataOrigin === 'defense-scenario' ? [['Источник', 'Сценарий защиты']] : []),
    ['Продукт',item.productName],['Сервис',item.service],['Приоритет',item.priority],
    ['Команда назначения',item.assignedGroupName],['Исполнитель',item.assignedEmployee],
    ['Время возникновения',stamp(item.submitDate)], ['Плановый срок устранения',stamp(item.deadline)],
    ...(item.completionDate?[['Завершение по данным источника',stamp(item.completionDate)]]:[]),
  ];
  const description = item.description || item.shortDescription;
  return <main className="container record-page"><nav className="crumb" aria-label="Путь"><Link to="/dashboard"><ChevronLeft size={15}/> Дашборд</Link><span>/</span>{item.id}</nav>
    <article className="record default-record"><h1>{item.header || 'Без заголовка'}</h1>
    <div className="record-grid"><section className="paper">
      <header className="paper-heading"><h2>Данные инцидента</h2><div className="record-label"><span className="mono">{item.id}</span><Pill item={item}/></div></header>
      <dl className="facts">{rows.map(([name,value])=><div key={name}><dt>{name}</dt><dd>{value || 'Не указан'}</dd></div>)}</dl>
      <section className="record-text"><h3>Описание</h3><p>{description || 'Описание отсутствует.'}</p></section>
      {item.solution && <section className="record-text"><h3>Решение из источника</h3><p>{item.solution}</p></section>}
      {item.diagnostics?.length>0 && <details className="record-text"><summary>Замечания к записи</summary><ul>{item.diagnostics.map((d,k)=><li key={k}>{d}</li>)}</ul></details>}
    </section><aside>
      <section className="focus compact-focus"><div className="focus-pattern" aria-hidden="true"/><p className="eyebrow"><span className="signal red-dot"/>{research ? 'Сбой устранён' : finished(item) ? 'Завершение' : 'Срок решения'}</p>
        <strong className="big-clock">{time((research || finished(item)) ? item.completionDate : item.deadline)}</strong>
        {research && <p>Идёт разбор причин</p>}
        <p className="clock-note">{research || finished(item) ? (item.completionDate?'По данным источника · '+stamp(item.completionDate)+' '+zoneLabel:'Дата завершения не указана') : (countdown?.text || 'Срок не указан')}</p>
      </section>
      <Summary key={item.id} item={item}/>
      {item.itsmUrl && /^https?:\/\//i.test(item.itsmUrl) ? <a className="button secondary" href={item.itsmUrl} target="_blank" rel="noopener noreferrer">Открыть в ITSM <ExternalLink size={16}/></a> : item.dataOrigin !== 'defense-scenario' && <p className="integration-note">Внешняя ITSM не подключена</p>}
    </aside></div></article><Link className="button secondary" to="/dashboard">Вернуться на дашборд</Link>
  </main>;
}
