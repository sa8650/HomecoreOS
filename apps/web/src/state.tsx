import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, getToken, setToken } from './api';

export interface Session {
  profile: any | null;
  tenant: any | null;
  role: string;
  permissions: string[];
  platform_admin: boolean;
}

interface AuthValue extends Session {
  loading: boolean;
  signedIn: boolean;
  signIn(email: string, password: string): Promise<void>;
  signUp(data: { email: string; password: string; full_name: string; home_name: string }): Promise<void>;
  signOut(): void;
  refresh(): Promise<void>;
  can(permission: string): boolean;
  toast(message: string, kind?: 'ok' | 'error'): void;
}

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setTok] = useState<string | null>(getToken());
  const [session, setSession] = useState<Session>({ profile: null, tenant: null, role: '', permissions: [], platform_admin: false });
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: string }[]>([]);

  const load = useCallback(async () => {
    if (!getToken()) { setSession({ profile: null, tenant: null, role: '', permissions: [], platform_admin: false }); setLoading(false); return; }
    try {
      const me = await api.get<any>('/api/auth/me');
      setSession({
        profile: me.profile,
        tenant: me.context?.tenant || null,
        role: me.context?.role || '',
        permissions: me.context?.permissions || [],
        platform_admin: !!me.context?.platform_admin,
      });
    } catch {
      setToken(null); setTok(null);
      setSession({ profile: null, tenant: null, role: '', permissions: [], platform_admin: false });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const signIn = useCallback(async (email: string, password: string) => {
    const r = await api.post<any>('/api/auth/login', { email, password });
    setToken(r.token); setTok(r.token); await load();
  }, [load]);
  const signUp = useCallback(async (data: any) => {
    const r = await api.post<any>('/api/auth/signup', data);
    setToken(r.token); setTok(r.token); await load();
  }, [load]);
  const signOut = useCallback(() => {
    setToken(null); setTok(null);
    setSession({ profile: null, tenant: null, role: '', permissions: [], platform_admin: false });
  }, []);
  const can = useCallback((p: string) => session.role === 'owner' || session.permissions.includes(p), [session]);
  const toast = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const value = useMemo<AuthValue>(() => ({
    ...session, loading, signedIn: !!token, signIn, signUp, signOut, refresh: load, can, toast,
  }), [session, loading, token, signIn, signUp, signOut, load, can, toast]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toast-host">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>{t.text}</div>)}
      </div>
    </Ctx.Provider>
  );
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside provider');
  return v;
}
