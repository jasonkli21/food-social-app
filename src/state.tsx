import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, Text, Modal } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Service } from './types';
import { apiURL, loadToken, onExpired, remote, setToken, storeToken } from './services/client';
import { demo } from './services/demo';
import { useNav } from './navigation';
import { colors, fonts } from './theme';

type Confirm = {
  title: string;
  body: string;
  action: string;
  dangerous?: boolean;
  resolve: (value: boolean) => void;
};
type AppState = {
  api: Service;
  isDemo: boolean;
  signedIn: boolean;
  initialized: boolean;
  revision: number;
  sessionGeneration: number;
  scopes: Record<string, number>;
  invalidate: (...keys: string[]) => void;
  savedState: Record<string, boolean>;
  likedState: Record<string, boolean>;
  showSaved: (id: string, active: boolean) => void;
  showLiked: (id: string, active: boolean) => void;
  login: (token: string | null) => Promise<void>;
  toast: (text: string) => void;
  confirm: (title: string, body: string, action: string, dangerous?: boolean) => Promise<boolean>;
};

const context = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const isDemo = !apiURL;
  const insets = useSafeAreaInsets();
  const [initialized, setInitialized] = useState(isDemo);
  const [token, changeToken] = useState<string | null>(null);
  const [revision, revise] = useState(0);
  const [sessionGeneration, setGeneration] = useState(0);
  const [scopes, setScopes] = useState<Record<string, number>>({});
  const [savedState, setSavedState] = useState<Record<string, boolean>>({});
  const [likedState, setLikedState] = useState<Record<string, boolean>>({});
  const authAttempt = useRef(0);
  const storageQueue = useRef<Promise<void>>(Promise.resolve());
  const [notice, setNotice] = useState<string>();
  const [dialog, setDialog] = useState<Confirm>();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const currentConfirm = useRef<Confirm | undefined>(undefined);

  const invalidate = useCallback((...keys: string[]) => {
    if (!keys.length) {
      setSavedState({});
      setLikedState({});
      revise(n => n + 1);
      return;
    }
    setScopes(previous => {
      const next = { ...previous };
      for (const key of keys) next[key] = (next[key] ?? 0) + 1;
      return next;
    });
  }, []);
  const showSaved = useCallback((id: string, active: boolean) => setSavedState(old => ({ ...old, [id]: active })), []);
  const showLiked = useCallback((id: string, active: boolean) => setLikedState(old => ({ ...old, [id]: active })), []);
  const toast = useCallback((message: string) => {
    clearTimeout(timer.current);
    setNotice(message);
    timer.current = setTimeout(() => setNotice(undefined), 3300);
  }, []);
  const confirm = useCallback<AppState['confirm']>((title, body, action, dangerous) => new Promise(resolve => {
    currentConfirm.current?.resolve(false);
    currentConfirm.current = { title, body, action, dangerous, resolve };
    setDialog(currentConfirm.current);
  }), []);
  function resolveConfirm(value: boolean) {
    currentConfirm.current?.resolve(value);
    currentConfirm.current = undefined;
    setDialog(undefined);
  }

  const login = useCallback(async (newToken: string | null) => {
    const generation = ++authAttempt.current;
    const commit = () => {
      setToken(newToken);
      changeToken(newToken);
      setGeneration(generation);
      setSavedState({});
      setLikedState({});
      setScopes({});
    };
    if (!newToken) commit();
    const write = storageQueue.current.then(() => storeToken(newToken));
    storageQueue.current = write.catch(() => undefined);
    await write;
    if (newToken && authAttempt.current === generation) commit();
  }, []);

  useEffect(() => {
    if (isDemo) return;
    let active = true;
    onExpired(() => {
      void login(null).catch(() => undefined);
      toast('Your session ended. Sign in again to continue.');
    });
    void loadToken().then(value => {
      if (active) {
        setToken(value);
        changeToken(value);
      }
    }).catch(() => {
      if (active) toast('Goodfork could not restore your session.');
    }).finally(() => {
      if (active) setInitialized(true);
    });
    return () => {
      active = false;
      onExpired();
    };
  }, [isDemo, login, toast]);

  useEffect(() => () => clearTimeout(timer.current), []);
  const state = useMemo<AppState>(() => ({ api: isDemo ? demo : remote, isDemo, signedIn: isDemo || !!token,
    initialized, revision, sessionGeneration, scopes, invalidate, savedState, likedState, showSaved, showLiked, login, toast, confirm,
  }), [isDemo, token, initialized, revision, sessionGeneration, scopes, invalidate, savedState, likedState, showSaved, showLiked, login, toast, confirm]);

  return (
    <context.Provider value={state}>
      {children}
      {notice && (
        <View pointerEvents="none" style={[styles.toastPosition, { bottom: insets.bottom + 76 }]}>
          <Text accessibilityLiveRegion="polite" style={styles.toast}>{notice}</Text>
        </View>
      )}
      {dialog && (
        <Modal visible transparent animationType="fade" onRequestClose={() => resolveConfirm(false)}>
          <View style={styles.scrim}>
            <View accessibilityViewIsModal style={styles.dialog}>
              <Text accessibilityRole="header" style={styles.title}>{dialog.title}</Text>
              <Text style={styles.body}>{dialog.body}</Text>
              <View style={styles.options}>
                <Pressable accessibilityRole="button" onPress={() => resolveConfirm(false)} style={styles.cancel}>
                  <Text style={styles.cancelText}>Cancel</Text>
                </Pressable>
                <Pressable accessibilityRole="button" onPress={() => resolveConfirm(true)}
                  style={[styles.confirm, dialog.dangerous && { backgroundColor: colors.danger }]}>
                  <Text style={[styles.cancelText, dialog.dangerous && { color: 'white' }]}>{dialog.action}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      )}
    </context.Provider>
  );
}

export function useApp() {
  const value = useContext(context);
  if (!value) throw new Error('Goodfork app state is missing');
  return value;
}

export function useMember() {
  const { signedIn } = useApp();
  const nav = useNav();
  return () => {
    if (!signedIn) nav.navigate('Auth');
    return signedIn;
  };
}

const styles = StyleSheet.create({
  toastPosition: { position: 'absolute', left: 16, right: 16, alignItems: 'center', zIndex: 30 },
  toast: { maxWidth: 440, paddingHorizontal: 18, paddingVertical: 13, borderRadius: 16, overflow: 'hidden',
    backgroundColor: colors.ink, color: colors.white, fontFamily: fonts.semibold, fontSize: 14, textAlign: 'center' },
  scrim: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(30,24,17,0.60)', padding: 24 },
  dialog: { width: '100%', maxWidth: 430, borderRadius: 24, padding: 24, gap: 12, backgroundColor: colors.paper },
  title: { fontFamily: fonts.display, fontSize: 35, color: colors.ink },
  body: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, color: colors.muted },
  options: { flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  cancel: { minHeight: 46, paddingHorizontal: 17, justifyContent: 'center' },
  confirm: { minHeight: 46, backgroundColor: colors.gold, paddingHorizontal: 17, borderRadius: 23, justifyContent: 'center' },
  cancelText: { color: colors.ink, fontFamily: fonts.bold, fontSize: 14 },
});
