import { useEffect, useState } from 'react';
import { FlatList, Modal, ScrollView, StyleSheet, TextInput, View, type ListRenderItemInfo } from 'react-native';
import { ChevronRight, CirclePlus, Compass, List, LocateFixed, Map, MapPin, Search as SearchIcon, SlidersHorizontal, Sparkles, Users, X } from 'lucide-react-native';
import * as Location from 'expo-location';
import type { Person, Place, Search } from '../types';
import { useApp, useMember } from '../state';
import { useDebounced, usePage, useTask } from '../hooks';
import { useNav } from '../navigation';
import { colors, fonts } from '../theme';
import { PlaceRow } from '../components/cards';
import MapPanel from '../components/MapPanel';
import { Avatar, Button, Chip, Empty, Field, IButton, Issue, ListEnd, Loading, Segment, T, Tap, ui } from '../components/ui';

export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <View style={styles.searchBox}>
    <SearchIcon size={20} color={colors.green} strokeWidth={1.85} />
    <TextInput accessibilityLabel={placeholder} placeholder={placeholder} placeholderTextColor={colors.faint} value={value} onChangeText={onChange}
      style={styles.search} autoCorrect={false} returnKeyType="search" maxLength={80} />
    {value !== '' && <IButton icon={X} label="Clear search" onPress={() => onChange('')} />}
  </View>;
}

export function Explore({ initial, preset }: { initial?: string; preset?: Search }) {
  const nav = useNav();
  const { api, isDemo } = useApp();
  const member = useMember();
  const [kind, setKind] = useState<'places' | 'people'>(initial?.startsWith('@') ? 'people' : 'places');
  const [search, setSearch] = useState(initial === '@' ? '' : initial ?? '');
  const [filters, setFilters] = useState<Pick<Search, 'price' | 'cuisine' | 'diet' | 'area' | 'openNow'>>({});
  const [sort, setSort] = useState<'relevance' | 'nearby'>('relevance');
  const [nearby, setNearby] = useState<{ lat: number; lng: number }>();
  const [isMap, setMap] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const spot = useTask();
  const q = useDebounced(search.trim());
  const criteria: Search = { q, ...filters, sort, ...(sort === 'nearby' && nearby ? nearby : {}) };
  const criteriaKey = JSON.stringify(criteria);
  const places = usePage('directory:' + criteriaKey, (offset, read) => api.places(criteria, offset, read), kind === 'places');
  const people = usePage('diners:' + q, (offset, read) => api.people(q, offset, read), kind === 'people');
  const result = kind === 'places' ? places : people;
  const count = Object.values(filters).filter(Boolean).length;
  const openPlace = (place: Place) => nav.push('Place', { id: place.id });

  useEffect(() => {
    if (initial == null) return;
    setKind(initial.startsWith('@') ? 'people' : 'places');
    setSearch(initial === '@' ? '' : initial);
  }, [initial]);

  useEffect(() => {
    if (!preset) return;
    setKind('places');
    setSearch(preset.q ?? '');
    setFilters({ area: preset.area, cuisine: preset.cuisine, diet: preset.diet, price: preset.price, openNow: preset.openNow });
    if (preset.sort === 'nearby' && preset.lat != null && preset.lng != null) {
      setNearby({ lat: preset.lat, lng: preset.lng });
      setSort('nearby');
    } else setSort('relevance');
  }, [preset]);

  return <View style={ui.fill}>
    <View style={styles.header}>
      <View style={styles.titleLine}>
        <View>
          <T kind="display" accessibilityRole="header">Explore</T>
          {isDemo && <T kind="small" color={colors.muted}>New York sample directory</T>}
        </View>
        {kind === 'places' && <IButton icon={isMap ? List : Map} style={styles.mapButton}
          active={isMap} label={isMap ? 'Show list' : 'Show map'} onPress={() => setMap(x => !x)} />}
      </View>
      <SearchField value={search} onChange={setSearch} placeholder={kind === 'places' ? 'Restaurant, dish, or neighborhood' : 'Name or @handle'} />
      <Segment value={kind} options={[{ key: 'places', title: 'Restaurants', icon: MapPin }, { key: 'people', title: 'Diners', icon: Users }]} onChange={setKind} />
      {kind === 'places' && <View style={styles.filters}>
        <Chip title={count ? 'Filters (' + count + ')' : 'Filters'} icon={SlidersHorizontal} active={count > 0} onPress={() => setShowFilters(true)} />
        <Chip title={spot.busy ? 'Locating…' : nearby ? (sort === 'nearby' ? 'Closest first' : 'By relevance') : 'Near me'} icon={LocateFixed} active={sort === 'nearby'} onPress={() => {
          if (nearby) { setSort(sort === 'nearby' ? 'relevance' : 'nearby'); return; }
          void spot.run(async () => {
            const permission = await Location.requestForegroundPermissionsAsync();
            if (!permission.granted) throw new Error('Location access is off. Use the area filter to search a neighborhood.');
            const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
            setNearby({ lat: Number(location.coords.latitude.toFixed(3)), lng: Number(location.coords.longitude.toFixed(3)) });
            setSort('nearby');
          });
        }} />
        <Chip title="Help me choose" icon={Sparkles} onPress={() => nav.push('Choose', {
          prompt: search.trim(), filters: { ...criteria, q: undefined },
        })} />
      </View>}
    </View>
    <FlatList<Place | Person> data={result.items} keyExtractor={item => item.id} key={kind}
      keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={styles.results}
      ListHeaderComponent={<>
        {result.error && <Issue message={result.error} retry={result.reload} />}
                {kind === 'places' && isMap && !!places.items.length && <View style={styles.mapResults}>
          <MapPanel key={criteriaKey} places={places.items} onSelect={openPlace} />
          <T kind="small" color={colors.muted}>Showing {places.items.length} loaded {places.items.length === 1 ? 'restaurant' : 'restaurants'}.</T>
        </View>}
      </>}
      renderItem={({ item }: ListRenderItemInfo<Place | Person>) => 'cuisine' in item
        ? <View>
          <PlaceRow place={item} onPress={() => openPlace(item)} saves />
          {item.dishMatch && <Tap style={styles.evidence} onPress={() => nav.push('Review', { id: item.dishMatch!.reviewId })}>
            <T kind="label" color={colors.green}>{item.dishMatch.dish} · Read the source review</T>
          </Tap>}
        </View>
        : <PersonRow person={item} onPress={() => nav.push('Person', { id: item.id })} />}
      ListEmptyComponent={result.loading ? <Loading /> : result.error ? undefined : <Empty icon={kind === 'places' ? Compass : Users}
        title={kind === 'places' ? 'No restaurants found' : 'No diners found'}
        body={sort === 'nearby' && kind === 'places' ? 'Switch to relevance or search by area.' : 'Try a different search or clear your filters.'} />}
      ListFooterComponent={<>
        <ListEnd state={result} />
        {kind === 'places' && !result.loading && !result.error && <Tap style={styles.suggest}
          onPress={() => { if (member()) nav.push('AddPlace', { name: search.trim() }); }}>
          <CirclePlus color={colors.green} size={20} /><T kind="label" color={colors.green}>Suggest a restaurant</T>
        </Tap>}
      </>}
      onEndReachedThreshold={0.25} onEndReached={() => { if (!result.moreError) void result.more(); }}
    />
    {showFilters && <Filters current={filters} onClose={() => setShowFilters(false)} onApply={value => { setFilters(value); setShowFilters(false); }} />}
  </View>;
}

export function FilterFields({ value, onChange }: { value: Search; onChange: (value: Search) => void }) {
  return <>
    <Chip title="Open now" active={value.openNow} onPress={() => onChange({ ...value, openNow: !value.openNow })} />
    {value.openNow && <T kind="small" color={colors.muted}>Uses restaurant-supplied weekly hours and date exceptions.</T>}
    <Field label="Neighborhood or city" placeholder="East Village" value={value.area ?? ''}
      onChangeText={area => onChange({ ...value, area })} maxLength={72} />
    <Field label="Cuisine" placeholder="Japanese" value={value.cuisine ?? ''}
      onChangeText={cuisine => onChange({ ...value, cuisine })} maxLength={48} />
    <T kind="label">Price tier</T>
    <View style={styles.filters}>
      {[1, 2, 3, 4].map(price => <Chip key={price} title={'$'.repeat(price)} active={value.price === price}
        onPress={() => onChange({ ...value, price: value.price === price ? undefined : price })} />)}
    </View>
    <T kind="label">Dietary listing tags</T>
    <View style={styles.filters}>
      {['Vegetarian', 'Vegan', 'Gluten-free options', 'Halal'].map(diet => <Chip key={diet} title={diet} active={value.diet === diet}
        onPress={() => onChange({ ...value, diet: value.diet === diet ? undefined : diet })} />)}
    </View>
  </>;
}

function Filters({ current, onClose, onApply }: { current: Search; onClose: () => void; onApply: (value: Search) => void }) {
  const [filters, setFilters] = useState<Search>(current);
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <View style={styles.scrim}>
      <View accessibilityViewIsModal style={styles.dialog}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.dialogContent}>
          <View style={styles.titleLine}><T kind="heading">Restaurant filters</T><IButton icon={X} label="Close filters" onPress={onClose} /></View>
          <FilterFields value={filters} onChange={setFilters} />
          <Button title="Show results" onPress={() => onApply({ ...filters, cuisine: filters.cuisine?.trim(), area: filters.area?.trim() })} />
          <Button mode="line" title="Clear filters" onPress={() => onApply({})} />
        </ScrollView>
      </View>
    </View>
  </Modal>;
}

export function PersonRow({ person, onPress, trailing }: { person: Person; onPress?: () => void; trailing?: React.ReactNode }) {
  const profile = <>
      <Avatar person={person} size={43} />
      <View style={{ flex: 1 }}>
        <T kind="strong">{person.name}</T>
        <T kind="small" color={colors.muted}>@{person.handle} · {person.reviewCount} {person.reviewCount === 1 ? 'review' : 'reviews'}</T>
      </View>
    </>;
  return <View style={styles.personRow}>
    {onPress ? <Tap onPress={onPress} style={styles.personLink}>{profile}</Tap> : <View style={styles.personLink}>{profile}</View>}
    {trailing ?? <ChevronRight size={17} color={colors.faint} />}
  </View>;
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingTop: 14, gap: 10 },
  titleLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  mapButton: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  searchBox: { flexDirection: 'row', alignItems: 'center', minHeight: 52, paddingLeft: 13, borderRadius: 15,
    gap: 9, borderColor: colors.line, borderWidth: 1, backgroundColor: colors.white },
  search: { flex: 1, minHeight: 48, paddingVertical: 8, paddingRight: 8, fontFamily: fonts.regular, fontSize: 16, color: colors.ink },
  mapResults: { gap: 5, marginBottom: 7 },
  evidence: { minHeight: 44, paddingHorizontal: 10, alignItems: 'flex-start', justifyContent: 'center' },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  results: { paddingHorizontal: 20, paddingVertical: 13, gap: 9 },
  suggest: { minHeight: 49, flexDirection: 'row', alignSelf: 'center', alignItems: 'center', gap: 8, paddingHorizontal: 12 },
  personRow: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 15, flexDirection: 'row', alignItems: 'center', padding: 10, gap: 8 },
  personLink: { minHeight: 50, flexDirection: 'row', alignItems: 'center', flex: 1, gap: 10 },
  scrim: { flex: 1, backgroundColor: '#231D178C', justifyContent: 'center', alignItems: 'center', padding: 18 },
  dialog: { backgroundColor: colors.paper, borderRadius: 25, width: '100%', maxWidth: 430, maxHeight: '91%' },
  dialogContent: { padding: 19, gap: 14 },
});
