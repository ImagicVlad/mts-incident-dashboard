import './workspace-identity.css';

export default function WorkspaceIdentity() {
  return (
    <section className="auth-art workspace-identity" aria-labelledby="workspace-heading">
      <div className="workspace-brand">
        <img src="/mts-logo.svg" width="40" height="40" alt="МТС"/>
        <span>Управление инцидентами</span>
      </div>

      <div className="workspace-introduction">
        <h2 id="workspace-heading" aria-label="Пульт координатора">
          <span className="workspace-line"><span>Пульт</span></span>
          <span className="workspace-line"><span>координатора</span></span>
        </h2>
        <p>Следите за сроками и передавайте инциденты ответственным командам.</p>
      </div>

      <svg className="workspace-routes" viewBox="0 0 640 216" fill="none" aria-hidden="true"
        preserveAspectRatio="xMidYMid slice" focusable="false">
        <defs>
          <path id="workspace-inbound" pathLength="100" d="M-160 38H130Q143 38 153 48L207 102Q217 112 232 112H318"/>
          <path id="workspace-outbound" pathLength="100" d="M318 112H394Q408 112 418 102L468 52Q478 42 492 42H800"/>
        </defs>
        <g className="workspace-rails">
          <use href="#workspace-inbound"/><use href="#workspace-outbound"/>
          <path d="M-160 112H800"/>
          <path d="M-160 183H175Q189 183 199 173L250 122Q260 112 274 112M363 112Q377 112 387 122L437 172Q447 182 461 182H800"/>
        </g>
        <g className="workspace-selected">
          <use href="#workspace-inbound"/><use href="#workspace-outbound"/>
        </g>
        <g className="workspace-packets">
          <use className="workspace-arrive" href="#workspace-inbound"/>
          <use className="workspace-leave" href="#workspace-outbound"/>
        </g>
        <g transform="translate(318 112)">
          <circle className="workspace-halo" r="16"/>
          <circle className="workspace-junction" r="6"/>
          <circle className="workspace-core" r="2"/>
        </g>
      </svg>
    </section>
  );
}
