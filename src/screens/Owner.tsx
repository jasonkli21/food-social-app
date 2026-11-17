import { useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { BadgeCheck, CirclePlus, ClipboardList, Flag, MapPin, MessageCircle, Pencil, RefreshCw, Search, Send, Sparkles, Store, Trash2 } from 'lucide-react-native';
import { useNav, type Props } from '../navigation';
import { useApp, useMember } from '../state';
import { useData, usePage, useTask } from '../hooks';
import { colors } from '../theme';
import { PlaceRow, ReviewCard, Score, timeAgo } from '../components/cards';
import { Photo } from '../components/media';
import { Button, Chip, Empty, Field, IButton, Issue, ListEnd, Loading, Screen, Section, Segment, T } from '../components/ui';
import type { ClaimRole, ClaimStatus, HoursPreview, ListingEdit, Place, Post, ReplyDraft, ReplyTone } from '../types';
import { HoursEditor, scheduleFields, scheduleValue } from '../components/HoursEditor';
import { legacyHours } from '../hours';

const statusLabels: Record<ClaimStatus, string> = {
  approved: 'Verified',
  pending: 'Verification pending',
  declined: 'Couldn’t verify',
  revoked: 'Access removed',
};

export function OwnerToolsScreen() {
  const nav = useNav();
  const { api, signedIn, isDemo } = useApp();
  const member = useMember();
  const claims = usePage('claims', (offset,read) => api.myRestaurants(offset,read), signedIn);
  return <Screen title="Restaurant tools" trailing={signedIn && <IButton icon={RefreshCw} label="Refresh claim status" onPress={claims.reload} />}>
    <View style={styles.intro}>
      <View style={styles.badge}><Store size={24} color={colors.green} strokeWidth={1.8} /></View>
      <T kind="title">Your restaurants</T>
      <T color={colors.muted}>Keep your information up to date and respond to the people who visit.</T>
    </View>
    {!signedIn ? <Button title="Sign in to manage a listing" onPress={member} /> : <>
      {claims.error && <Issue message={claims.error} retry={claims.reload} />}
      {claims.loading && !claims.items.length && <Loading />}
      {claims.items.map(claim => <View style={styles.claim} key={claim.id}>
        <View style={styles.status}>
          {claim.status === 'approved' ? <BadgeCheck size={17} color={colors.green} /> : <ClipboardList size={17} color={colors.green} />}
          <T kind="label" color={colors.green}>{statusLabels[claim.status]}</T>
        </View>
        <PlaceRow place={claim.place} onPress={() => claim.status === 'approved' && claim.place.canManage
          ? nav.push('Manage', { id: claim.place.id }) : nav.push('Place', { id: claim.place.id })} />
        {claim.note ? <T kind="small" color={colors.muted}>{claim.note}</T> : null}
        {claim.status === 'pending' && <T kind="small" color={colors.muted}>{isDemo
          ? 'Sample claim saved on this device.'
          : 'We’ll use the restaurant’s public business details to confirm your role.'}</T>}
        {(claim.status === 'declined' || claim.status === 'revoked') && !claim.place.managed
          && <Button title="Try verification again" mode="line" onPress={() => nav.push('Claim', { id: claim.place.id })} />}
      </View>)}
      <ListEnd state={claims} />
      <Button icon={Search} title="Find a listing to claim" onPress={() => nav.popTo('Main', { tab: 'explore' })} />
      <Button icon={CirclePlus} title="Suggest a missing restaurant" mode="line" onPress={() => nav.push('AddPlace')} />
    </>}
  </Screen>;
}

export function ClaimScreen({ navigation: nav, route }: Props<'Claim'>) {
  const { id } = route.params;
  const { api, invalidate, toast, isDemo } = useApp();
  const member = useMember();
  const data = useData('place:claim:' + id, signal => api.place(id,signal));
  const task = useTask();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ClaimRole>();
  const place = data.data;
  const roles: ClaimRole[] = ['Owner', 'General manager', 'Authorized staff'];
  return <Screen title="Claim this restaurant" close form>
    {data.error && <Issue message={data.error} retry={data.reload} />}
    {place ? <>
      <T kind="title">{place.name}</T>
      <PlaceRow place={place} onPress={() => nav.goBack()} />
      {place.managed || place.status !== 'published' ? <Issue message="This listing is unavailable for claiming." /> : <>
        <T>Tell us your role and where we can reach you. The business email is visible to the team reviewing your claim.</T>
        <Field label="Business email" value={email} onChangeText={setEmail} autoCapitalize="none"
          autoCorrect={false} keyboardType="email-address" autoComplete="email" maxLength={254} />
        <T kind="label">Your role</T>
        <View style={styles.wrap}>
          {roles.map(item => <Chip key={item} title={item} active={item === role} onPress={() => setRole(item)} />)}
        </View>
        <T kind="small" color={colors.muted}>{isDemo ? 'Use a sample email to try the claim flow.'
          : 'The team will check your request with the restaurant before granting access.'}</T>
        {task.error && <Issue message={task.error} />}
        <Button icon={Send} title="Submit claim" busy={task.busy} disabled={!role || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())} onPress={() => {
          if (!role || !member()) return;
          void task.run(async () => {
            await api.claimRestaurant(id, email.trim(), role);
            invalidate('claims');
            toast('Claim submitted for verification');
            nav.replace('OwnerTools');
          }, true);
        }} />
      </>}
    </> : data.loading && <Loading />}
  </Screen>;
}

export function ManageScreen({ navigation: nav, route }: Props<'Manage'>) {
  const { id } = route.params;
  const { api } = useApp();
  const data = useData('place:' + id, signal => api.place(id,signal));
  const place = data.data;
  const [filter, setFilter] = useState<'all' | 'unanswered'>('all');
  const page = usePage('owner:' + id + ':' + filter, (offset,read) => api.ownerReviews(id, filter === 'unanswered', offset, read), !!place?.canManage);
  const reviews = page.items.filter(p => p.status === 'published');
  return <Screen title="Manage restaurant" scroll={false}>
    <FlatList data={place?.canManage ? reviews : []} keyExtractor={review => review.id}
      contentContainerStyle={{ padding: 20, gap: 12 }}
      ListHeaderComponent={<>
    {data.error && <Issue message={data.error} retry={data.reload} />}
    {!place ? data.loading && <Loading /> : !place.canManage ? <Empty icon={Store} title="Listing access unavailable" /> : <>
      <View style={styles.dashboard}>
        <Photo media={place.cover} style={styles.cover} />
        <View style={styles.dashboardBody}>
          <View style={styles.status}><BadgeCheck size={18} color={colors.green} /><T kind="label" color={colors.green}>Verified listing</T></View>
          <T kind="title">{place.name}</T>
          {place.listingUpdatedAt && <T kind="small" color={colors.muted}>Listing details updated {new Date(place.listingUpdatedAt).toLocaleDateString()}</T>}
          <View style={styles.status}><MapPin size={16} color={colors.muted} /><T kind="small" color={colors.muted}>{place.address}</T></View>
          <View style={styles.dashboardStats}>
            {place.score != null && <Score value={place.score} label="Community rating" />}
            <T kind="label">{place.ratingCount} {place.ratingCount === 1 ? 'customer review' : 'customer reviews'}</T>
          </View>
          <Button icon={Pencil} title="Edit listing details" onPress={() => nav.push('EditListing', { id })} />
        </View>
      </View>
      <Section title="Customer reviews" link="View listing" onPress={() => nav.push('Place', { id })} />
      <Segment value={filter} onChange={setFilter} options={[{ key: 'all', title: 'All reviews' }, { key: 'unanswered', title: 'Needs a response' }]} />
      {page.error && <Issue message={page.error} retry={page.reload} />}
      {page.loading && !page.items.length && <Loading />}
      {!page.loading && !page.error && !reviews.length && <Empty icon={MessageCircle} title={filter === 'all' ? 'No reviews yet' : 'No unanswered reviews'} />}
    </>}
    </>}
      renderItem={({ item }) => <View style={styles.review}>
        <ReviewCard compact post={item} />
        <Button icon={MessageCircle} mode="line" title={item.ownerReply ? 'View response' : 'Respond to review'}
          onPress={() => nav.push('Review', { id: item.id })} />
      </View>}
      ListFooterComponent={<ListEnd state={page} />}
      onEndReached={() => { if (!page.moreError) void page.more(); }} onEndReachedThreshold={0.4}
    />
  </Screen>;
}

export function EditListingScreen({ route }: Props<'EditListing'>) {
  const id = route.params.id;
  const { api } = useApp();
  const data = useData('place:' + id, signal => api.place(id,signal));
  return <Screen title="Edit listing" close form>
    {data.error && <Issue message={data.error} retry={data.reload} />}
    {data.data ? data.data.canManage ? <ListingForm place={data.data} />
      : <Issue message="Only the verified manager can update this listing." /> : data.loading && <Loading />}
  </Screen>;
}

function ListingForm({ place }: { place: Place }) {
  const nav = useNav();
  const { api, invalidate, toast } = useApp();
  const task = useTask();
  const [description, setDescription] = useState(place.description);
  const [phone, setPhone] = useState(place.phone);
  const [website, setWebsite] = useState(place.website);
  const [menuURL, setMenu] = useState(place.menuURL);
  const [hours, setHours] = useState(place.hours.join('\n'));
  const [dietary, setDietary] = useState(place.dietary);
  const [price, setPrice] = useState(place.price);
  const [revision, setRevision] = useState(place.listingRevision);
  const [latest, setLatest] = useState<Place>();
  const [base, setBase] = useState(place);
  const [scheduleForm, setScheduleForm] = useState(scheduleFields(place.schedule));
  const [preview, setPreview] = useState<HoursPreview>();
  const [previewDate, setPreviewDate] = useState('');
  const previewTask = useTask();
  const reload = useTask();
  const fields = ['description', 'phone', 'website', 'menuURL', 'hours', 'dietary', 'price', 'schedule'] as const;
  const fieldLabels = { description: 'About the restaurant', phone: 'Phone', website: 'Website', menuURL: 'Menu link', hours: 'Hours', dietary: 'Dietary options', price: 'Price range', schedule: 'Weekly hours and exceptions' };
  const describe = (field: typeof fields[number], value: Place[typeof fields[number]]) => {
    if (field === 'schedule') {
      const schedule = value as Place['schedule'];
      return schedule ? [schedule.timezone, ...legacyHours(schedule), ...schedule.exceptions.map(e => e.date)].join(' · ') : 'Hours unavailable';
    }
    if (Array.isArray(value)) return value.join(' · ') || 'Empty';
    if (field === 'price') return typeof value === 'number' ? '$'.repeat(value) : 'Unknown';
    return String(value || 'Empty');
  };
  const equal = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  const details = (): ListingEdit => ({ revision, description, phone, website, menuURL, hours: hours.split('\n').map(x => x.trim()).filter(Boolean),
    dietary, price, schedule: scheduleValue(scheduleForm) });
  function useVersion(value: Place, source = value) {
    setDescription(value.description);
    setPhone(value.phone);
    setWebsite(value.website);
    setMenu(value.menuURL);
    setHours(value.hours.join('\n'));
    setDietary(value.dietary);
    setPrice(value.price);
    setScheduleForm(scheduleFields(value.schedule));
    setBase(source);
    setRevision(value.listingRevision);
    setLatest(undefined);
    task.setError('');
  }
  return <>
    <T kind="title">{place.name}</T>
    {!scheduleForm.enabled && <Field label="Hours" value={hours} onChangeText={setHours} maxLength={511} multiline
      hint="Enter up to seven lines, for example Mon–Thu 5–10 PM." />
    }
    <HoursEditor value={scheduleForm} onChange={value => { setScheduleForm(value); setPreview(undefined); }} preview={() => void previewTask.run(async () => {
      const schedule = scheduleValue(scheduleForm);
      if (schedule) setPreview(await api.previewHours(place.id, schedule, previewDate || undefined));
    }, true)} />
    {scheduleForm.enabled && <Field label="Preview date" value={previewDate} onChangeText={value => { setPreviewDate(value); setPreview(undefined); }}
      placeholder="YYYY-MM-DD, or leave blank for now" maxLength={10} />}
    {previewTask.error && <Issue message={previewTask.error} />}
    {preview && <View style={styles.reply}>
      <T kind="heading">{preview.open ? 'Open' : 'Closed'} · {preview.timezone}</T>
      <T kind="small" color={colors.muted}>{new Date(preview.asOf).toLocaleString(undefined, { timeZone: preview.timezone })} · {previewDate ? 'Preview at restaurant-local noon' : 'Restaurant-local time'}</T>
      {preview.week.map((line, index) => <T key={index}>{line}</T>)}
    </View>}
    <Field label="Menu link" value={menuURL} onChangeText={setMenu} keyboardType="url" autoCapitalize="none" placeholder="https://" maxLength={1024} />
    <Field label="Website" value={website} onChangeText={setWebsite} keyboardType="url" autoCapitalize="none" placeholder="https://" maxLength={1024} />
    <Field label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={32} />
    <T kind="label">Price range</T>
    <View style={styles.wrap}>{[1, 2, 3, 4].map(value => <Chip key={value} title={'$'.repeat(value)} active={value === price}
      onPress={() => setPrice(value === price ? null : value)} />)}</View>
    <T kind="label">Dietary options</T>
    <View style={styles.wrap}>{Array.from(new Set([...place.dietary, 'Vegetarian', 'Vegan', 'Gluten-free options', 'Halal'])).map(tag =>
      <Chip key={tag} title={tag} active={dietary.includes(tag)} onPress={() => setDietary(current =>
        current.includes(tag) ? current.filter(item => item !== tag) : [...current, tag])} />)}</View>
    <Field label="About the restaurant" value={description} onChangeText={setDescription} maxLength={650} multiline />
    {task.error && <Issue message={task.error} />}
    {reload.error && <Issue message={reload.error} />}
    {task.status === 409 && task.error && !latest && <Button mode="line" title="Load current listing" busy={reload.busy}
      onPress={() => void reload.run(async () => {
        const current = await api.place(place.id);
        if (!current.canManage) throw new Error('Listing access is no longer available.');
        setLatest(current);
      }, true)} />}
    {latest && <View style={styles.reply}>
      <T kind="heading">Current listing · Version {latest.listingRevision}</T>
      {fields.map(field => <View key={field} style={{ gap: 3 }}>
        <T kind="label">{fieldLabels[field]}</T>
        <T color={colors.muted}>{describe(field, latest[field])}</T>
      </View>)}
      <T kind="small" color={colors.muted}>Keep my draft applies your changed fields and keeps unrelated current details.</T>
      <Button title="Keep my draft" mode="line" onPress={() => void reload.run(async () => {
        const draft = details();
        const merged = { ...latest };
        for (const field of fields) {
          if (!equal(draft[field], base[field])) Object.assign(merged, { [field]: draft[field] });
        }
        useVersion(merged, latest);
      }, true)} />
      <Button title="Use current details" mode="line" onPress={() => useVersion(latest)} />
    </View>}
    <Button icon={Pencil} title="Publish listing updates" disabled={Boolean(latest) || (task.status === 409 && !!task.error)} busy={task.busy} onPress={() =>
      void task.run(async () => {
        await api.editListing(place.id, details());
        invalidate('place:' + place.id, 'directory', 'claims');
        toast('Listing details updated');
        nav.goBack();
      }, true)} />
  </>;
}

export function RestaurantResponse({ post, reload }: { post: Post; reload: () => void }) {
  const nav = useNav();
  const { api, invalidate, toast, confirm } = useApp();
  const member = useMember();
  const task = useTask();
  const assistant = useTask();
  const config = useData('config', signal => api.config(signal), post.restaurant.canManage);
  const [editing, setEditing] = useState(false);
  const [baseRevision, setBaseRevision] = useState('');
  const [value, setValue] = useState('');
  const [tone, setTone] = useState<ReplyTone>('warm');
  const [allowRemote, setAllowRemote] = useState(false);
  const [suggestion, setSuggestion] = useState<ReplyDraft>();
  const [latestReply, setLatestReply] = useState<{ text: string; revision: string }>();
  const reply = post.ownerReply;
  const remote = config.data?.assistRemote?.reply === true;
  const beginEdit = () => {
    setValue(reply?.text ?? '');
    setBaseRevision(reply?.revision ?? '');
    task.setError('');
    assistant.setError('');
    setSuggestion(undefined);
    setLatestReply(undefined);
    setEditing(true);
  };
  if (post.status !== 'published') return null;
  if (editing && post.restaurant.canManage) return <View style={styles.reply}>
    <T kind="heading">{reply ? 'Edit your response' : 'Reply as ' + post.restaurant.name}</T>
    <Field label="Public restaurant response" value={value} onChangeText={setValue} maxLength={1000} multiline />
    <Segment value={tone} onChange={setTone} options={[{ key: 'warm', title: 'Warm' }, { key: 'concise', title: 'Concise' }]} />
    {remote && <>
      <Chip title="Use optional AI provider" active={allowRemote} onPress={() => setAllowRemote(v => !v)} />
      <T kind="small" color={colors.muted}>Shares topic, sentiment, and tone categories. The review stays in Goodfork.</T>
    </>}
    <Button mode="line" icon={Sparkles} title="Suggest a reply" busy={assistant.busy} onPress={() =>
      void assistant.run(async () => { setSuggestion(await api.suggestReply(post.id, tone, remote && allowRemote)); }, true)} />
    {assistant.error && <Issue message={assistant.error} />}
    {suggestion && <View style={styles.draft}>
      <T kind="strong">Suggested draft</T>
      <T>{suggestion.draft}</T>
      {suggestion.outcome === 'fallback' && <T kind="small" color={colors.muted}>Draft prepared in Goodfork.</T>}
      <Button mode="line" title="Use draft" onPress={() => {
        void assistant.run(async () => {
          if (value.trim() && !await confirm('Replace your current draft?', 'You can make changes before publishing.', 'Use draft')) return;
          setValue(suggestion.draft);
          setSuggestion(undefined);
        });
      }} />
    </View>}
    {task.error && <Issue message={task.error} />}
    {task.status === 409 && task.error && !latestReply && <Button mode="line" title="Load current response" busy={assistant.busy} onPress={() =>
      void assistant.run(async () => {
        const current = await api.post(post.id);
        if (!current.restaurant.canManage) throw new Error('Listing access is no longer available.');
        setLatestReply({ text: current.ownerReply?.text ?? '', revision: current.ownerReply?.revision ?? '' });
      }, true)} />}
    {latestReply && <View style={styles.draft}>
      <T kind="strong">Current response</T>
      <T>{latestReply.text || 'The response was removed.'}</T>
      <Button mode="line" title="Keep my response draft" onPress={() => {
        setBaseRevision(latestReply.revision);
        setLatestReply(undefined);
        task.setError('');
      }} />
    </View>}
    <View style={styles.wrap}>
      <Button icon={Send} title="Publish response" disabled={!value.trim() || Boolean(latestReply) || (task.status === 409 && !!task.error)} busy={task.busy} onPress={() =>
        void task.run(async () => {
          await api.replyToReview(post.id, value.trim(), baseRevision);
          invalidate('owner', 'place-reviews:' + post.restaurant.id);
          reload();
          toast('Restaurant response published');
          setEditing(false);
        }, true)} />
      <Button mode="line" title="Cancel" disabled={task.busy} onPress={() => setEditing(false)} />
    </View>
  </View>;

  if (!reply) return post.restaurant.canManage
    ? <Button title="Reply as restaurant" mode="line" icon={MessageCircle} onPress={beginEdit} /> : null;

  return <View style={styles.reply}>
    <View style={styles.replyHeader}>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={styles.status}><BadgeCheck size={17} color={colors.green} /><T kind="label" color={colors.green}>Restaurant response</T></View>
        <T kind="small" color={colors.muted}>{post.restaurant.name} · {timeAgo(reply.updatedAt)}</T>
      </View>
      {post.restaurant.canManage ? <>
        <IButton icon={Pencil} label="Edit restaurant response" onPress={beginEdit} />
        <IButton icon={Trash2} label="Remove restaurant response" color={colors.danger} onPress={() =>
          void task.run(async () => {
            if (await confirm('Remove this response?', 'It will be removed from the public review.', 'Remove', true)) {
              await api.deleteReply(post.id, reply.revision);
              invalidate('owner', 'place-reviews:' + post.restaurant.id);
              reload();
              toast('Response removed');
            }
          })} />
      </> : <IButton icon={Flag} label="Report restaurant response" onPress={() => {
        if (member()) nav.push('Report', { kind: 'reply', id: post.id, revision: reply.revision });
      }} />}
    </View>
    <T>{reply.text}</T>
  </View>;
}

const styles = StyleSheet.create({
  intro: { gap: 8, paddingBottom: 3 },
  badge: { width: 49, height: 49, borderRadius: 15, backgroundColor: colors.greenWash, alignItems: 'center', justifyContent: 'center' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  claim: { borderWidth: 1, borderColor: colors.line, borderRadius: 20, padding: 12, gap: 10, backgroundColor: colors.white },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  dashboard: { overflow: 'hidden', borderWidth: 1, borderColor: colors.line, borderRadius: 22, backgroundColor: colors.white },
  cover: { height: 145 },
  dashboardBody: { padding: 14, gap: 8 },
  dashboardStats: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 5 },
  review: { gap: 7 },
  reply: { padding: 13, borderRadius: 16, backgroundColor: colors.greenWash, gap: 8 },
  draft: { padding: 11, gap: 8, borderRadius: 13, backgroundColor: colors.white },
  replyHeader: { flexDirection: 'row', alignItems: 'center', gap: 5 },
});
