import { useRef, useState } from 'react';
import { FlatList, View } from 'react-native';
import { BookOpen, LockKeyhole, Pencil, Plus, Trash2 } from 'lucide-react-native';
import { randomUUID } from 'expo-crypto';
import { useApp, useMember } from '../state';
import { useData, usePage, useTask } from '../hooks';
import { useNav, type Props } from '../navigation';
import type { PrivateVisit, VisitInput } from '../types';
import { localDate } from '../hours';
import { colors } from '../theme';
import { ServiceError } from '../services/client';
import { Button, Empty, Field, Issue, ListEnd, Loading, Screen, T, Tap } from '../components/ui';

export function JournalList({ placeId }: { placeId?: string }) {
  const { api, signedIn } = useApp();
  const nav = useNav();
  const member = useMember();
  const page = usePage('visits:' + (placeId ?? 'all'), (offset, read) => api.visits(placeId, offset, read), signedIn);
  return <FlatList data={page.items} keyExtractor={entry => entry.id}
    contentContainerStyle={{ padding: 20, gap: 12 }} showsVerticalScrollIndicator={false}
    ListHeaderComponent={<View style={{ gap: 10 }}>
      <T kind="label" color={colors.green}>Only you</T>
      <Button title="Add private visit" icon={Plus} mode="line" onPress={() => { if (member()) nav.push('Compose', { placeId, mode: 'memory' }); }} />
      {page.error && <Issue message={page.error} retry={page.reload} />}
    </View>}
    ListEmptyComponent={page.loading ? <Loading /> : !page.error ? <Empty icon={BookOpen} title="Remember the next meal"
      body="Keep dates, dishes, and private notes each time you visit." /> : undefined}
    renderItem={({ item }) => <Tap onPress={() => nav.push('Visit', { id: item.id })}
      style={{ backgroundColor: colors.white, borderRadius: 18, padding: 16, gap: 6, borderWidth: 1, borderColor: colors.line }}>
      <T kind="heading">{item.restaurantName}</T>
      <T kind="small" color={colors.muted}>{item.visitDate}{item.score !== null ? ' · Your score ' + item.score.toFixed(1) : ''}</T>
      {item.dish ? <T kind="label">{item.dish}</T> : null}
      {item.note ? <T numberOfLines={2}>{item.note}</T> : null}
      {item.unavailable && <T kind="small" color={colors.muted}>Restaurant listing unavailable</T>}
    </Tap>}
    ListFooterComponent={<ListEnd state={page} />} onEndReached={() => { if (!page.moreError) void page.more(); }} onEndReachedThreshold={0.4}
  />;
}

export function JournalScreen({ route }: Props<'Journal'>) {
  return <Screen title="Your visits" scroll={false}><JournalList placeId={route.params?.placeId} /></Screen>;
}

export function PrivateMemoryForm({ placeId, placeName, prior, saved }: {
  placeId?: string; placeName: string; prior?: PrivateVisit; saved?: (entry: PrivateVisit) => void;
}) {
  const nav = useNav();
  const { api, invalidate, toast } = useApp();
  const task = useTask();
  const refresh = useTask();
  const requestId = useRef(randomUUID());
  const pendingCreate = useRef<{ input: VisitInput; version: number } | undefined>(undefined);
  const formVersion = useRef(0);
  const [created, setCreated] = useState<PrivateVisit>();
  const editingEntry = prior ?? created;
  const [date, setDate] = useState(prior?.visitDate ?? localDate());
  const [note, setNote] = useState(prior?.note ?? '');
  const [dish, setDish] = useState(prior?.dish ?? '');
  const [score, setScore] = useState(prior?.score?.toFixed(1) ?? '');
  const [revision, setRevision] = useState(prior?.revision ?? '');
  const [latest, setLatest] = useState<PrivateVisit>();
  return <>
    <T kind="title">{placeName}</T>
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
      <LockKeyhole size={17} color={colors.green} /><T kind="label" color={colors.green}>Only you</T>
    </View>
    <Field label="Visit date" value={date} onChangeText={value => { setDate(value); formVersion.current++; }} placeholder="YYYY-MM-DD" maxLength={10} autoCapitalize="none" />
    <Field label="Dishes" value={dish} onChangeText={value => { setDish(value); formVersion.current++; }} maxLength={160} placeholder="What would you order again?" />
    <Field label="Private note" value={note} onChangeText={value => { setNote(value); formVersion.current++; }} maxLength={1500} multiline placeholder="Remember the meal in your own words." />
    <Field label="Private score (optional)" value={score} onChangeText={value => { setScore(value); formVersion.current++; }} maxLength={4} keyboardType="decimal-pad" placeholder="1–10" />
    {task.error && <Issue message={task.error} />}
    {refresh.error && <Issue message={refresh.error} />}
    {task.status === 409 && !latest && editingEntry && <Button mode="line" title="Load current memory" busy={refresh.busy}
      onPress={() => void refresh.run(async () => setLatest(await api.visit(editingEntry.id)), true)} />}
    {latest && <View style={{ padding: 14, backgroundColor: colors.greenWash, borderRadius: 14, gap: 8 }}>
      <T kind="heading">Current memory</T><T>{latest.visitDate} · {latest.dish}</T><T>{latest.note}</T>
      <T>{latest.score === null ? 'No private score' : 'Private score ' + latest.score}</T>
      <Button mode="line" title="Keep my memory draft" onPress={() => { setRevision(latest.revision); setLatest(undefined); task.setError(''); }} />
      <Button mode="line" title="Use current memory" onPress={() => {
        setDate(latest.visitDate); setDish(latest.dish); setNote(latest.note); setScore(latest.score?.toFixed(1) ?? '');
        setRevision(latest.revision); setLatest(undefined); task.setError('');
      }} />
    </View>}
    <Button title={editingEntry ? 'Save memory changes' : pendingCreate.current ? 'Retry private visit' : 'Save private visit'} busy={task.busy}
      disabled={Boolean(latest) || (task.status === 409 && Boolean(task.error))}
      onPress={() => void task.run(async () => {
        const value = score.trim() ? Number(score.replace(',', '.')) : null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw Error('Enter a valid date in YYYY-MM-DD format.');
        if (value !== null && (!Number.isFinite(value) || value < 1 || value > 10 || Math.abs(value * 10 - Math.round(value * 10)) > 0.0001)) throw Error('Choose an optional score from 1 to 10 with one decimal.');
        const input = { visitDate: date, dish: dish.trim(), note: note.trim(), score: value };
        if (!prior && !placeId) throw Error('Choose an available restaurant.');
        let submittedVersion = formVersion.current;
        let entry: PrivateVisit;
        if (editingEntry) entry = await api.editVisit(editingEntry.id, { ...input, revision });
        else {
          const submitted = pendingCreate.current ?? { input, version: submittedVersion };
          pendingCreate.current = submitted;
          submittedVersion = submitted.version;
          try {
            entry = await api.createVisit({ ...submitted.input, restaurantId: placeId!, requestId: requestId.current });
          } catch (error) {
            if (error instanceof ServiceError && error.status >= 400 && error.status < 500 && error.status !== 408) pendingCreate.current = undefined;
            throw error;
          }
          pendingCreate.current = undefined;
        }
        setRevision(entry.revision);
        setCreated(entry);
        if (formVersion.current !== submittedVersion) {
          invalidate('visits');
          toast('Earlier version saved. Your new changes are ready to save.');
          return;
        }
        invalidate('visits', 'visit:' + entry.id);
        toast('Private memory saved');
        if (saved) saved(entry);
        else nav.replace('Visit', { id: entry.id });
      }, true)} />
  </>;
}

export function VisitScreen({ route, navigation: nav }: Props<'Visit'>) {
  const { api, confirm, invalidate, signedIn } = useApp();
  const member = useMember();
  const task = useTask();
  const [editing, setEditing] = useState(false);
  const data = useData('visit:' + route.params.id, signal => api.visit(route.params.id, signal), signedIn);
  const entry = data.data;
  return <Screen title="Private visit" form>
    {!signedIn && <Empty icon={LockKeyhole} title="Your private journal" action="Sign in" onPress={member} />}
    {data.error && <Issue message={data.error} retry={data.reload} />}
    {data.loading && !entry && <Loading />}
    {entry && (editing ? <PrivateMemoryForm key={entry.id} placeId={entry.restaurantId ?? undefined}
      placeName={entry.restaurantName} prior={entry} saved={() => { setEditing(false); data.reload(); }} /> : <>
      <T kind="label" color={colors.green}>Only you</T>
      <T kind="title">{entry.restaurantName}</T><T color={colors.muted}>{entry.visitDate}</T>
      {entry.dish ? <T kind="heading">{entry.dish}</T> : null}
      {entry.note ? <T>{entry.note}</T> : null}
      {entry.score !== null && <T kind="label">Private score {entry.score.toFixed(1)}</T>}
      <Button icon={Pencil} title="Edit private memory" mode="line" onPress={() => setEditing(true)} />
      {entry.restaurantId && !entry.unavailable ? <Button title="Write or update public review" onPress={() => nav.push('Compose', { placeId: entry.restaurantId!, mode: 'review' })} />
        : <T color={colors.muted}>Restaurant listing unavailable</T>}
      <T kind="small" color={colors.muted}>Public reviews and restaurant rankings are managed separately from your journal.</T>
      {task.error && <Issue message={task.error} retry={data.reload} />}
      <Button title="Delete private visit" icon={Trash2} mode="danger" busy={task.busy} onPress={() => void task.run(async () => {
        if (!await confirm('Delete private visit?', 'This memory will be permanently removed.', 'Delete', true)) return;
        await api.deleteVisit(entry.id, entry.revision);
        invalidate('visits');
        if (nav.canGoBack()) nav.goBack(); else nav.replace('Journal');
      }, true)} />
    </>)}
  </Screen>;
}
