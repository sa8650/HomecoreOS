import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, UNAUTHORIZED_EVENT } from './api';

export interface Session {
  profile: any | null;
  tenant: any | null;
  role: string;
  permissions: string[];
  platform_admin: boolean;
  email: string;
  expires_at: string | null;
}

interface AuthValue extends Session {
  loading: boolean;
  signedIn: boolean;
  signIn(email: string, password: string): Promise<void>;
  signUp(data: { email: string; password: string; full_name: string; home_name: string }): Promise<string[]>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
  can(permission: string): boolean;
  toast(message: string, kind?: 'ok' | 'error'): void;
}

const Ctx = createContext<AuthValue | null>(null);
const EMPTY: Session = { profile: null, tenant: null, role: '', permissions: [], platform_admin: false, email: '', expires_at: null };

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session>(EMPTY);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toasts, setToasts] = useState<{ id: number; text: string; kind: string }[]>([]);

  const load = useCallback(async () => {
    try {
      const me = await api.get<any>('/api/auth/me');
      setSession({
        profile: me.profile,
        tenant: me.context?.tenant || null,
        role: me.context?.role || '',
        permissions: me.context?.permissions || [],
        platform_admin: !!me.context?.platform_admin && !!me.session?.platform_admin,
        email: me.session?.email || me.profile?.email || '',
        expires_at: me.session?.expires_at || null,
      });
      setSignedIn(true);
    } catch {
      setSession(EMPTY);
      setSignedIn(false);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const off = () => { setSession(EMPTY); setSignedIn(false); };
    window.addEventListener(UNAUTHORIZED_EVENT, off);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, off);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    await api.post('/api/auth/login', { email, password });
    await load();
  }, [load]);
  const signUp = useCallback(async (data: any): Promise<string[]> => {
    const r = await api.post<any>('/api/auth/signup', data);
    return r.recovery_codes || [];
  }, []);
  const signOut = useCallback(async () => {
    try { await api.post('/api/auth/logout'); } catch { /* session already gone */ }
    setSession(EMPTY);
    setSignedIn(false);
  }, []);
  const can = useCallback((p: string) => session.role === 'owner' || session.permissions.includes(p), [session]);
  const toast = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const value = useMemo<AuthValue>(() => ({
    ...session, loading, signedIn, signIn, signUp, signOut, refresh: load, can, toast,
  }), [session, loading, signedIn, signIn, signUp, signOut, load, can, toast]);

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
