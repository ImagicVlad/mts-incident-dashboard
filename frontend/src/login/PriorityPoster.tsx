import './priority.css';

// Seven rows of lamps per character, like a station departure board.
const glyphs: Record<string, string[]> = {
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  ':': ['0', '0', '1', '0', '1', '0', '0'],
};

function DeadlineDisplay() {
  const characters = [
    { value: '1', x: 0 }, { value: '4', x: 6 }, { value: ':', x: 12 },
    { value: '4', x: 14 }, { value: '8', x: 20 },
  ];
  return <svg className="priority-clock" role="img" aria-label="14 часов 48 минут" viewBox="0 0 25 7">
    <defs>
      <pattern id="priority-lamps" width="1" height="1" patternUnits="userSpaceOnUse">
        <circle cx=".5" cy=".5" r=".405" fill="#393936"/>
      </pattern>
    </defs>
    <rect width="25" height="7" fill="url(#priority-lamps)"/>
    {characters.map(({value, x}) => (
      <g key={x} fill="currentColor" transform={`translate(${x} 0)`}>
        {glyphs[value].flatMap((row, y) => [...row].map((lamp, col) =>
          lamp === '1' && <circle key={y * 5 + col} cx={col + .5} cy={y + .5} r=".405"/>
        ))}
      </g>
    ))}
  </svg>;
}

const queue = [
  { title: 'Не проходят платежи', time: '14:48', critical: true },
  { title: 'Долго загружается кабинет', time: '15:10', critical: false },
  { title: 'Письма приходят с задержкой', time: '16:25', critical: false },
];

export default function PriorityPoster() {
  return <section className="auth-art priority-poster" aria-labelledby="priority-heading">
    <div className="priority-brand">
      <img src="/mts-logo.svg" width="32" height="32" alt="МТС"/>
      <span>Пульт координатора</span>
      <small>Учебный пример</small>
    </div>
    <div className="priority-hero">
      <h2 id="priority-heading">Приоритет смены</h2>
      <figure className="priority-readout">
        <figcaption><span>Срок критического инцидента</span><abbr title="Московское время">МСК</abbr></figcaption>
        <DeadlineDisplay/>
      </figure>
    </div>
    <div className="priority-inbox">
      <div className="priority-columns"><span>Очередь инцидентов</span><span>Срок</span></div>
      <ol className="priority-queue">
        {queue.map(({title, time, critical}) => <li key={title} className={'priority-row' + (critical ? ' priority-first' : '')}>
          <span className="priority-marker" aria-hidden="true"/>
          <span className="priority-issue">{title}{critical && <span className="priority-level">Критический</span>}</span>
          <time dateTime={time}>{time}</time>
        </li>)}
      </ol>
    </div>
  </section>;
}
