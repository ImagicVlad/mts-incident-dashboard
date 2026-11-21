import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Minus, MoveDiagonal2, Sparkles, Square, X } from 'lucide-react';

type Size = { width: number; height: number };
type Point = { left: number; top: number };
type Rect = Point & Size;
type Gesture = { kind: 'move' | 'resize'; id: number; x: number; y: number; start: Rect };

function viewport(): Size {
  return {
    width: document.documentElement.clientWidth,
    height: Math.min(document.documentElement.clientHeight, window.visualViewport?.height ?? window.innerHeight),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function fit(rect: Rect, screen: Size): Rect {
  const width = clamp(rect.width, 340, screen.width);
  const height = clamp(rect.height, 400, screen.height);
  return {width, height, left: clamp(rect.left, 0, screen.width - width), top: clamp(rect.top, 0, screen.height - height)};
}

function bottomRight(size: Size, screen: Size): Rect {
  const rect = fit({...size, left: 0, top: 0}, screen);
  return {...rect, left: Math.max(0, screen.width - rect.width - 20), top: Math.max(0, screen.height - rect.height - 20)};
}

function WindowButton({label, onClick, children}: {label: string; onClick: () => void; children: ReactNode}) {
  return <button type="button" aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

export function ChatWindow({dock, children}: {dock: HTMLElement | null; children: ReactNode}) {
  // React keeps the portal subtree mounted when the same host moves between parents.
  const [host] = useState(() => {
    const element = document.createElement('div');
    element.className = 'chat-host';
    return element;
  });
  const panel = useRef<HTMLElement>(null);
  const historyOffset = useRef(0);
  const gesture = useRef<Gesture | null>(null);
  const [normal, setNormal] = useState<Rect | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [mini, setMini] = useState<Point | null>(null);
  const [screen, setScreen] = useState(viewport);
  const [dockedSize, setDockedSize] = useState<Size>({width: 400, height: 480});
  const [closedAway, setClosedAway] = useState(false);
  const hidden = !dock && closedAway;
  const floating = !dock || (normal !== null && !closedAway);
  const mode = !floating ? 'docked' : mini ? 'minimized' : maximized ? 'maximized' : 'floating';
  const bounds = normal ? fit(normal, screen) : bottomRight(dockedSize, screen);
  const miniWidth = Math.min(224, screen.width), miniHeight = Math.min(48, screen.height);

  const parent = floating ? document.body : dock;
  useLayoutEffect(() => {
    if (!parent || parent === host.parentNode) return;
    const log = host.querySelector<HTMLElement>('[role="log"]');
    const offset = log?.clientHeight ? log.scrollTop : historyOffset.current;
    parent.appendChild(host);
    if (log) log.scrollTop = offset;
  }, [host, parent]);
  useLayoutEffect(() => () => host.remove(), [host]);

  useLayoutEffect(() => {
    if (floating || !panel.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const {inlineSize: width, blockSize: height} = entry.borderBoxSize[0];
      if (width && height) setDockedSize({width, height});
    });
    observer.observe(panel.current, {box: 'border-box'});
    return () => observer.disconnect();
  }, [floating]);

  useLayoutEffect(() => {
    if (!floating) return;
    const update = () => setScreen(viewport());
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, [floating]);

  function detach() {
    if (!panel.current) return;
    const {width, height} = panel.current.getBoundingClientRect();
    const available = viewport();
    setScreen(available);
    setClosedAway(false);
    setNormal(bottomRight({width, height}, available));
  }

  function close() {
    setNormal(dock ? null : bounds);
    setClosedAway(!dock);
    setMini(null);
    setMaximized(false);
    gesture.current = null;
  }

  function start(event: PointerEvent<HTMLElement>, kind: Gesture['kind']) {
    if (!floating || mode === 'maximized' || !event.isPrimary || event.button !== 0 || !panel.current) return;
    if (kind === 'move' && (event.target as Element).closest('button')) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {kind, id: event.pointerId, x: event.clientX, y: event.clientY,
      start: panel.current.getBoundingClientRect()};
  }

  function resize(start: Rect, dx: number, dy: number) {
    setNormal({left: start.left, top: start.top,
      width: clamp(start.width + dx, 340, screen.width - start.left),
      height: clamp(start.height + dy, 400, screen.height - start.top)});
  }

  function move(event: PointerEvent<HTMLElement>) {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    const dx = event.clientX - active.x, dy = event.clientY - active.y;
    const {left, top, width, height} = active.start;
    if (active.kind === 'resize') return resize(active.start, dx, dy);
    const position = {left: clamp(left + dx, 0, screen.width - width), top: clamp(top + dy, 0, screen.height - height)};
    if (mini) setMini(position);
    else setNormal({...position, width, height});
  }

  const stop = (event: PointerEvent<HTMLElement>) => {
    if (gesture.current?.id === event.pointerId) gesture.current = null;
  };
  let style: CSSProperties | undefined;
  if (mini) style = {width: miniWidth, height: miniHeight,
    left: clamp(mini.left, 0, screen.width - miniWidth), top: clamp(mini.top, 0, screen.height - miniHeight)};
  else if (maximized) style = {left: 0, top: 0, ...screen};
  else if (floating) style = bounds;

  return createPortal(<>
    {hidden && <button type="button" className="chat-stars chat-launcher" aria-label="Открыть ИИ-чат" title="Открыть ИИ-чат"
      onClick={() => setClosedAway(false)}><Sparkles size={21}/></button>}
    <section ref={panel} hidden={hidden} className={'incident-chat' + (floating ? ' chat-floating' : '')}
    data-mode={mode} style={style} aria-labelledby="chat-title"
    onScrollCapture={event => {
      const target = event.target as HTMLElement;
      if (target.getAttribute('role') === 'log' && target.clientHeight) historyOffset.current = target.scrollTop;
    }}
    onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} onLostPointerCapture={stop}>
    <header className="chat-titlebar" onPointerDown={e => start(e, 'move')}>
      {floating ? <span className="chat-stars" aria-hidden="true"><Sparkles size={17}/></span> :
        <button className="chat-stars" type="button" aria-label="Открепить ИИ-чат" title="Открепить ИИ-чат" onClick={detach}><Sparkles size={17}/></button>}
      <h2 id="chat-title">ИИ-чат</h2>
      {floating && <div className="chat-controls">
        {mini ? <WindowButton label="Восстановить чат" onClick={() => setMini(null)}><Copy/></WindowButton> : <>
          <WindowButton label="Свернуть чат" onClick={() => {
            setNormal(normal ?? bounds);
            setMini({left: screen.width - miniWidth - 20, top: screen.height - miniHeight - 20});
          }}><Minus/></WindowButton>
          <WindowButton label={maximized ? 'Восстановить размер' : 'Развернуть чат'} onClick={() => {
            setNormal(normal ?? bounds);
            setMaximized(!maximized);
          }}>{maximized ? <Copy/> : <Square/>}</WindowButton>
        </>}
        <WindowButton label={dock ? 'Закрыть окно и вернуть чат на дашборд' : 'Закрыть окно чата'} onClick={close}><X/></WindowButton>
      </div>}
    </header>
    {children}
    {mode === 'floating' && <button type="button" className="chat-resize" aria-label="Изменить размер окна"
      title="Изменить размер окна" onPointerDown={e => start(e, 'resize')}
      onKeyDown={e => {
        const delta: Record<string, [number, number]> = {ArrowRight: [16, 0], ArrowLeft: [-16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16]};
        if (delta[e.key]) { e.preventDefault(); resize(bounds, ...delta[e.key]); }
      }}><MoveDiagonal2 size={13}/></button>}
  </section></>, host);
}
