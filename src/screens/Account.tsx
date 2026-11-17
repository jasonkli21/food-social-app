import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { ArrowUpRight, Check, Clipboard, Flag, KeyRound, LogOut, Mail, RotateCcw, Shield, ShieldBan, Trash2 } from 'lucide-react-native';
import * as Copy from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from 'expo-crypto';
import { apiURL, ServiceError } from '../services/client';
import type { BrowserTarget } from '../types';
import { useNav, type Props } from '../navigation';
import { useApp, useMember } from '../state';
import { resetDemo } from '../services/demo';
import { useData, useTask } from '../hooks';
import { colors } from '../theme';
import { openLink } from '../links';
import { Brand, Button, Chip, Field, Issue, Screen, Segment, T, Tap } from '../components/ui';

WebBrowser.maybeCompleteAuthSession();

type AuthMode = 'login' | 'register' | 'recover';

async function googleChallenge() {
  const target: BrowserTarget = Platform.OS === 'web' ? 'web' : 'native';
  const verifier = randomUUID() + randomUUID();
  const challenge = await digestStringAsync(CryptoDigestAlgorithm.SHA256, verifier);
  const callback = target === 'web' ? window.location.origin + '/auth/google' : 'goodfork://auth/google';
  return { target, verifier, challenge, callback };
}

async function openGoogle(authorizationURL: string, callback: string) {
  const reply = await WebBrowser.openAuthSessionAsync(authorizationURL, callback);
  if (reply.type !== 'success') return null;
  const returned = new URL(reply.url);
  if (returned.protocol + '//' + returned.host + returned.pathname !== callback) {
    throw new Error('Google returned an unexpected sign-in address.');
  }
  const problem = returned.searchParams.get('error');
  if (problem === 'canceled') return null;
  if (problem === 'account_exists') throw new Error('Sign in with your Goodfork email and password, then connect Google in Settings.');
  if (problem === 'link_mismatch') throw new Error('Choose the Google address you verified on this Goodfork account.');
  const code = returned.searchParams.get('code');
  if (!code) throw new Error('Google sign-in did not complete. Try again.');
  return code;
}

export function AuthScreen({ navigation: nav }: Props<'Auth'>) {
  const { api, login, toast } = useApp();
  const config = useData('config', signal => api.config(signal));
  const task = useTask();
  const links = useTask();
  const resend = useTask();
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [handle, setHandle] = useState('');
  const [registration, setRegistration] = useState('');
  const [verificationCode, setVerification] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [recoveryCode, setRecovery] = useState('');
  const [newRecovery, setNewRecovery] = useState('');
  const [agreed, setAgreed] = useState(false);

  function select(value: AuthMode) {
    task.setError('');
    setMode(value);
  }
  const finish = () => nav.canGoBack() ? nav.goBack() : nav.navigate('Main', { tab: 'you' });

  if (newRecovery) return <Screen title="Account recovery" close>
    <View style={styles.accountIcon}><KeyRound color={colors.green} size={30} /></View>
    <T kind="title">Save your recovery code</T>
    <T color={colors.muted}>Keep this code in a password manager. You’ll need it if you forget your password.</T>
    <View style={styles.code}><T selectable kind="strong" color={colors.green}>{newRecovery}</T></View>
    <Button title="Copy recovery code" mode="line" icon={Clipboard} onPress={() =>
      void links.run(async () => { await Copy.setStringAsync(newRecovery); toast('Recovery code copied'); })} />
    <Button title="Continue to Goodfork" onPress={finish} />
  </Screen>;

  if (registration) return <Screen title="Verify email" close form>
    <View style={styles.accountIcon}><Mail color={colors.green} size={28} /></View>
    <T kind="title">Check your inbox</T>
    <T color={colors.muted}>Enter the 8-digit code sent to {email.trim()}.</T>
    <Field label="Verification code" autoComplete="one-time-code" keyboardType="number-pad"
      value={verificationCode} onChangeText={setVerification} maxLength={8} />
    {task.error && <Issue message={task.error} />}
    <Button title="Verify email" busy={task.busy} disabled={!/^\d{8}$/.test(verificationCode)} onPress={() => void task.run(async () => {
      const result = await api.verifyEmail(registration, verificationCode);
      await login(result.token);
      setPassword('');
      setNewRecovery(result.recoveryCode ?? '');
    }, true)} />
    {resend.error && <Issue message={resend.error} />}
    <Button title="Resend code" mode="line" busy={resend.busy} disabled={task.busy} onPress={() => void resend.run(async () => {
      try {
        await api.resendVerification(registration);
      } catch (error) {
        if (error instanceof ServiceError && error.retryAfter) throw new Error('Try sending a new code in ' + error.retryAfter + ' seconds.');
        throw error;
      }
      setVerification('');
      task.setError('');
      toast('A new verification code was sent');
    }, true)} />
    <Button title="Back to signup" mode="line" onPress={() => {
      resend.setError('');
      task.setError('');
      setRegistration('');
      setVerification('');
    }} />
  </Screen>;

  const google = () => void task.run(async () => {
    const flow = await googleChallenge();
    const start = apiURL + '/v1/auth/google/start?target=' + flow.target + '&agreed=1&challenge=' + flow.challenge;
    const code = await openGoogle(start, flow.callback);
    if (!code) return;
    const result = await api.finishGoogle(code, flow.verifier);
    await login(result.token);
    finish();
  }, true);

  return <Screen title="Goodfork account" close form>
    <View style={styles.authBrand}><Brand /></View>
    <T kind="display">{mode === 'login' ? 'Welcome back' : mode === 'register' ? 'Pull up a chair' : 'Recover your account'}</T>
    {mode !== 'recover' && <Segment<AuthMode> value={mode} onChange={select}
      options={[{ key: 'login', title: 'Sign in' }, { key: 'register', title: 'Join Goodfork' }]} />}
    {mode === 'register' && <Field label="Display name" value={name} onChangeText={setName} autoComplete="name" maxLength={48} />}
    <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false}
      keyboardType="email-address" autoComplete="email" maxLength={254} />
    {mode === 'register' && <Field label="Public handle" value={handle} onChangeText={setHandle} autoCapitalize="none" autoCorrect={false}
      maxLength={25} hint="Your profile uses this handle." />}
    {mode === 'recover' && <Field label="Recovery code" value={recoveryCode} onChangeText={setRecovery} autoCapitalize="none" autoCorrect={false} maxLength={32} />}
    <Field label={mode === 'recover' ? 'New password' : 'Password'} value={password} onChangeText={setPassword} autoCapitalize="none" autoCorrect={false}
      autoComplete={mode === 'login' ? 'current-password' : 'new-password'} secureTextEntry maxLength={128}
      hint={mode !== 'login' ? 'Use at least 12 characters.' : undefined} />
    {mode === 'register' && <>
      <Tap accessibilityRole="checkbox" accessibilityState={{ checked: agreed }} onPress={() => setAgreed(value => !value)} style={styles.accept}>
        <View style={[styles.checkbox, agreed && styles.checked]}>{agreed && <Check color={colors.white} size={16} />}</View>
        <T style={{ flex: 1 }}>I agree to the terms and community guidelines.</T>
      </Tap>
      <T kind="small" color={colors.muted}>Share first-hand experiences and respect other diners’ privacy.</T>
      <View style={styles.tags}>
        {!!config.data?.termsURL && <Chip title="Terms and guidelines" onPress={() => void links.run(() => openLink(config.data!.termsURL))} />}
        {!!config.data?.privacyURL && <Chip title="Privacy policy" onPress={() => void links.run(() => openLink(config.data!.privacyURL))} />}
      </View>
    </>}
    {task.error && <Issue message={task.error} />}
    <Button title={mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Reset password'} busy={task.busy}
      disabled={!email.trim() || !password || (mode === 'register' && (!agreed || !name.trim() || !handle.trim() || password.length < 12)) || (mode === 'recover' && !recoveryCode.trim())}
      onPress={() => void task.run(async () => {
        if (mode === 'register') {
          const result = await api.register({ email, handle, name, password, agreed });
          setRegistration(result.registrationId);
          return;
        }
        const result = await api.authenticate(mode, { email, password, ...(mode === 'recover' ? { recoveryCode } : {}) });
        await login(result.token);
        setPassword('');
        if (result.recoveryCode) setNewRecovery(result.recoveryCode);
        else finish();
      }, true)} />
    {mode === 'login' && config.data?.googleEnabled && <>
      <Button title="Continue with Google" mode="line" busy={task.busy} onPress={google} />
      <View style={styles.tags}>
        <T kind="small" color={colors.muted}>By continuing with Google, you agree to Goodfork's terms.</T>
        {!!config.data.termsURL && <Chip title="Terms and guidelines" onPress={() => void links.run(() => openLink(config.data!.termsURL))} />}
        {!!config.data.privacyURL && <Chip title="Privacy policy" onPress={() => void links.run(() => openLink(config.data!.privacyURL))} />}
      </View>
    </>}
    {mode === 'login' ? <Button title="Forgot password?" mode="line" onPress={() => select('recover')} />
      : mode === 'recover' ? <Button title="Back to sign in" mode="line" onPress={() => select('login')} /> : null}
  </Screen>;
}

export function SettingsScreen() {
  const nav = useNav();
  const { api, isDemo, signedIn, login, confirm, invalidate, toast } = useApp();
  const config = useData('config', signal => api.config(signal), !isDemo);
  const account = useData('profile:settings', signal => api.me(signal), !isDemo && signedIn);
  const passwordAccount = account.data?.hasPassword !== false;
  const action = useTask();
  const deleting = useTask();
  const [showDelete, setShowDelete] = useState(false);
  const [password, setPassword] = useState('');
  const [showLink, setShowLink] = useState(false);
  const [linkPassword, setLinkPassword] = useState('');
  const [linkFlow, setLinkFlow] = useState<{ url: string; callback: string; verifier: string }>();
  const linking = useTask();

  function signOut(signInAgain = false) {
    void action.run(async () => {
      const revoked = api.logout().then(() => true, () => false);
      try {
        await login(null);
      } catch {
        toast('Signed out for this session. This device could not clear the stored sign-in.');
      }
      if (signInAgain) nav.navigate('Auth');
      if (!await revoked) toast('Signed out on this device. The server session could not be revoked.');
    });
  }

  return <Screen title="Settings" form>
    {isDemo && <>
      <View style={styles.note}><T kind="heading">Sample mode</T><T color={colors.muted}>The restaurants and diners here are fictional. Changes stay on this device.</T></View>
      <Button title="Reset sample data" mode="line" icon={RotateCcw} busy={action.busy} onPress={() =>
        void action.run(async () => {
          if (await confirm('Reset sample data?', 'Reviews, saves, ranking changes, and uploads you added in sample mode will be erased.', 'Reset', true)) {
            await resetDemo();
            invalidate();
            toast('Sample data reset');
            nav.goBack();
          }
        })} />
    </>}
    {signedIn && <Button icon={ShieldBan} title="Blocked diners" mode="line" onPress={() => nav.push('Blocked')} />}
    {config.error && <Issue message={config.error} retry={config.reload} />}
    {!!config.data?.privacyURL && <Button icon={Shield} title="Privacy policy" mode="line" onPress={() => void action.run(() => openLink(config.data!.privacyURL))} />}
    {!!config.data?.termsURL && <Button icon={ArrowUpRight} title="Terms and guidelines" mode="line" onPress={() => void action.run(() => openLink(config.data!.termsURL))} />}
    {!!config.data?.supportEmail && <Button icon={Mail} title="Contact Goodfork" mode="line" onPress={() => void action.run(() => openLink('mailto:' + config.data!.supportEmail))} />}
    {!isDemo && signedIn && <>
      {config.data?.googleEnabled && account.data && <View style={styles.note}>
        <T kind="strong">Google sign-in</T>
        {account.data.googleLinked ? <T color={colors.muted}>Connected to your Goodfork account</T> :
          account.data.hasPassword && !showLink ? <Button mode="line" title="Connect Google" onPress={() => setShowLink(true)} /> :
          account.data.hasPassword ? <>
            <T color={colors.muted}>Connect the Google address you verified on this account.</T>
            {linkFlow ? <Button title="Continue in Google" busy={linking.busy} onPress={() => void linking.run(async () => {
              const code = await openGoogle(linkFlow.url, linkFlow.callback);
              setLinkFlow(undefined);
              if (!code) return;
              await api.finishGoogleLink(code, linkFlow.verifier);
              invalidate('profile:settings');
              setShowLink(false);
              toast('Google connected');
            }, true)} /> : <>
              <Field label="Goodfork password" value={linkPassword} onChangeText={setLinkPassword}
                secureTextEntry autoComplete="current-password" maxLength={128} />
              <Button title="Verify password" disabled={!linkPassword} busy={linking.busy} onPress={() => void linking.run(async () => {
                const flow = await googleChallenge();
                const start = await api.startGoogleLink(linkPassword, flow.target, flow.challenge);
                const url = new URL(start.authorizationURL);
                if (url.origin !== 'https://accounts.google.com') throw new Error('An unexpected Google sign-in address was returned.');
                setLinkFlow({ url: start.authorizationURL, callback: flow.callback, verifier: flow.verifier });
                setLinkPassword('');
              }, true)} />
            </>}
            {linking.error && <Issue message={linking.error} />}
            <Button title="Cancel connection" mode="line" onPress={() => {
              setShowLink(false);
              setLinkPassword('');
              setLinkFlow(undefined);
              linking.setError('');
            }} />
          </> : null}
      </View>}
      <Button icon={LogOut} title="Sign out" mode="line" busy={action.busy} onPress={() => signOut()} />
      {!showDelete ? <Button title="Delete account" mode="danger" icon={Trash2} disabled={!account.data} onPress={() => setShowDelete(true)} /> :
        <View style={styles.deleteBox}>
          <T kind="heading" color={colors.danger}>Delete your account</T>
          <T color={colors.muted}>Your profile, reviews, and comments will be permanently removed.</T>
          {passwordAccount ? <Field label="Confirm your password" secureTextEntry autoComplete="current-password" value={password} onChangeText={setPassword} maxLength={128} />
            : <T color={colors.muted}>You can delete your account within ten minutes of signing in with Google.</T>}
          {deleting.error && <Issue message={deleting.error} />}
          {!passwordAccount && deleting.error && <Button title="Sign in again with Google" mode="line" onPress={() => signOut(true)} />}
          <Button icon={Trash2} title="Permanently delete" mode="danger" disabled={passwordAccount && !password} busy={deleting.busy} onPress={() =>
            void deleting.run(async () => {
              if (await confirm('Permanently delete your account?', 'This removes your posts, saves, and activity.', 'Delete account', true)) {
                await api.deleteAccount(password);
                await login(null);
                toast('Your account has been deleted');
              }
            }, true)} />
          <Button mode="line" title="Keep my account" onPress={() => { setShowDelete(false); setPassword(''); }} />
        </View>}
    </>}
  </Screen>;
}

export function ReportScreen({ navigation: nav, route }: Props<'Report'>) {
  const { kind, id, revision } = route.params;
  const { api, toast, isDemo } = useApp();
  const member = useMember();
  const task = useTask();
  const [reason, setReason] = useState('');
  const [detail, setDetail] = useState('');
  const labels = { post: 'review', comment: 'comment', person: 'diner', place: 'restaurant', reply: 'restaurant response' };
  const choices = kind === 'place' ? ['Wrong location or details', 'Duplicate restaurant', 'Closed', 'Other']
    : ['Spam or fake information', 'Harassment or hate', 'Inappropriate content', 'Other'];
  return <Screen title={'Report ' + labels[kind]} close form>
    <T kind="title">What happened?</T>
    <T color={colors.muted}>{isDemo ? 'Practice submitting a report in sample mode.' : 'Your report goes to the moderation team.'}</T>
    <View style={styles.tags}>
      {choices.map(choice => <Chip key={choice} title={choice} active={reason === choice} onPress={() => setReason(choice)} />)}
    </View>
    <Field label="Details (optional)" placeholder="Add anything that would help us review it." multiline maxLength={230} value={detail} onChangeText={setDetail} />
    {task.error && <Issue message={task.error} />}
    <Button icon={Flag} title="Submit report" disabled={!reason} busy={task.busy} onPress={() => {
      if (member()) void task.run(async () => {
        await api.report(kind, id, reason + (detail.trim() ? ' — ' + detail.trim() : ''), revision);
        toast('Report submitted');
        nav.goBack();
      }, true);
    }} />
  </Screen>;
}

const styles = StyleSheet.create({
  authBrand: { marginTop: 6 },
  accept: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 45 },
  checkbox: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center', borderRadius: 6, borderWidth: 1, borderColor: '#9D9183', backgroundColor: colors.white },
  checked: { borderColor: colors.green, backgroundColor: colors.green },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  code: { padding: 18, borderRadius: 15, backgroundColor: colors.greenWash, alignItems: 'center' },
  accountIcon: { padding: 13, borderRadius: 15, alignSelf: 'flex-start', backgroundColor: colors.greenWash },
  note: { padding: 13, backgroundColor: colors.greenWash, borderRadius: 16, gap: 6 },
  deleteBox: { gap: 11, padding: 14, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 16 },
});
