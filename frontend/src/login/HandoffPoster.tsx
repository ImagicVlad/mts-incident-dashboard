import './handoff.css';

export default function HandoffPoster() {
  return (
    <section className="auth-art handoff-poster" aria-labelledby="handoff-title">
      <div className="handoff-mast">
        <img src="/mts-logo.svg" width="36" height="36" alt="МТС" />
        <span>Центр координации</span>
      </div>
      <h2 className="handoff-title" id="handoff-title">Передача<br />инцидента</h2>
      <figure className="handoff-book" aria-labelledby="handoff-subject">
        <div className="handoff-paper">
          <div className="handoff-caption">
            <span>Учебный пример</span>
            <span>DEMO-2048</span>
          </div>
          <p className="handoff-subject" id="handoff-subject">Задержка платежей</p>
          <div className="handoff-journey" aria-hidden="true">
            <i className="handoff-start" />
            <span className="handoff-travel"><i className="handoff-ticket">→</i></span>
            <i className="handoff-end" />
          </div>
          <dl className="handoff-roles">
            <div><dt>Передаёт</dt><dd>Координатор</dd></div>
            <div><dt>Принимает</dt><dd>Команда биллинга</dd></div>
          </dl>
        </div>
      </figure>
    </section>
  );
}
