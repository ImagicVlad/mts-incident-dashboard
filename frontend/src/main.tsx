import { createRoot } from 'react-dom/client';
import { lazy, Suspense, useEffect, useState } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, errorText, pathFor, type Account } from './api';
import './styles.css';
import HandoffPoster from './login/HandoffPoster';
import PriorityPoster from './login/PriorityPoster';
import WorkspaceIdentity from './login/WorkspaceIdentity';
import CompactLoginLayout from './login/CompactLoginLayout';

const loginPosters = {workspace: WorkspaceIdentity, handoff: HandoffPoster, priority: PriorityPoster};
type LoginVariant = keyof typeof loginPosters | 'compact';

function isLoginVariant(value: string | null): value is LoginVariant {
  return value === 'compact' || (value !== null && Object.hasOwn(loginPosters, value));
}

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
    const target = typeof from === 'string' && /^\/(dashboard\/?(?:$|[?#])|incidents\/|routes\/(dashboard\/overview|itsm\/incident)\/?(?:$|[?#]))/.test(from) ? from : '/dashboard';
    const variant = new URLSearchParams(location.search).get('variant');
    const preview = isLoginVariant(variant);
    if (user && !preview) return <Navigate replace to={target}/>;
    return <Login variant={preview ? variant : 'workspace'} destination={target}/>;
  }
  if (!user) return <Navigate replace to="/login" state={{from:location.pathname + location.search + location.hash}}/>;
  return <Console user={user}/>;
}
function Login({variant, destination}: {variant: LoginVariant; destination: string}) {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [login,setLogin] = useState('coordinator.demo');
  const [password,setPassword] = useState('mts-demo-local');
  const [showPassword,setShowPassword] = useState(false);
  const [pending,setPending] = useState(false);
  const [error,setError] = useState('');
  useEffect(() => {document.title = 'Вход · Пульт координатора';},[]);
  const form = <section className="auth-panel" aria-labelledby="login-title"><div className="auth-box">
        {variant !== 'workspace' && <p className="eyebrow">{variant === 'compact' ? 'Пульт координатора' : 'Доступ координатора'}</p>}
        <h1 id="login-title">Вход в пульт</h1>
        <p className="intro-note">Логин и пароль демоаккаунта уже заполнены.</p>
        <form onSubmit={async event => {
          event.preventDefault(); if (pending) return; setPending(true); setError('');
          try {const account = await api<Account>('auth/login',{login,password}); cache.setQueryData(['account'],account); navigate(destination,{replace:true});}
          catch (e) {setError(errorText(e));} finally {setPending(false);}
        }}>
          <label>Логин<input name="login" autoComplete="username" value={login} onChange={e=>setLogin(e.target.value)} required/></label>
          <div className="password-field">
            <label htmlFor="login-password">Пароль</label>
            <div className="password-control">
              <input id="login-password" name="password" type={showPassword ? 'text' : 'password'}
                autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/>
              <button type="button" className="password-toggle" aria-controls="login-password"
                aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'} onClick={()=>setShowPassword(!showPassword)}>
                {showPassword ? <EyeOff size={18} aria-hidden="true"/> : <Eye size={18} aria-hidden="true"/>}
              </button>
            </div>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="button primary" disabled={pending}>{pending ? 'Входим…' : 'Войти'}</button>
        </form></div></section>;
  if (variant === 'compact') return <CompactLoginLayout>{form}</CompactLoginLayout>;
  const Poster = loginPosters[variant];
  return <main className={`auth-layout login-${variant}`}><Poster/>{form}</main>;
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
      <Route path="/routes/dashboard/overview" element={<Navigate replace to="/dashboard"/>}/>
      <Route path="/routes/itsm/incident" element={<LegacyIncident/>}/>
      <Route path="*" element={<main className="container waiting"><h1>Страница не найдена</h1><Link className="button secondary" to="/dashboard">К дашборду</Link></main>}/>
    </Route>
    <Route path="/routes/access/login" element={<Navigate replace to="/login"/>}/>
    <Route path="/routes/acces/login" element={<Navigate replace to="/login"/>}/>
  </Routes></Suspense>
</BrowserRouter></QueryClientProvider>);
