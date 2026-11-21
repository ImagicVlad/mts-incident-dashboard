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
  return <><header className="topbar"><div className="bar-inner"><img src="/mts-logo.svg" width="40" height="40" alt="МТС"/><span className="bar-rule"/><span className="app-name">Пульт координатора</span></div></header>
    <main className="auth-layout">
      <section className="auth-art" aria-label="Мониторинг инцидентов"><div className="art-heading"><p className="eyebrow"><span className="signal red-dot"/> Центр координации</p><h2>Пульт<br/>координатора</h2></div>
        <div className="radar" aria-hidden="true"><div className="radar-glow"/><div className="radar-orbit"/>{['one','two','three','four'].map(n => <b key={n} className={'blip blip-' + n}/>)}</div>
        <div className="art-footer"><span><i className="signal red-dot"/> Мониторинг инцидентов</span><strong>24/7</strong></div></section>
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
    </main></>;
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
