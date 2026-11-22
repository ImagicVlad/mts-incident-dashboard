import { useState } from 'react';
import { Flag, Pause, Play, Search, TriangleAlert, UsersRound } from 'lucide-react';
import './workspace-identity.css';

const queues = [
  { key: 'critical', label: 'Критические', count: '05', note: 'Нужна реакция сейчас', Icon: TriangleAlert },
  { key: 'high', label: 'Высокий приоритет', count: '00', note: 'Под наблюдением', Icon: Flag },
  { key: 'assigned', label: 'На координаторах', count: '05', note: 'Ждут передачи команде', Icon: UsersRound },
  { key: 'review', label: 'Исследование', count: '11', note: 'Разбор причин', Icon: Search },
];

export default function WorkspaceIdentity() {
  const [paused, setPaused] = useState(false);
  const control = paused ? 'Продолжить анимацию' : 'Приостановить анимацию';
  return (
    <section className="auth-art workspace-identity" aria-labelledby="workspace-heading">
      <div className="workspace-brand">
        <img src="/mts-logo.svg" width="40" height="40" alt="МТС"/>
        <span>Управление инцидентами</span>
      </div>
      <div className="workspace-content">
        <div className="workspace-introduction">
          <h2 id="workspace-heading">Пульт <span>координатора</span></h2>
          <p>Следите за сроками и передавайте инциденты ответственным командам.</p>
        </div>
        <div className="shift-preview" data-paused={paused}>
          <div className="shift-preview-heading">
            <span>Очереди смены</span>
            <button type="button" aria-label={control} title={control} onClick={()=>setPaused(!paused)}>
              {paused ? <Play size={14}/> : <Pause size={14}/>}
            </button>
          </div>
          <div className="shift-stage" role="img" aria-label="Пример смены: из четырёх очередей выделяется инцидент, назначенный координаторам.">
            {queues.map(({key,label,count,note,Icon})=>(
              <div key={key} className={'shift-tile shift-'+key} aria-hidden="true">
                <span className="shift-icon"><Icon size={16} strokeWidth={1.8}/></span>
                <span className="shift-count">{count}</span>
                <strong className="shift-label">{label}</strong>
                <span className="shift-note">{note}</span>
                {key==='assigned' && <div className="shift-event"><i/><b>INC-900009</b><span>Назначен координаторам</span></div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
