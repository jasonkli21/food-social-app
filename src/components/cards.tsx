import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { ArrowUpRight, Bookmark, ChevronRight, Flame, Heart, MessageCircle, MoreHorizontal, Play, Share2, Star } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import type { Person, Place, Post } from '../types';
import { useApp, useMember } from '../state';
import { useTask } from '../hooks';
import { useNav } from '../navigation';
import { colors } from '../theme';
import { shareContent } from '../links';
import { Photo } from './media';
import { Avatar, IButton, T, Tap, type Icon } from './ui';

export function timeAgo(from: string) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(from).getTime()) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return minutes + 'm ago';
  if (minutes < 1440) return Math.floor(minutes / 60) + 'h ago';
  const days = Math.floor(minutes / 1440);
  if (days < 7) return days + 'd ago';
  return new Date(from).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function priceLabel(price: number | null) {
  return price ? '$'.repeat(price) : '';
}

export function placeLabel(place: Place) {
  return [place.cuisine, place.area || place.city, priceLabel(place.price)].filter(Boolean).join('  ·  ');
}

export function Score({ value, emphasized, label = 'Rating' }: { value: number; emphasized?: boolean; label?: string }) {
  return <View accessible accessibilityLabel={label + ' ' + value.toFixed(1) + ' out of 10'}
    style={[styles.score, emphasized && styles.heroScore]}>
    <Star size={emphasized ? 15 : 12} color={emphasized ? colors.ink : colors.green} fill={emphasized ? colors.ink : colors.green} strokeWidth={1.5} />
    <T kind="label" color={emphasized ? colors.ink : colors.green} style={emphasized && { fontSize: 16 }}>{value.toFixed(1)}</T>
  </View>;
}

export function useReviewActions(post: Post) {
  const { api, likedState, showLiked, toast } = useApp();
  const member = useMember();
  const task = useTask();
  const liked = likedState[post.id] ?? post.liked;
  return {
    liked, count: post.likes + Number(liked) - Number(post.liked),
    like: () => {
      if (member()) void task.run(async () => {
        await api.like(post.id, !liked);
        showLiked(post.id, !liked);
      });
    },
    share: () => void task.run(async () => {
      if (await shareContent('review', post.id, 'A review of ' + post.restaurant.name)) toast('Review copied');
    }),
  };
}

export function SaveButton({ place, inverse }: { place: Place; inverse?: boolean }) {
  const { api, invalidate, savedState, showSaved, toast } = useApp();
  const member = useMember();
  const task = useTask();
  const saved = savedState[place.id] ?? place.saved;
  if (place.status !== 'published') return null;
  return <IButton icon={Bookmark} label={saved ? 'Remove ' + place.name + ' from saved' : 'Save ' + place.name}
    active={saved} fill={saved ? colors.green : undefined} color={saved ? colors.green : colors.ink}
    style={inverse ? styles.photoButton : undefined}
    onPress={() => {
      if (!member()) return;
      void task.run(async () => {
        await api.save(place.id, !saved);
        showSaved(place.id, !saved);
        invalidate('saved');
        toast(saved ? 'Removed from your want-to-go list' : 'Saved to your want-to-go list');
      });
    }} />;
}

export function Author({ person, detail, children, light }: { person: Person; detail?: string; children?: ReactNode; light?: boolean }) {
  const nav = useNav();
  return <View style={styles.authorLine}>
    <Tap onPress={() => nav.push('Person', { id: person.id })} accessibilityLabel={'View ' + person.name + '’s profile'} style={styles.author}>
      <Avatar person={person} />
      <View style={{ flexShrink: 1 }}>
        <T kind="strong" color={light ? colors.white : colors.ink} numberOfLines={1}>{person.name}</T>
        <T kind="small" color={light ? '#FFF1D9' : colors.muted} numberOfLines={1}>@{person.handle}{detail ? '  ·  ' + detail : ''}</T>
      </View>
    </Tap>
    {children}
  </View>;
}

export function Reaction({ icon: Glyph, label, count, colored, onPress }: {
  icon: Icon; label: string; count?: number; colored?: boolean; onPress: () => void;
}) {
  return <Tap accessibilityLabel={label + (count === undefined ? '' : ', ' + count)} onPress={onPress} style={styles.reaction}>
    <Glyph size={21} strokeWidth={1.7} color={colored ? '#A83C37' : colors.ink} fill={colored ? '#A83C37' : 'none'} />
    {count !== undefined && <T kind="label" color={colors.muted}>{count}</T>}
  </Tap>;
}

export function ReviewCard({ post, compact, imageHeight = 326 }: { post: Post; compact?: boolean; imageHeight?: number }) {
  const nav = useNav();
  const action = useReviewActions(post);
  const venue = post.restaurant;
  const hasImage = post.media || venue.cover;
  const showHero = !compact && hasImage;
  const openPost = () => nav.push('Review', { id: post.id });
  const openPlace = () => nav.push('Place', { id: venue.id });
  return <View style={styles.card}>
    {showHero && <View style={[styles.hero, { height: imageHeight }]}>
      <Tap accessibilityLabel={'View ' + venue.name} onPress={openPlace} style={StyleSheet.absoluteFill}>
        <Photo media={post.media} fallback={venue.cover} style={StyleSheet.absoluteFill}
          privateMedia={post.status === 'pending'} />
        <LinearGradient colors={['rgba(23,16,10,0.21)', 'transparent', 'rgba(23,16,10,0.87)']} locations={[0, 0.37, 1]} style={StyleSheet.absoluteFill} />
        <View style={styles.heroText}>
          <View style={{ flex: 1 }}>
            <T kind="title" color="#FFF8EE" numberOfLines={2} style={styles.heroName}>{venue.name}</T>
            <T kind="label" color="#FAEEDD" numberOfLines={2}>{placeLabel(venue)}</T>
          </View>
          <Score value={post.score} emphasized label="Diner’s rating" />
        </View>
      </Tap>
      <View pointerEvents="box-none" style={styles.heroTop}>
        {post.media?.kind === 'video'
          ? <Tap onPress={openPost} style={styles.hot}><Play size={14} color={colors.white} /><T kind="small" color={colors.white}>Watch clip</T></Tap>
          : post.likes >= 20
            ? <View style={styles.hot}><Flame size={14} color={colors.gold} fill={colors.gold} /><T kind="small" color={colors.white}>Popular review</T></View>
            : <View />}
        <SaveButton place={venue} inverse />
      </View>
    </View>}
    <View style={styles.postBody}>
      <Author person={post.author} detail={timeAgo(post.createdAt)}>
        <IButton icon={MoreHorizontal} label="Open review options" onPress={openPost} />
      </Author>
      {!showHero && <Tap onPress={openPlace} style={styles.textVenue} accessibilityLabel={'View ' + venue.name}>
        {compact && hasImage && <Photo media={post.media} fallback={venue.cover} style={styles.compactPhoto} privateMedia={post.status === 'pending'} />}
        <View style={{ flex: 1 }}>
          <T kind="section">{venue.name}</T>
          <T kind="small" color={colors.muted}>{placeLabel(venue)}</T>
        </View>
        <Score value={post.score} label="Diner’s rating" />
      </Tap>}
      {post.status !== 'published' && <T kind="small" color={colors.green}>{post.status === 'pending' ? 'Awaiting moderation' : 'Hidden by moderation'}</T>}
      <Tap accessibilityLabel={'Read review of ' + venue.name + (post.dish ? ', ' + post.dish : '') + '. ' + post.text.slice(0, 120)} onPress={openPost}>
        <T numberOfLines={2} style={styles.reviewText}>
          {post.dish ? <T kind="strong">{post.dish + '. '}</T> : null}{post.text}
        </T>
      </Tap>
      {post.status === 'published' && <View style={styles.actions}>
        <Reaction icon={Heart} colored={action.liked} label={action.liked ? 'Unlike review' : 'Like review'} count={action.count} onPress={action.like} />
        <Reaction icon={MessageCircle} count={post.comments} label="Open comments" onPress={openPost} />
        <View style={{ flex: 1 }} />
        <IButton icon={Share2} label="Share review" onPress={action.share} />
      </View>}
    </View>
  </View>;
}

export function PlaceRow({ place, onPress, leading, trailing, saves }: {
  place: Place; onPress?: () => void; leading?: ReactNode; trailing?: ReactNode; saves?: boolean;
}) {
  const nav = useNav();
  return <View style={styles.placeRow}>
    <Tap onPress={onPress ?? (() => nav.push('Place', { id: place.id }))} style={styles.placeMain} accessibilityLabel={'View ' + place.name} accessibilityHint={placeLabel(place) + (place.score == null ? '' : ', community rating ' + place.score + ' out of 10')}>
      {leading}
      <Photo media={place.cover} style={styles.placeImage} />
      <View style={{ flex: 1 }}>
        <T kind="strong" numberOfLines={2}>{place.name}</T>
        <T kind="small" color={colors.muted} numberOfLines={2}>{placeLabel(place)}</T>
        {place.distanceKm != null && <T kind="small" color={colors.green}>{place.distanceKm < 1 ? Math.round(place.distanceKm * 1000) + ' m' : place.distanceKm.toFixed(1) + ' km'} away</T>}
      </View>
      {place.score != null && <Score value={place.score} label="Community rating" />}
    </Tap>
    {trailing ?? (saves ? <SaveButton place={place} /> : <ChevronRight size={17} color={colors.faint} />)}
  </View>;
}

export function PlaceTile({ place }: { place: Place }) {
  const nav = useNav();
  return <Tap onPress={() => nav.push('Place', { id: place.id })} style={styles.tile} accessibilityLabel={'View ' + place.name} accessibilityHint={placeLabel(place) + (place.score == null ? '' : ', community rating ' + place.score + ' out of 10')}>
    <Photo media={place.cover} style={styles.tileImage} />
    <View style={styles.tileBody}>
      <View style={{ flex: 1 }}>
        <T kind="strong" numberOfLines={1}>{place.name}</T>
        <T kind="small" color={colors.muted} numberOfLines={1}>{place.area || place.city}</T>
      </View>
      <ArrowUpRight size={16} color={colors.green} />
    </View>
  </Tap>;
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: colors.line, borderRadius: 24, overflow: 'hidden', backgroundColor: colors.white },
  hero: { position: 'relative', backgroundColor: colors.dark },
  heroTop: { position: 'absolute', top: 12, left: 12, right: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  hot: { minHeight: 44, paddingHorizontal: 10, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 6,
    borderRadius: 18, borderWidth: 1, borderColor: '#FFFFFF40', backgroundColor: '#24160BB0' },
  heroText: { position: 'absolute', left: 17, right: 16, bottom: 17, flexDirection: 'row', alignItems: 'flex-end', gap: 12 },
  heroName: { fontSize: 43, lineHeight: 46 },
  photoButton: { backgroundColor: '#FFF8EA', width: 44, height: 44, borderRadius: 22 },
  score: { flexShrink: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4,
    backgroundColor: colors.greenWash, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 16 },
  heroScore: { backgroundColor: colors.gold, paddingHorizontal: 11, paddingVertical: 8, borderRadius: 12, marginBottom: 2 },
  authorLine: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 6 },
  author: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 9, minHeight: 44 },
  postBody: { paddingTop: 9, paddingHorizontal: 13, paddingBottom: 3, gap: 5 },
  reviewText: { paddingVertical: 3, color: colors.ink },
  textVenue: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  compactPhoto: { width: 50, height: 50, borderRadius: 10 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  reaction: { minWidth: 44, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 7, paddingRight: 5 },
  placeRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 10,
    paddingVertical: 9, borderWidth: 1, borderColor: colors.line, borderRadius: 17, backgroundColor: colors.white },
  placeMain: { flexDirection: 'row', flex: 1, gap: 11, alignItems: 'center', minHeight: 62 },
  placeImage: { width: 66, height: 66, borderRadius: 12 },
  tile: { width: 154, borderRadius: 15, borderWidth: 1, borderColor: colors.line, overflow: 'hidden', backgroundColor: colors.white },
  tileImage: { height: 87 },
  tileBody: { flexDirection: 'row', gap: 4, alignItems: 'center', paddingHorizontal: 9, paddingVertical: 7 },
});
