import type { ComponentType, ReactNode } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { PressableProps, StyleProp, TextInputProps, TextProps, TextStyle, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { LucideProps } from 'lucide-react-native';
import { ArrowLeft, ChevronRight, Utensils, X } from 'lucide-react-native';
import { colors, fonts } from '../theme';
import { useNav } from '../navigation';
import type { Person } from '../types';

export type Icon = ComponentType<LucideProps>;
type Type = 'display' | 'title' | 'heading' | 'section' | 'body' | 'strong' | 'label' | 'small';

export function T({ kind = 'body', color = colors.ink, style, ...props }: TextProps & { kind?: Type; color?: string }) {
  return <Text {...props} style={[type[kind], { color }, style]} />;
}

export function Tap({ style, ...props }: Omit<PressableProps, 'style'> & { style?: StyleProp<ViewStyle> }) {
  return <Pressable accessibilityRole="button" {...props} style={({ pressed }) => [style, pressed && { opacity: 0.68 }, props.disabled && { opacity: 0.55 }]} />;
}

export function IButton({ icon: Glyph, label, onPress, color = colors.ink, fill, style, active }: {
  icon: Icon; label: string; onPress: () => void; color?: string; fill?: string; style?: StyleProp<ViewStyle>; active?: boolean;
}) {
  return <Tap accessibilityLabel={label} accessibilityState={active === undefined ? undefined : { selected: active }} onPress={onPress} style={[ui.icon, style]}>
    <Glyph size={22} strokeWidth={1.85} color={color} fill={fill ?? 'none'} />
  </Tap>;
}

export function Button({ title, onPress, busy, disabled, icon: Glyph, mode = 'gold', style }: {
  title: string; onPress: () => void; busy?: boolean; disabled?: boolean; icon?: Icon;
  mode?: 'gold' | 'line' | 'dark' | 'danger'; style?: StyleProp<ViewStyle>;
}) {
  const foreground = mode === 'dark' || mode === 'danger' ? colors.white : colors.ink;
  return <Tap onPress={onPress} disabled={busy || disabled} accessibilityState={{ disabled: Boolean(disabled || busy), busy }}
    style={[ui.button, mode === 'line' && ui.lineButton, mode === 'dark' && ui.darkButton, mode === 'danger' && ui.dangerButton, style]}>
    {busy ? <ActivityIndicator color={foreground} /> : Glyph && <Glyph size={19} strokeWidth={2} color={foreground} />}
    <T kind="strong" color={foreground}>{title}</T>
  </Tap>;
}

export function Chip({ title, active, icon: Glyph, onPress }: { title: string; active?: boolean; icon?: Icon; onPress: () => void }) {
  return <Tap accessibilityState={{ selected: !!active }} onPress={onPress} style={[ui.chip, active && ui.activeChip]}>
    {Glyph && <Glyph size={16} strokeWidth={1.8} color={active ? colors.green : colors.muted} />}
    <T kind="label" color={active ? colors.green : colors.muted}>{title}</T>
  </Tap>;
}

export function Segment<K extends string>({ value, options, onChange }: {
  value: K; options: { key: K; title: string; icon?: Icon }[]; onChange: (kind: K) => void;
}) {
  return <View style={ui.segments}>
    {options.map(({ key, title, icon: Glyph }) => {
      const active = value === key;
      return <Tap key={key} accessibilityRole="tab" accessibilityState={{ selected: active }} onPress={() => onChange(key)} style={[ui.segment, active && ui.segmentActive]}>
        {Glyph && <Glyph size={16} strokeWidth={1.8} color={active ? colors.ink : colors.muted} />}
        <T kind="label" color={active ? colors.ink : colors.muted} style={ui.segmentLabel}>{title}</T>
      </Tap>;
    })}
  </View>;
}

export function Avatar({ person, size = 36 }: { person: Pick<Person, 'id' | 'name'>; size?: number }) {
  const pairs = [['#E8ECD9', '#334831'], ['#F1D4BC', '#6D3C27'], ['#F8DE9C', '#5F411A'], ['#DFE5D5', '#365339'], ['#ECDCF3', '#5C3E6B']];
  const index = Array.from(person.id).reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % pairs.length;
  const pair = pairs[index] ?? pairs[0]!;
  const initials = person.name.trim().split(/\s+/).slice(0, 2).map(n => Array.from(n)[0]).join('').toUpperCase();
  return <View style={[ui.avatar, { width: size, height: size, borderRadius: size / 2, backgroundColor: pair[0] }]}>
    <T kind="label" color={pair[1]} style={{ fontSize: Math.max(11, size * 0.34), lineHeight: size * 0.68 }} numberOfLines={1}>{initials}</T>
  </View>;
}

export function Brand({ small }: { small?: boolean }) {
  const width = small ? 30 : 35;
  return <View accessibilityLabel="Goodfork" style={ui.brand}>
    <View style={[ui.mark, { width, height: width, borderRadius: width * 0.32 }]}><Utensils size={width * 0.54} color={colors.ink} strokeWidth={2.15} /></View>
    <T kind="title" style={{ fontSize: small ? 30 : 35, lineHeight: small ? 33 : 38, letterSpacing: -0.7 }}>goodfork</T>
  </View>;
}

export function Field({ label, hint, style, ...props }: TextInputProps & { label: string; hint?: string }) {
  return <View style={ui.field}>
    <T kind="label">{label}</T>
    <TextInput placeholderTextColor={colors.faint} selectionColor={colors.green} accessibilityLabel={label}
      {...props} style={[ui.input, props.multiline && ui.multiline, style]} />
    {hint ? <T kind="small" color={colors.muted}>{hint}</T> : null}
  </View>;
}

export function Screen({ title, children, close, scroll = true, form = false, trailing }: {
  title: string; children: ReactNode; close?: boolean; scroll?: boolean; form?: boolean; trailing?: ReactNode;
}) {
  const nav = useNav();
  const back = () => nav.canGoBack() ? nav.goBack() : nav.navigate('Main');
  const body = scroll ? <ScrollView style={ui.fill} contentContainerStyle={ui.screenBody}
    keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>{children}</ScrollView>
    : <View style={ui.fill}>{children}</View>;
  return <SafeAreaView style={ui.safe}>
    <View style={ui.frame}>
      <View style={ui.topBar}>
        <IButton icon={close ? X : ArrowLeft} label={close ? 'Close' : 'Back'} onPress={back} />
        <T kind="strong" accessibilityRole="header" style={ui.topTitle} numberOfLines={1}>{title}</T>
        <View style={ui.topEnd}>{trailing}</View>
      </View>
      {form ? <KeyboardAvoidingView style={ui.fill} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>{body}</KeyboardAvoidingView> : body}
    </View>
  </SafeAreaView>;
}

export function Empty({ icon: Glyph, title, body, action, onPress }: { icon?: Icon; title: string; body?: string; action?: string; onPress?: () => void }) {
  return <View style={ui.empty}>
    {Glyph && <View style={ui.emptyIcon}><Glyph color={colors.green} size={28} strokeWidth={1.55} /></View>}
    <T kind="heading" style={ui.center}>{title}</T>
    {body ? <T color={colors.muted} style={ui.center}>{body}</T> : null}
    {action && onPress && <Button title={action} onPress={onPress} style={{ alignSelf: 'center', marginTop: 6 }} />}
  </View>;
}

export function Loading() {
  return <View style={ui.loading} accessibilityLabel="Loading"><ActivityIndicator color={colors.green} /></View>;
}

export function Issue({ message, retry }: { message: string; retry?: () => void }) {
  return <View style={ui.issue} accessibilityLiveRegion="polite">
    <T kind="label" color={colors.danger} style={{ flex: 1 }}>{message}</T>
    {retry && <Tap style={ui.retry} onPress={retry}><T kind="label" color={colors.danger}>Retry</T></Tap>}
  </View>;
}

export function ListEnd({ state }: { state: { hasMore: boolean; more: () => void; loadingMore: boolean; moreError?: string } }) {
  if (state.moreError) return <Issue message={state.moreError} retry={state.more} />;
  if (!state.hasMore && !state.loadingMore) return null;
  return <Button mode="line" title="Load more" busy={state.loadingMore} onPress={state.more} style={{ alignSelf: 'center', marginVertical: 16 }} />;
}

export function Section({ title, link, onPress }: { title: string; link?: string; onPress?: () => void }) {
  return <View style={ui.section}>
    <T kind="heading" accessibilityRole="header" style={{ flexShrink: 1 }}>{title}</T>
    {link && onPress && <Tap onPress={onPress} style={ui.sectionLink}><T kind="label" color={colors.green}>{link}</T>
      <ChevronRight size={15} color={colors.green} /></Tap>}
  </View>;
}

const type = StyleSheet.create<Record<Type, TextStyle>>({
  display: { fontFamily: fonts.display, fontSize: 52, lineHeight: 54, letterSpacing: -0.8 },
  title: { fontFamily: fonts.display, fontSize: 40, lineHeight: 44, letterSpacing: -0.25 },
  heading: { fontFamily: fonts.display, fontSize: 30, lineHeight: 34 },
  section: { fontFamily: fonts.display, fontSize: 25, lineHeight: 30 },
  body: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 21 },
  strong: { fontFamily: fonts.bold, fontSize: 15, lineHeight: 20 },
  label: { fontFamily: fonts.semibold, fontSize: 13, lineHeight: 18 },
  small: { fontFamily: fonts.medium, fontSize: 12, lineHeight: 17 },
});

export const ui = StyleSheet.create({
  fill: { flex: 1 },
  center: { textAlign: 'center' },
  safe: { flex: 1, backgroundColor: colors.paper },
  frame: { flex: 1, width: '100%', maxWidth: 672, alignSelf: 'center' },
  screenBody: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 36, gap: 16 },
  topBar: { minHeight: 51, borderBottomWidth: 1, borderBottomColor: colors.line, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12 },
  topTitle: { flex: 1, textAlign: 'center' },
  topEnd: { minWidth: 44, alignItems: 'flex-end' },
  button: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9,
    paddingHorizontal: 18, paddingVertical: 10, backgroundColor: colors.gold, borderRadius: 25 },
  lineButton: { borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  darkButton: { backgroundColor: colors.ink },
  dangerButton: { backgroundColor: colors.danger },
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
  chip: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderRadius: 20, gap: 6,
    paddingHorizontal: 12, paddingVertical: 7, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  activeChip: { backgroundColor: colors.greenWash, borderColor: '#C9D9C6' },
  segments: { flexDirection: 'row', borderWidth: 1, borderColor: colors.line, backgroundColor: '#F0EBE1', borderRadius: 25, padding: 4, gap: 4 },
  segment: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    minHeight: 44, padding: 5, borderRadius: 20 },
  segmentActive: { backgroundColor: colors.white, shadowColor: '#2F1B04', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.09,
    shadowRadius: 2, elevation: 1 },
  segmentLabel: { textAlign: 'center', flexShrink: 1 },
  avatar: { alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  mark: { backgroundColor: colors.gold, justifyContent: 'center', alignItems: 'center' },
  field: { gap: 7 },
  input: { borderWidth: 1, borderColor: colors.line, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12,
    minHeight: 49, fontFamily: fonts.regular, fontSize: 16, color: colors.ink, backgroundColor: colors.white },
  multiline: { minHeight: 105, textAlignVertical: 'top' },
  empty: { alignItems: 'center', paddingVertical: 38, paddingHorizontal: 16, gap: 9 },
  emptyIcon: { width: 60, height: 60, borderRadius: 23, backgroundColor: colors.greenWash, alignItems: 'center', justifyContent: 'center', marginBottom: 3 },
  loading: { padding: 25, alignItems: 'center' },
  issue: { minHeight: 45, paddingHorizontal: 13, paddingVertical: 8, borderRadius: 12, backgroundColor: '#FAEBE6',
    alignItems: 'center', flexDirection: 'row', gap: 10 },
  retry: { paddingHorizontal: 8, minHeight: 37, justifyContent: 'center' },
  section: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, minHeight: 44 },
  sectionLink: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingLeft: 12, minHeight: 44 },
});
