import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ArrowRight, Search, SlidersHorizontal, Sparkles } from 'lucide-react-native';
import { useData, useTask } from '../hooks';
import { useApp } from '../state';
import { colors } from '../theme';
import type { DiningSuggestions, Search as Filters } from '../types';
import type { Props } from '../navigation';
import { PlaceRow } from '../components/cards';
import { Button, Chip, Field, Issue, Screen, Section, T, Tap } from '../components/ui';
import { FilterFields } from './Explore';

export function ChooseScreen({ route, navigation: nav }: Props<'Choose'>) {
  const { api, sessionGeneration, revision } = useApp();
  const config = useData('config', signal => api.config(signal));
  const task = useTask();
  const [prompt, setPrompt] = useState(route.params?.prompt ?? '');
  const [result, setResult] = useState<DiningSuggestions>();
  const [editing, setEditing] = useState(false);
  const [filters, setFilters] = useState<Filters>({});
  const [provider, setProvider] = useState(false);
  const remotelyAvailable = config.data?.assistRemote?.dining === true;

  useEffect(() => { setResult(undefined); setProvider(false); }, [sessionGeneration, revision]);

  function find() {
    void task.run(async () => {
      const match = await api.suggestDining(prompt.trim(), route.params?.filters ?? {}, provider && remotelyAvailable);
      setResult(match);
      setFilters(match.filters);
      setEditing(false);
    }, true);
  }

  return <Screen title="Help me choose" form close>
    <View style={styles.hero}>
      <View style={styles.icon}><Sparkles color={colors.green} size={23} /></View>
      <T accessibilityRole="header" kind="title">What sounds good?</T>
      <T color={colors.muted}>Describe a dish, neighborhood, price range, or dietary preference.</T>
    </View>
    <Field label="What are you looking for?" placeholder="Vegetarian ramen in the East Village"
      value={prompt} onChangeText={setPrompt} maxLength={160} multiline />
    {remotelyAvailable && <View style={styles.privacy}>
      <Chip title="Use optional AI provider" active={provider} onPress={() => setProvider(value => !value)} />
      <T kind="small" color={colors.muted}>Shares selected cuisine, diet, and price categories. Your request stays in Goodfork.</T>
    </View>}
    {task.error && <Issue message={task.error} />}
    <Button icon={Search} title="Find suggestions" disabled={prompt.trim().length < 2} busy={task.busy} onPress={find} />
    {result && <>
      <View style={styles.refine}>
        <View style={styles.filterHeading}>
          <T kind="heading">Search filters</T>
          <Tap accessibilityState={{ expanded: editing }} onPress={() => setEditing(value => !value)} style={styles.change}>
            <SlidersHorizontal size={17} color={colors.green} />
            <T kind="label" color={colors.green}>{editing ? 'Close editor' : 'Edit filters'}</T>
          </Tap>
        </View>
        {editing ? <>
          <Field label="Dish or search terms" value={filters.q ?? ''} onChangeText={q => setFilters({ ...filters, q })} maxLength={120} />
          <FilterFields value={filters} onChange={setFilters} />
        </> : <T kind="label" color={colors.muted}>
          {[filters.q, filters.area, filters.cuisine, filters.diet, filters.price ? '$'.repeat(filters.price) : '', filters.sort === 'nearby' ? 'Closest first' : ''].filter(Boolean).join(' · ') || 'All restaurants'}
        </T>}
        <Button mode="line" title="Search with these filters" icon={ArrowRight}
          onPress={() => nav.popTo('Main', { tab: 'explore', exploreFilters: filters })} />
      </View>
      <Section title="Restaurants to try" />
      {result.note ? <T color={colors.muted} accessibilityLiveRegion="polite">{result.note}</T> : null}
      {result.outcome === 'fallback' && <T kind="small" color={colors.muted}>Suggestions are based on the Goodfork directory.</T>}
      {result.suggestions.map(({ place, reason }) => <View key={place.id} style={styles.result}>
        <PlaceRow place={place} saves />
        <T kind="label" color={colors.muted}>{reason}</T>
        {place.dishMatch && <Tap style={styles.source} onPress={() => nav.push('Review', { id: place.dishMatch!.reviewId })}>
          <T kind="label" color={colors.green}>Read the source review</T><ArrowRight size={16} color={colors.green} />
        </Tap>}
      </View>)}
    </>}
  </Screen>;
}

const styles = StyleSheet.create({
  hero: { gap: 7 },
  icon: { width: 44, height: 44, borderRadius: 15, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.greenWash },
  privacy: { alignItems: 'flex-start', gap: 5 },
  refine: { borderRadius: 18, padding: 12, gap: 9, backgroundColor: colors.greenWash },
  filterHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  change: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5 },
  result: { gap: 5 },
  source: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
});
