import { useCallback, useRef, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Bell, ChevronDown, CirclePlay, Compass, Heart, MapPin, MessageCircle, Search, Pause, Play, Share2, Users, Volume2, VolumeX } from 'lucide-react-native';
import { useIsFocused } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import type { FeedKind, Post } from '../types';
import { useApp, useMember } from '../state';
import { useData, usePage, useReducedMotion } from '../hooks';
import { useNav } from '../navigation';
import { colors } from '../theme';
import { Author, placeLabel, PlaceTile, ReviewCard, SaveButton, Score, useReviewActions } from '../components/cards';
import { ClipPlayer, Photo } from '../components/media';
import { Brand, Empty, IButton, Issue, ListEnd, Loading, Section, Segment, T, Tap, ui } from '../components/ui';

export function Discover({ explore, visible }: { explore: () => void; visible: boolean }) {
  const nav = useNav();
  const { api, isDemo, signedIn } = useApp();
  const member = useMember();
  const [kind, select] = useState<FeedKind>('for-you');
  const page = usePage('feed:' + kind, (offset, read) => api.feed(kind, offset, read));
  const featured = useData('directory:featured', signal => api.places({}, 0, { signal }), kind === 'for-you');
  const activity = useData('activity:badge', signal => api.activity(0, { signal }), signedIn);
  const unread = activity.data?.items.some(item => !item.read);
  const { width } = useWindowDimensions();
  const imageHeight = Math.min(425, Math.max(276, (Math.min(width, 672) - 40) * 0.88));

  const restaurants = !!featured.data?.items.length && <View style={styles.trending}>
    <Section title="Browse restaurants" link="Explore" onPress={explore} />
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tiles}>
      {featured.data.items.slice(0, 8).map(place => <PlaceTile place={place} key={place.id} />)}
    </ScrollView>
  </View>;
  return <View style={ui.fill}>
    <View style={styles.header}>
      <View style={styles.masthead}>
        <Brand />
        <Tap onPress={explore} style={styles.location} accessibilityLabel="Explore restaurants by location">
          <MapPin size={16} strokeWidth={1.8} color={colors.green} />
          <T kind="label">{isDemo ? 'New York, NY' : 'Explore nearby'}</T>
          <ChevronDown size={13} color={colors.muted} />
        </Tap>
      </View>
      <View style={styles.titleLine}>
        <T kind="display" accessibilityRole="header">Discover</T>
        <View style={styles.activity}>
          <IButton icon={Bell} label={unread ? 'Activity, unread notifications' : 'Activity'} style={styles.bell} onPress={() => {
            if (member()) nav.push('Activity');
          }} />
          {unread && <View pointerEvents="none" style={styles.dot} />}
        </View>
      </View>
      <Segment value={kind} onChange={select} options={[
        { key: 'for-you', title: 'For you' },
        { key: 'following', title: 'Following' },
        { key: 'clips', title: 'Clips', icon: CirclePlay },
      ]} />
    </View>
    {kind === 'clips' && visible && page.items.length > 0
      ? <ClipFeed posts={page.items} more={page.more} footer={<ListEnd state={page} />} />
      : <FlatList
        key={kind}
        data={page.items}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.feed}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={page.loading && !!page.items.length} onRefresh={page.reload} tintColor={colors.green} />}
        ListHeaderComponent={<>
          {page.error ? <Issue message={page.error} retry={page.reload} /> : null}
          {kind === 'for-you' && !page.items.length && restaurants}
        </>}
        ListEmptyComponent={page.loading ? <Loading /> : page.error ? undefined :
          <Empty icon={kind === 'following' ? Users : kind === 'clips' ? CirclePlay : Compass}
            title={kind === 'following' ? 'Your people, your places' : kind === 'clips' ? 'Clips will appear here' : 'Nothing on the table yet'}
            body={kind === 'following' ? 'Follow diners you like to see their reviews here.' : kind === 'clips' ? 'Share a short video when you log your next visit.' : 'Explore the directory or share a restaurant you’ve tried.'}
            action={kind === 'clips' ? 'Log a visit' : kind === 'following' ? 'Find diners' : 'Explore restaurants'}
            onPress={() => {
              if (kind === 'clips') {
                if (member()) nav.push('Compose');
              } else if (kind === 'following') nav.navigate('Main', { tab: 'explore', exploreQuery: '@' });
              else explore();
            }} />}
        renderItem={({ item, index }) => <View style={styles.feedItem}>
          <ReviewCard post={item} imageHeight={imageHeight} />
          {kind === 'for-you' && index === 0 && restaurants}
        </View>}
        onEndReachedThreshold={0.25} onEndReached={() => { if (!page.moreError) void page.more(); }}
        ListFooterComponent={<ListEnd state={page} />}
      />}
  </View>;
}

function ClipFeed({ posts, more, footer }: { posts: Post[]; more: () => void; footer: React.JSX.Element }) {
  const [height, setHeight] = useState(0);
  const [index, setIndex] = useState(-1);
  const [muted, setMuted] = useState(true);
  const focused = useIsFocused();
  const reducedMotion = useReducedMotion();
  const viewConfig = useRef({ viewAreaCoveragePercentThreshold: 60 }).current;
  const changed = useCallback(({ viewableItems }: { viewableItems: { index?: number | null }[] }) => {
    const next = viewableItems[0]?.index;
    setIndex(next ?? -1);
  }, []);
  return <View style={styles.clips} onLayout={event => setHeight(Math.floor(event.nativeEvent.layout.height))}>
    {height > 0 && <FlatList data={posts} keyExtractor={item => item.id} pagingEnabled snapToInterval={height}
      showsVerticalScrollIndicator={false} onViewableItemsChanged={changed} viewabilityConfig={viewConfig}
      onEndReached={more} onEndReachedThreshold={0.6} ListFooterComponent={footer} windowSize={3}
      getItemLayout={(_, i) => ({ offset: height * i, length: height, index: i })}
      renderItem={({ item, index: i }) => <Clip post={item} height={height} active={index === i} focused={focused} reducedMotion={reducedMotion} muted={muted}
        toggleSound={() => setMuted(s => !s)} />} />}
  </View>;
}

function Clip({ post, height, active, focused, reducedMotion, muted, toggleSound }: {
  post: Post; height: number; active: boolean; focused: boolean; reducedMotion: boolean; muted: boolean; toggleSound: () => void;
}) {
  const nav = useNav();
  const [override, setOverride] = useState<boolean>();
  const playing = override ?? !reducedMotion;
  const actions = useReviewActions(post);
  const openReview = () => nav.push('Review', { id: post.id });
  return <View style={[styles.clip, { height }]}>
    {active && post.media
      ? <ClipPlayer media={post.media} playing={playing} enabled={focused} muted={muted} />
      : <Photo media={post.media} fallback={post.restaurant.cover} style={StyleSheet.absoluteFill} />}
    <LinearGradient pointerEvents="none" colors={['#100D0860', 'transparent', '#100D08EB']} locations={[0, 0.45, 1]} style={StyleSheet.absoluteFill} />
    <View style={styles.clipTop}>
      <IButton icon={muted ? VolumeX : Volume2} label={muted ? 'Unmute clip' : 'Mute clip'} color={colors.white} style={styles.clipButton} onPress={toggleSound} />
      <IButton icon={playing ? Pause : Play} label={playing ? 'Pause playback' : 'Play clip'} color={colors.white} style={styles.clipButton} onPress={() => setOverride(!playing)} />
    </View>
    <View style={styles.clipsBottom}>
      <View style={styles.clipDetails}>
        <Author person={post.author} light />
        <Tap onPress={() => nav.push('Place', { id: post.restaurant.id })} accessibilityLabel={'Open ' + post.restaurant.name}>
          <T kind="title" color={colors.white} numberOfLines={2}>{post.restaurant.name}</T>
          <T kind="label" color="#FFF1D9" numberOfLines={1}>{placeLabel(post.restaurant)}</T>
        </Tap>
        {post.dish ? <Tap style={styles.clipLink} onPress={() => nav.popTo('Main', { tab: 'explore', exploreQuery: post.dish })}>
          <Search color={colors.white} size={16} /><T kind="label" color={colors.white} numberOfLines={1}>Find {post.dish}</T>
        </Tap> : null}
        <Tap style={styles.clipLink} onPress={openReview}>
          <T kind="label" color={colors.white}>Read full review</T>
        </Tap>
        <View style={styles.clipScore}><Score value={post.score} emphasized label="Diner’s rating" /></View>
      </View>
      <View style={styles.clipActions}>
        <IButton icon={Heart} label={actions.liked ? 'Unlike clip' : 'Like clip'} color="#FFFFFF" fill={actions.liked ? '#ED7C74' : undefined} style={styles.clipButton} onPress={actions.like} />
        <T kind="small" color={colors.white}>{actions.count}</T>
        <IButton icon={MessageCircle} label="Clip comments" color="#FFFFFF" style={styles.clipButton} onPress={openReview} />
        <T kind="small" color={colors.white}>{post.comments}</T>
        <SaveButton inverse place={post.restaurant} />
        <IButton icon={Share2} label="Share clip" color="#FFFFFF" style={styles.clipButton} onPress={actions.share} />
      </View>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingTop: 7, paddingBottom: 13, gap: 9 },
  masthead: { minHeight: 47, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  titleLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  location: { backgroundColor: colors.white, minHeight: 44, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center',
    borderWidth: 1, borderColor: colors.line, borderRadius: 21, gap: 5, flexShrink: 1 },
  activity: { alignSelf: 'center' },
  bell: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  dot: { position: 'absolute', top: 7, right: 8, width: 8, height: 8, borderRadius: 5, borderWidth: 1.5, borderColor: colors.white, backgroundColor: '#CC6B42' },
  feed: { paddingHorizontal: 20, paddingBottom: 18, gap: 12 },
  feedItem: { paddingBottom: 2, gap: 12 },
  trending: { gap: 3, paddingBottom: 4 },
  tiles: { gap: 10, paddingBottom: 2 },
  clips: { flex: 1, backgroundColor: colors.dark },
  clip: { position: 'relative', backgroundColor: colors.dark, overflow: 'hidden' },
  clipLink: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start' },
  clipTop: { position: 'absolute', top: 12, right: 15, flexDirection: 'row', gap: 6 },
  clipButton: { backgroundColor: '#16130FB3', borderWidth: 1, borderColor: '#FFFFFF45' },
  clipsBottom: { position: 'absolute', bottom: 15, left: 16, right: 16, flexDirection: 'row', gap: 15, alignItems: 'flex-end' },
  clipDetails: { flex: 1, gap: 8 },
  clipScore: { flexDirection: 'row' },
  clipActions: { gap: 5, alignItems: 'center' },
});
