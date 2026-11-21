import './workspace-identity.css';

export default function WorkspaceIdentity() {
  return (
    <section className="auth-art workspace-identity" aria-labelledby="workspace-heading">
      <div className="workspace-brand">
        <img src="/mts-logo.svg" width="40" height="40" alt="МТС"/>
        <span>Управление инцидентами</span>
      </div>

      <div className="workspace-introduction">
        <h2 id="workspace-heading">Пульт<br/>координатора</h2>
        <p>Следите за сроками и передавайте инциденты ответственным командам.</p>
      </div>

      <svg className="workspace-routes" viewBox="0 0 640 218" fill="none" aria-hidden="true"
        preserveAspectRatio="none" focusable="false">
        <g className="workspace-route-lines">
          <path d="M-2 16H145Q161 16 172 27L244 99Q255 110 271 110H642"/>
          <path d="M-2 70H119Q135 70 146 81L173 108Q184 119 200 119H642"/>
          <path d="M-2 145H248Q264 145 275 134T302 123H642"/>
          <path d="M-2 208H200Q216 208 227 197L282 142Q293 131 309 131H642"/>
        </g>
        <path className="workspace-route-active" pathLength="100"
          d="M-2 70H119Q135 70 146 81L173 108Q184 119 200 119H642"/>
      </svg>
    </section>
  );
}
