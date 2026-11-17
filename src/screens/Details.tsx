import { useRef, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { ArrowRightLeft, ArrowUpRight, BadgeCheck, Clock3, Flag, Globe, Heart, MapPin, MessageCircle, Navigation, Pencil, Phone, Search, Send, Share2, Store, Trash2, Utensils } from 'lucide-react-native';
import { randomUUID } from 'expo-crypto';
import { periodText } from '../hours';
import { ServiceError } from '../services/client';
import { useIsFocused } from '@react-navigation/native';
import { useNav, type Props } from '../navigation';
import { useApp, useMember } from '../state';
import { useData, usePage, useTask } from '../hooks';
import { colors } from '../theme';
import { mapURL, openLink, shareContent } from '../links';
import { Author, placeLabel, PlaceRow, Reaction, ReviewCard, SaveButton, Score, timeAgo, useReviewActions } from '../components/cards';
import { ClipPlayer, Photo } from '../components/media';
import { Avatar, Button, Empty, Field, IButton, Issue, ListEnd, Loading, Screen, Section, T, Tap } from '../components/ui';
import type { Post } from '../types';
import { RestaurantResponse } from './Owner';

export function PlaceScreen({ navigation: nav, route }: Props<'Place'>) {
  const { id } = route.params;
  const { api, isDemo, toast } = useApp();
  const member = useMember();
  const task = useTask();
  const data = useData('place:' + id, signal => api.place(id, signal));
  const place = data.data;
  const reviews = usePage('place-reviews:' + id, (offset,read) => api.placeReviews(id, offset,read), place?.status === 'published');
  const mine = place?.myReview;
  const [showExceptions, setShowExceptions] = useState(false);

  return <Screen title="Restaurant" scroll={false} trailing={place?.status === 'published' && <IButton icon={Share2} label="Share restaurant" onPress={() => {
    void task.run(async () => { if (await shareContent('place', id, place.name)) toast('Restaurant copied'); });
  }} />}>
    <FlatList data={place?.status === 'published' ? reviews.items : []} keyExtractor={review => review.id}
      contentContainerStyle={{ padding: 20, gap: 12 }}
      ListHeaderComponent={<>
    {data.error && <Issue message={data.error} retry={data.reload} />}
    {!place ? data.loading && <Loading /> : <>
      <Photo media={place.cover} style={styles.placeHero} label={place.name + ' food'} />
      <View style={styles.headline}>
        <View style={{ flex: 1 }}>
          <T kind="display" accessibilityRole="header">{place.name}</T>
          <T color={colors.muted}>{placeLabel(place)}</T>
        </View>
        <SaveButton place={place} inverse />
      </View>
      {place.status === 'pending' ? <View style={styles.notice}><T kind="label" color={colors.green}>Awaiting moderation</T>
        <T color={colors.green}>Your suggestion will join the directory after it’s reviewed.</T></View>
        : <View style={styles.rating}>
          {place.score !== null && <Score value={place.score} emphasized label="Community rating" />}
          <View>
            <T kind="strong">Community rating</T>
            <T kind="small" color={colors.muted}>{place.ratingCount === 0 ? 'No reviews yet' : place.ratingCount + (place.ratingCount === 1 ? ' review' : ' reviews')}</T>
          </View>
        </View>}
      {place.managed && <View style={styles.listingBadge}><BadgeCheck size={17} color={colors.green} />
        <View style={{ flex: 1 }}>
          <T kind="label" color={colors.green}>Restaurant-managed listing</T>
          {place.listingUpdatedAt && <T kind="small" color={colors.muted}>Listing details updated {new Date(place.listingUpdatedAt).toLocaleDateString()}</T>}
        </View>
      </View>}
      {place.description ? <T>{place.description}</T> : null}
      {isDemo && <T kind="small" color={colors.muted}>Sample restaurant</T>}
      <View style={styles.contact}>
        <Tap style={styles.infoLine} onPress={() => void task.run(() => openLink(mapURL(place, true)))}>
          <MapPin color={colors.green} size={23} strokeWidth={1.7} />
          <View style={{ flex: 1 }}><T kind="strong">{place.address}</T><T kind="small" color={colors.muted}>{place.city}</T></View>
          <Navigation color={colors.green} size={19} strokeWidth={1.8} />
        </Tap>
        <View style={[styles.infoLine, styles.infoBorder]}>
          <Clock3 color={colors.green} size={22} strokeWidth={1.7} />
          <View style={{ flex: 1, gap: 3 }}><T kind="strong">{place.hoursStatus?.state === 'open' ? 'Open now' : place.hoursStatus?.state === 'closed' ? 'Closed' : 'Hours provided'}</T>
            {place.schedule && <T kind="small" color={colors.muted}>{place.schedule.timezone} · Restaurant-supplied hours</T>}
            {place.hours.length ? place.hours.map((line, i) =>
            <T key={i} kind="label" color={colors.muted}>{line}</T>) : <T kind="label" color={colors.muted}>Hours unavailable</T>}
            {!!place.schedule?.exceptions.length && <>
              <Button title={showExceptions ? 'Hide date-specific hours' : 'Date-specific hours'} mode="line" onPress={() => setShowExceptions(value => !value)} />
              {showExceptions && place.schedule.exceptions.map(exception => <T key={exception.date} kind="small" color={colors.muted}>
                {exception.date} · {periodText(exception.periods)}
              </T>)}
            </>}
          </View>
        </View>
        {!!place.website && <Tap style={[styles.infoLine, styles.infoBorder]} onPress={() => void task.run(() => openLink(place.website))}>
          <Globe color={colors.green} size={22} /><T kind="strong" style={{ flex: 1 }}>Website</T><ArrowUpRight color={colors.green} size={18} />
        </Tap>}
        {!!place.menuURL && <Tap style={[styles.infoLine, styles.infoBorder]} onPress={() => void task.run(() => openLink(place.menuURL))}>
          <Utensils color={colors.green} size={22} /><T kind="strong" style={{ flex: 1 }}>Menu</T><ArrowUpRight color={colors.green} size={18} />
        </Tap>}
        {!!place.phone && <Tap style={[styles.infoLine, styles.infoBorder]} onPress={() => void task.run(() => openLink('tel:' + place.phone.replace(/[^+0-9]/g, '')))}>
          <Phone color={colors.green} size={22} /><T kind="strong">{place.phone}</T>
        </Tap>}
      </View>
      {place.dietary.length > 0 && <View style={styles.tags}>
        {place.dietary.map((tag, i) => <View key={i} style={styles.tag}><T kind="label" color={colors.green}>{tag}</T></View>)}
      </View>}
      {place.status === 'published' && <>
        <Button title="Your visits" mode="line" onPress={() => { if (member()) nav.push('Journal', { placeId: id }); }} />
        <Button title="Add private visit" mode="line" onPress={() => { if (member()) nav.push('Compose', { placeId: id, mode: 'memory' }); }} />
        {place.canManage ? <Button icon={Store} title="Manage restaurant" onPress={() => nav.push('Manage', { id })} />
          : <Button title={mine?.status === 'pending' || mine?.ownershipConflict ? 'View my review' : mine ? 'Edit my review' : 'Log a visit'} icon={Pencil} onPress={() => {
          if (!member()) return;
          if (mine?.status === 'pending' || mine?.ownershipConflict) nav.push('Review', { id: mine.id });
          else nav.push('Compose', mine ? { postId: mine.id } : { placeId: place.id, mode: 'review' });
        }} />}
        <Section title="Reviews" />
        {reviews.error && <Issue message={reviews.error} retry={reviews.reload} />}
        {reviews.loading && reviews.items.length === 0 && <Loading />}
        {!reviews.loading && !reviews.error && !reviews.items.length && <Empty icon={Utensils} title="Be the first to review" />}
      </>}
    </>}
      </>}
      renderItem={({ item }) => <ReviewCard compact post={item} />}
      ListFooterComponent={place?.status === 'published' ? <>
        <ListEnd state={reviews} />
        {!place.managed && <Button title="Claim this restaurant" icon={Store} mode="line" onPress={() => {
          if (member()) nav.push('Claim', { id });
        }} />}
        <Button title="Report restaurant details" icon={Flag} mode="line" onPress={() => {
          if (member()) nav.push('Report', { kind: 'place', id, revision: String(place.listingRevision) });
        }} />
      </> : undefined}
      onEndReached={() => { if (!reviews.moreError) void reviews.more(); }} onEndReachedThreshold={0.4}
    />
  </Screen>;
}

export function ReviewScreen({ route }: Props<'Review'>) {
  const { api } = useApp();
  const id = route.params.id;
  const data = useData('post:' + id, signal => api.post(id,signal));
  return <Screen title="Review" form>
    {data.error && <Issue message={data.error} retry={data.reload} />}
    {data.data ? <ReviewBody post={data.data} justPosted={route.params.justPosted} reload={data.reload} /> : data.loading && <Loading />}
  </Screen>;
}

function ReviewBody({ post, justPosted, reload }: { post: Post; justPosted?: boolean; reload: () => void }) {
  const nav = useNav();
  const { api, signedIn, invalidate, confirm, toast } = useApp();
  const member = useMember();
  const focused = useIsFocused();
  const action = useReviewActions(post);
  const task = useTask();
  const me = useData('profile:me', signal => api.me(signal), signedIn);
  const comments = usePage('comments:' + post.id, (offset,read) => api.comments(post.id, offset,read), post.status === 'published');
  const [draft, setDraft] = useState('');
  const commentVersion = useRef(0);
  const pendingComment = useRef<{ text: string; id: string; version: number } | undefined>(undefined);
  const mine = me.data?.id === post.author.id;
  const prior = useData('ranked:available:' + post.id, signal => api.ranked(0, { signal }), Boolean(mine && justPosted && post.status !== 'hidden'));
  const canCompare = Boolean(justPosted && mine && prior.data?.items.some(visit => visit.id !== post.id));
  const add = () => {
    if (!member() || !draft.trim()) return;
    void task.run(async () => {
      const submitted = pendingComment.current ?? { text: draft.trim(), id: randomUUID(), version: commentVersion.current };
      pendingComment.current = submitted;
      try {
        await api.addComment(post.id, submitted.text, submitted.id);
      } catch (error) {
        if (error instanceof ServiceError && error.status >= 400 && error.status < 500 && error.status !== 408) pendingComment.current = undefined;
        throw error;
      }
      pendingComment.current = undefined;
      if (commentVersion.current === submitted.version) setDraft('');
      invalidate('comments:' + post.id);
      reload();
    }, true);
  };

  return <>
    <Author person={post.author} detail={timeAgo(post.createdAt)}><Score value={post.score} emphasized label="Diner’s rating" /></Author>
    {post.status !== 'published' && <View style={styles.notice}>
      <T kind="label" color={colors.green}>{post.status === 'pending' ? 'Awaiting moderation' : 'Hidden by moderation'}</T>
      <T color={colors.green}>{post.status === 'pending' ? 'This review is visible to you while it’s checked.' : post.ownershipConflict ? 'A moderator can restore this review after the ownership conflict is resolved.' : 'You can edit this review and submit it again.'}</T>
    </View>}
    {post.media?.kind === 'photo' && <Photo media={post.media} style={styles.placeHero} privateMedia={post.status === 'pending'} label={post.dish || 'Food photo'} />}
    {post.media?.kind === 'video' && <View style={styles.video}><ClipPlayer media={post.media} playing={false} enabled={focused} muted controls privateMedia={post.status === 'pending'} /></View>}
    <PlaceRow place={post.restaurant} saves />
    {!!post.dish && <View>
      <T kind="heading">{post.dish}</T>
      <Tap style={styles.dishShortcut} onPress={() => nav.popTo('Main', { tab: 'explore', exploreQuery: post.dish })}>
        <Search size={17} color={colors.green} /><T kind="label" color={colors.green}>Find this dish</T>
      </Tap>
    </View>}
    <T style={styles.fullReview}>{post.text}</T>
    {canCompare && <Button mode="line" title="Compare with a past visit" icon={ArrowRightLeft}
      onPress={() => nav.push('Compare', { visitId: post.id })} />}
    {post.status === 'published' && <View style={styles.reviewActions}>
      <Reaction icon={Heart} label={action.liked ? 'Unlike review' : 'Like review'} count={action.count} colored={action.liked} onPress={action.like} />
      <IButton icon={Share2} label="Share review" onPress={action.share} />
      <View style={{ flex: 1 }} />
      {!mine && <IButton icon={Flag} label="Report review" onPress={() => {
        if (member()) nav.push('Report', { kind: 'post', id: post.id, revision: post.revision });
      }} />}
    </View>}
    {mine && <View style={styles.reviewActions}>
      {!post.restaurant.canManage && !post.ownershipConflict && <Button icon={Pencil} title="Edit review" mode="line" style={{ flex: 1 }} onPress={() => nav.push('Compose', { postId: post.id })} />}
      <IButton icon={Trash2} label="Delete review" color={colors.danger} onPress={() => {
        void task.run(async () => {
          if (await confirm('Delete this review?', 'Your review, reactions, and comments will be removed.', 'Delete', true)) {
            await api.deletePost(post.id, post.revision);
            invalidate('feed','directory','ranked','profile','place:' + post.restaurant.id, 'place-reviews:' + post.restaurant.id);
            toast('Review deleted');
            if (nav.canGoBack()) nav.goBack(); else nav.navigate('Main');
          }
        });
      }} />
    </View>}
    <RestaurantResponse post={post} reload={reload} />
    {post.status === 'published' && <>
      <Section title="Comments" />
      {!signedIn ? <Button title="Sign in to comment" mode="line" icon={MessageCircle} onPress={member} /> :
        <View style={styles.commentForm}>
          <View style={{ flex: 1 }}><Field label="Add a comment" placeholder="What would you order?" value={draft} maxLength={600}
            onChangeText={value => { setDraft(value); commentVersion.current++; }} multiline style={{ minHeight: 70 }} /></View>
          <Button icon={Send} title={pendingComment.current && task.error ? 'Retry comment' : 'Post'} busy={task.busy} disabled={!draft.trim() && !pendingComment.current} onPress={add} />
        </View>}
      {task.error ? <Issue message={task.error} /> : null}
      {comments.error && <Issue message={comments.error} retry={comments.reload} />}
      {comments.loading && comments.items.length === 0 && <Loading />}
      {comments.items.map(comment => <View key={comment.id} style={styles.comment}>
        <Tap accessibilityLabel={'View ' + comment.author.name} onPress={() => nav.push('Person', { id: comment.author.id })}><Avatar person={comment.author} size={34} /></Tap>
        <View style={{ flex: 1, gap: 3 }}>
          <T kind="strong">{comment.author.name} <T kind="small" color={colors.muted}>· {timeAgo(comment.createdAt)}</T></T>
          <T>{comment.text}</T>
        </View>
        {comment.author.id === me.data?.id
          ? <IButton label="Delete comment" color={colors.danger} icon={Trash2} onPress={() => {
            void task.run(async () => {
              if (await confirm('Delete this comment?', 'It will be removed from the conversation.', 'Delete', true)) {
                await api.deleteComment(comment.id);
                invalidate('comments:' + post.id);
                reload();
              }
            });
          }} />
          : <IButton label="Report comment" color={colors.muted} icon={Flag} onPress={() => {
            if (member()) nav.push('Report', { kind: 'comment', id: comment.id });
          }} />}
      </View>)}
      {!comments.loading && !comments.error && !comments.items.length && <T color={colors.muted}>No comments yet.</T>}
      <ListEnd state={comments} />
    </>}
  </>;
}


const styles = StyleSheet.create({
  placeHero: { height: 232, borderRadius: 22 },
  headline: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  rating: { minHeight: 66, backgroundColor: colors.greenWash, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16,
    flexDirection: 'row', alignItems: 'center', gap: 12 },
  notice: { gap: 4, backgroundColor: colors.greenWash, borderRadius: 13, padding: 12 },
  listingBadge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  contact: { borderWidth: 1, borderColor: colors.line, borderRadius: 16, backgroundColor: colors.white, overflow: 'hidden' },
  infoLine: { flexDirection: 'row', gap: 11, alignItems: 'flex-start', minHeight: 49, padding: 13 },
  infoBorder: { borderTopWidth: 1, borderTopColor: colors.line },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  tag: { borderRadius: 12, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: colors.greenWash },
  video: { height: 400, borderRadius: 17, overflow: 'hidden', backgroundColor: colors.dark },
  dishShortcut: { minHeight: 44, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 7 },
  fullReview: { fontSize: 17, lineHeight: 25 },
  reviewActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  commentForm: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  comment: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 11, borderRadius: 15, backgroundColor: colors.white,
    borderWidth: 1, borderColor: colors.line },
});
