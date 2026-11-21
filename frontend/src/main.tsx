import { createRoot } from 'react-dom/client';
import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, errorText, pathFor, type Account } from './api';
import './styles.css';

const client = new QueryClient({defaultOptions:{queries:{retry:false, refetchOnWindowFocus:false}}});
const Console = lazy(()=>import('./Console'));
const Dashboard = lazy(()=>import('./Dashboard').then(m=>({default:m.Dashboard})));
const Details = lazy(()=>import('./Details').then(m=>({default:m.Details})));
function useSession() {
  return useQuery({queryKey:['account'], staleTime:60_000, queryFn:async () => {
    try { return await api<Account>('auth/me'); }
    catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error; }
  }});
}
function SessionBoundary({loginPage=false}: {loginPage?:boolean}) {
  const {data:user,isPending,isError,refetch} = useSession();
  const cache = useQueryClient();
  const location = useLocation();
  useEffect(() => {
    const clear = () => {
      cache.removeQueries({queryKey:['live']});
      cache.setQueryData(['account'],null);
    };
    window.addEventListener('session-expired',clear);
    return () => window.removeEventListener('session-expired',clear);
  },[cache]);
  if (isPending) return <main className="container waiting" role="status">Проверяем сессию…</main>;
  if (isError) return <main className="container waiting"><h1>Сервер недоступен</h1><button className="button secondary" onClick={() => refetch()}>Повторить</button></main>;
  if (loginPage) {
    const from: unknown = location.state?.from;
    const target = typeof from === 'string' && /^\/(dashboard(?:$|[?#])|incidents\/)/.test(from) ? from : '/dashboard';
    return user ? <Navigate replace to={target}/> : <Login/>;
  }
  if (!user) return <Navigate replace to="/login" state={{from:location.pathname + location.search + location.hash}}/>;
  return <Console user={user}/>;
}
function Login() {
  const cache = useQueryClient();
  const [login,setLogin] = useState('coordinator.demo');
  const [password,setPassword] = useState('mts-demo-local');
  const [pending,setPending] = useState(false);
  const [error,setError] = useState('');
  useEffect(() => {document.title = 'Вход · Пульт координатора';},[]);
  return <main className="auth-layout">
      <section className="auth-art" aria-labelledby="poster-title">
        <div className="poster-imprint">
          <img src="/mts-logo.svg" width="36" height="36" alt="МТС"/>
          <span>Центр координации</span>
          <span className="poster-hours">24/7</span>
        </div>
        <h2 id="poster-title" className="poster-title"><span>Пульт</span> координатора</h2>
        <figure className="poster-figure">
          <div className="poster-frame">
            <img src="/shukhov-1940.webp" alt="Вид вверх сквозь стальные фермы Шуховской радиобашни"/>
            <div className="poster-ink" aria-hidden="true"/>
          </div>
          <figcaption className="poster-caption">
            <span>Шуховская башня, 1940</span>
            <small>В. Егоров / <a href="https://www.mos.ru/news/item/103930073/" target="_blank" rel="noreferrer">Mos.ru</a>
              {' · '}<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a></small>
          </figcaption>
        </figure>
      </section>
      <section className="auth-panel"><div className="auth-box"><p className="eyebrow">Доступ координатора</p><h1>Вход в пульт</h1>
        <p className="intro-note">Войдите под демонстрационной учётной записью.</p>
        <form onSubmit={async event => {
          event.preventDefault(); if (pending) return; setPending(true); setError('');
          try {const account = await api<Account>('auth/login',{login,password}); cache.setQueryData(['account'],account);}
          catch (e) {setError(errorText(e));} finally {setPending(false);}
        }}>
          <label>Логин<input name="login" autoComplete="username" value={login} onChange={e=>setLogin(e.target.value)} required/></label>
          <label>Пароль<input name="password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button primary" disabled={pending}>{pending ? 'Входим…' : 'Войти'}</button>
        </form></div></section>
    </main>;
}
function LegacyIncident() {
  const hash = useLocation().hash.slice(1);
  let id = hash;
  try {id = decodeURIComponent(hash);} catch { /* Already literal. */ }
  return <Navigate replace to={id ? pathFor(id) : '/dashboard'}/>;
}

createRoot(document.getElementById('root')!).render(<QueryClientProvider client={client}><BrowserRouter>
  <Suspense fallback={<main className="container waiting" role="status">Загружаем пульт…</main>}><Routes>
    <Route path="/login" element={<SessionBoundary loginPage/>}/>
    <Route element={<SessionBoundary/>}>
      <Route index element={<Navigate replace to="/dashboard"/>}/>
      <Route path="/dashboard" element={<Dashboard/>}/>
      <Route path="/incidents/:id" element={<Details/>}/>
      <Route path="*" element={<main className="container waiting"><h1>Страница не найдена</h1><Link className="button secondary" to="/dashboard">К дашборду</Link></main>}/>
    </Route>
    <Route path="/routes/access/login" element={<Navigate replace to="/login"/>}/>
    <Route path="/routes/acces/login" element={<Navigate replace to="/login"/>}/>
    <Route path="/routes/dashboard/overview" element={<Navigate replace to="/dashboard"/>}/>
    <Route path="/routes/itsm/incident" element={<LegacyIncident/>}/>
  </Routes></Suspense>
</BrowserRouter></QueryClientProvider>);
