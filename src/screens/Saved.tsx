import { useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { ArrowRightLeft, Bookmark, ChevronRight, ListOrdered, Trophy } from 'lucide-react-native';
import { useApp, useMember } from '../state';
import { useData, usePage, useTask } from '../hooks';
import { useNav, type Props } from '../navigation';
import { colors, fonts } from '../theme';
import type { Place, Post } from '../types';
import { placeLabel, PlaceRow, Score } from '../components/cards';
import { Photo } from '../components/media';
import { Button, Empty, Issue, ListEnd, Loading, Screen, Segment, T, Tap, ui } from '../components/ui';
import { JournalList } from './Journal';

export function Saved({ explore }: { explore: () => void }) {
  const { api, signedIn } = useApp();
  const nav = useNav();
  const member = useMember();
  const [tab, select] = useState<'saved' | 'ranked' | 'journal'>('saved');
  const saved = usePage('saved', (offset,read) => api.saved(offset,read), signedIn && tab === 'saved');
  const ranked = usePage('ranked', (offset,read) => api.ranked(offset,read), signedIn && tab === 'ranked');
  const page = tab === 'saved' ? saved : ranked;
  return <View style={ui.fill}>
    <View style={styles.header}>
      <T kind="display" accessibilityRole="header">Saved</T>
      <Segment value={tab} onChange={select} options={[
        { key: 'saved', title: 'Want to go', icon: Bookmark },
        { key: 'ranked', title: 'My rankings', icon: ListOrdered },
        { key: 'journal', title: 'Journal' },
      ]} />
    </View>
    {tab === 'journal' ? <JournalList /> : <FlatList<Place | Post> key={tab} data={signedIn ? page.items : []} keyExtractor={item => item.id}
      contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}
      ListHeaderComponent={page.error ? <Issue message={page.error} retry={page.reload} /> :
        signedIn && tab === 'ranked' && ranked.items.length >= 2
          ? <Button mode="line" icon={ArrowRightLeft} title="Compare two visits" onPress={() => nav.push('Compare')} />
          : undefined}
      ListEmptyComponent={!signedIn ? <Empty icon={Bookmark} title="Keep your own list" body="Sign in to save restaurants and rank meals you’ve tried."
        action="Sign in" onPress={member} /> : page.loading ? <Loading /> : page.error ? undefined :
        <Empty icon={tab === 'saved' ? Bookmark : Trophy}
          title={tab === 'saved' ? 'Somewhere for later' : 'Make it personal'}
          body={tab === 'saved' ? 'Save a restaurant to start your want-to-go list.' : 'Log a visit to start ranking the places you’ve tried.'}
          action={tab === 'saved' ? 'Explore restaurants' : 'Log a visit'}
          onPress={tab === 'saved' ? explore : () => nav.push('Compose')} />}
      renderItem={({item,index}) => 'restaurant' in item
        ? <RankRow post={item} index={index + 1} onPress={() => nav.push('Review', { id: item.id })} />
        : <PlaceRow place={item} saves />}
      ListFooterComponent={<ListEnd state={page} />}
    />}
  </View>;
}

function RankRow({ post, index, onPress, selected }: { post: Post; index?: number; onPress: () => void; selected?: boolean }) {
  return <Tap onPress={onPress} accessibilityState={selected === undefined ? undefined : { selected }} style={[styles.rankRow, selected && styles.selected]}>
    {index != null && <View style={styles.number}><T style={{ fontFamily: fonts.display, fontSize: 24 }} color={colors.green}>{index}</T></View>}
    <Photo media={post.restaurant.cover ?? post.media} style={styles.rankPhoto} />
    <View style={{ flex: 1 }}>
      <T kind="strong">{post.restaurant.name}</T>
      <T kind="small" color={colors.muted}>{placeLabel(post.restaurant)}</T>
    </View>
    <Score value={post.score} label="Your score" />
    {selected === undefined && <ChevronRight color={colors.faint} size={16} />}
  </Tap>;
}

export function CompareScreen({ route }: Props<'Compare'>) {
  const nav = useNav();
  const { api, invalidate, toast, signedIn } = useApp();
  const visitId = route.params?.visitId;
  const [picks, setPicks] = useState<string[]>(visitId ? [visitId] : []);
  const startingVisit = useData('post:compare:' + visitId, signal => api.post(visitId!,signal), Boolean(visitId));
  const page = usePage('ranked:comparison', (offset,read) => api.ranked(offset,read), signedIn);
  const task = useTask();
  const selected = picks.map(id => page.items.find(p => p.id === id) ?? (id === visitId ? startingVisit.data : undefined)).filter((post): post is Post => Boolean(post));

  function choose(winner: string) {
    const loser = selected.find(post => post.id !== winner);
    if (!loser) return;
    void task.run(async () => {
      await api.rank(winner, loser.id);
      invalidate('ranked');
      toast('Your rankings were updated');
      nav.goBack();
    });
  }

  return <Screen title="Compare visits" close scroll={false}>
    <FlatList data={selected.length === 2 ? [] : page.items.filter(post => post.id !== visitId)} keyExtractor={post => post.id}
      contentContainerStyle={{ padding: 20, gap: 12 }} ListHeaderComponent={<>
    <T kind="title">{selected.length === 2 ? 'Which would you go back to?' : visitId ? 'Pick a past visit' : 'Pick two places'}</T>
    <T color={colors.muted}>{selected.length === 2 ? 'Your pick moves just above the other restaurant in your rankings.' : visitId && startingVisit.data ? 'Compare ' + startingVisit.data.restaurant.name + ' with a place you’ve tried.' : 'Choose restaurants from your past visits.'}</T>
    {page.error && <Issue message={page.error} retry={page.reload} />}
    {page.loading && !page.items.length && <Loading />}
    {selected.length === 2 ? <>
      {selected.map(post => <Tap key={post.id} disabled={task.busy} onPress={() => choose(post.id)}
        style={styles.compareOption} accessibilityLabel={'Prefer ' + post.restaurant.name}>
        <Photo media={post.restaurant.cover ?? post.media} style={styles.comparePhoto} />
        <View style={styles.compareText}><T kind="heading" style={{ flex: 1 }}>{post.restaurant.name}</T><Score value={post.score} label="Your score" /></View>
      </Tap>)}
      <Button mode="line" title="Choose different places" disabled={task.busy} onPress={() => setPicks(visitId ? [visitId] : [])} />
    </> : null}
      </>}
      renderItem={({ item }) => <RankRow post={item} selected={picks.includes(item.id)} onPress={() =>
        setPicks(values => values.includes(item.id) ? values.filter(id => id !== item.id) : [...values, item.id])} />}
      ListFooterComponent={selected.length === 2 ? undefined : <ListEnd state={page} />}
      onEndReached={() => { if (!page.moreError) void page.more(); }} onEndReachedThreshold={0.4}
    />
  </Screen>;
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 8, gap: 9 },
  list: { paddingHorizontal: 20, paddingTop: 11, paddingBottom: 24, gap: 9 },
  rankRow: { minHeight: 78, padding: 9, gap: 9, flexDirection: 'row', alignItems: 'center', borderRadius: 16,
    borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  number: { width: 27, alignItems: 'center' },
  rankPhoto: { width: 55, height: 55, borderRadius: 11 },
  selected: { backgroundColor: colors.greenWash, borderColor: '#A9C2A4' },
  compareOption: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 20, overflow: 'hidden' },
  comparePhoto: { height: 140 },
  compareText: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 13 },
});
