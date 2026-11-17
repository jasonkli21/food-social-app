import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { Bell, CircleUserRound, Flag, Heart, MessageCircle, Pencil, Settings, ShieldBan, Store, UserPlus, Utensils } from 'lucide-react-native';
import { useApp, useMember } from '../state';
import { useData, usePage, useTask } from '../hooks';
import { useNav } from '../navigation';
import type { Props } from '../navigation';
import type { Person } from '../types';
import { colors, fonts } from '../theme';
import { ReviewCard, timeAgo } from '../components/cards';
import { Avatar, Button, Empty, Field, IButton, Issue, ListEnd, Loading, Screen, Section, T, Tap, ui } from '../components/ui';
import { PersonRow } from './Explore';

export function You() {
  const nav = useNav();
  const { api, signedIn, isDemo } = useApp();
  const me = useData('profile:me', signal => api.me(signal), signedIn);
  return <View style={ui.fill}>
    <View style={styles.header}>
      <T kind="display" accessibilityRole="header">You</T>
      <IButton icon={Settings} label="Settings" style={styles.setting} onPress={() => nav.push('Settings')} />
    </View>
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.body}>
      {!signedIn ? <Empty icon={CircleUserRound} title="Pull up a chair" body="Join the community to log visits, save spots, and follow other diners."
        action="Sign in or join" onPress={() => nav.push('Auth')} /> : <>
        {me.error && <Issue message={me.error} retry={me.reload} />}
        {me.data ? <Profile person={me.data} own /> : me.loading && <Loading />}
      </>}
      {!signedIn && <Button title="Restaurant tools" icon={Store} mode="line" onPress={() => nav.push('OwnerTools')} />}
      {isDemo && <View style={styles.sampleInfo}><T kind="label" color={colors.green}>Sample mode</T>
        <T kind="small" color={colors.muted}>Activity and reviews you add here are stored on this device.</T></View>}
    </ScrollView>
  </View>;
}

export function PersonScreen({ route }: Props<'Person'>) {
  const { id } = route.params;
  const { api, signedIn } = useApp();
  const details = useData('profile:person:' + id, signal => api.person(id,signal));
  const me = useData('profile:me', signal => api.me(signal), signedIn);
  return <Screen title="Diner">
    {details.error && <Issue message={details.error} retry={details.reload} />}
    {details.data ? <Profile person={details.data} own={me.data?.id === id} /> : details.loading && <Loading />}
  </Screen>;
}

function Profile({ person, own }: { person: Person; own: boolean }) {
  const nav = useNav();
  const member = useMember();
  const { api, invalidate, confirm, toast } = useApp();
  const task = useTask();
  const page = usePage('profile:reviews:' + person.id, (offset,read) => api.personReviews(person.id, offset,read));
  return <>
    <View style={styles.profile}>
      <View style={styles.identity}><Avatar person={person} size={62} /><View style={{ flex: 1 }}>
        <T kind="title" accessibilityRole="header">{person.name}</T><T kind="label" color={colors.muted}>@{person.handle}</T>
      </View></View>
      {person.bio ? <T>{person.bio}</T> : null}
      <View style={styles.stats}>
        <Stat value={person.reviewCount} name={person.reviewCount === 1 ? 'Review' : 'Reviews'} />
        <Stat value={person.followers} name="Followers" />
        <Stat value={person.following} name="Following" />
      </View>
      {own ? <View style={styles.profileActions}>
        <Button title="Edit profile" icon={Pencil} mode="line" style={ui.fill} onPress={() => nav.push('EditProfile')} />
        <Button title="Activity" icon={Bell} mode="line" style={ui.fill} onPress={() => nav.push('Activity')} />
      </View> : <View style={styles.profileActions}>
        <Button title={person.isFollowing ? 'Following' : 'Follow'} icon={person.isFollowing ? undefined : UserPlus}
          mode={person.isFollowing ? 'line' : 'gold'} busy={task.busy} style={ui.fill} onPress={() => {
            if (member()) void task.run(async () => { await api.follow(person.id, !person.isFollowing); invalidate('profile','feed:following','diners'); });
          }} />
        <IButton icon={Flag} label="Report diner" style={styles.setting} onPress={() => { if (member()) nav.push('Report', { kind: 'person', id: person.id }); }} />
        <IButton icon={ShieldBan} label="Block diner" style={styles.setting} onPress={() => {
          if (!member()) return;
          void task.run(async () => {
            if (await confirm('Block ' + person.name + '?', 'You will no longer see each other’s profiles, posts, or comments while signed in.', 'Block', true)) {
              await api.block(person.id, true);
              invalidate();
              toast('Diner blocked');
              if (nav.canGoBack()) nav.goBack(); else nav.navigate('Main');
            }
          });
        }} />
      </View>}
    </View>
    {own && <Button title="Restaurant tools" icon={Store} mode="line" onPress={() => nav.push('OwnerTools')} />}
    <Section title={own ? 'Your reviews' : 'Reviews'} />
    {page.error && <Issue message={page.error} retry={page.reload} />}
    {page.loading && !page.items.length && <Loading />}
    {!page.loading && !page.error && !page.items.length && <Empty icon={Utensils} title="No reviews yet"
      action={own ? 'Log a visit' : undefined} onPress={() => nav.push('Compose')} />}
    {page.items.map(post => <ReviewCard key={post.id} post={post} compact />)}
    <ListEnd state={page} />
  </>;
}

function Stat({ value, name }: { value: number; name: string }) {
  return <View style={styles.stat}>
    <T style={{ fontFamily: fonts.display, fontSize: 32, lineHeight: 35 }}>{value}</T>
    <T kind="small" color={colors.muted}>{name}</T>
  </View>;
}

export function EditProfileScreen() {
  const { api } = useApp();
  const me = useData('profile:me', signal => api.me(signal));
  return <Screen title="Edit profile" form>
    {me.error && <Issue message={me.error} retry={me.reload} />}
    {me.data ? <EditProfileForm person={me.data} /> : me.loading && <Loading />}
  </Screen>;
}

function EditProfileForm({ person }: { person: Person }) {
  const nav = useNav();
  const { api, invalidate, toast } = useApp();
  const task = useTask();
  const [name, editName] = useState(person.name);
  const [bio, editBio] = useState(person.bio);
  return <>
    <View style={styles.editTop}><Avatar person={{ ...person, name }} size={72} /><T kind="label" color={colors.muted}>@{person.handle}</T></View>
    <Field label="Name" value={name} onChangeText={editName} maxLength={48} />
    <Field label="Bio" value={bio} onChangeText={editBio} maxLength={180} multiline />
    {task.error && <Issue message={task.error} />}
    <Button title="Save profile" disabled={!name.trim()} busy={task.busy} onPress={() => {
      void task.run(async () => {
        await api.editProfile(name, bio);
        invalidate('profile','feed','post','diners');
        toast('Profile updated');
        nav.goBack();
      }, true);
    }} />
  </>;
}

export function ActivityScreen({ navigation: nav }: Props<'Activity'>) {
  const { api, invalidate, signedIn } = useApp();
  const task = useTask();
  const page = usePage('activity', (offset,read) => api.activity(offset,read), signedIn);
  const unread = page.items.some(item => !item.read);
  const first = page.items[0];
  const phrases = { follow: ' followed you', like: ' liked your review', comment: ' commented on your review' };
  return <Screen title="Activity">
    {page.error && <Issue message={page.error} retry={page.reload} />}
    {page.loading && !page.items.length && <Loading />}
    {unread && first && <Button mode="line" title="Mark all as read" busy={task.busy} onPress={() =>
      void task.run(async () => { await api.readActivity(first.createdAt); invalidate('activity'); })} />}
    {!page.loading && !page.error && !page.items.length && <Empty icon={Bell} title="All caught up" body="New followers, likes, and comments will appear here." />}
    {page.items.map(item => {
      const Glyph = item.kind === 'follow' ? UserPlus : item.kind === 'like' ? Heart : MessageCircle;
      return <Tap key={item.id} style={[styles.event, !item.read && styles.unread]} onPress={() => {
        if (item.postId) nav.push('Review', { id: item.postId });
        else nav.push('Person', { id: item.actor.id });
      }}>
        <Avatar person={item.actor} /><View style={ui.fill}>
          <T><T kind="strong">{item.actor.name}</T>{phrases[item.kind]}</T>
          <T kind="small" color={colors.muted}>{timeAgo(item.createdAt)}</T>
        </View><Glyph color={colors.green} size={19} strokeWidth={1.8} />
      </Tap>;
    })}
    <ListEnd state={page} />
  </Screen>;
}

export function BlockedScreen() {
  const { api, invalidate, signedIn, toast } = useApp();
  const page = usePage('blocked', (offset,read) => api.blocked(offset,read), signedIn);
  const task = useTask();
  return <Screen title="Blocked diners">
    {page.error && <Issue message={page.error} retry={page.reload} />}
    {page.loading && !page.items.length && <Loading />}
    {!page.loading && !page.error && !page.items.length && <Empty icon={ShieldBan} title="No blocked diners" />}
    {page.items.map(person => <PersonRow key={person.id} person={person} trailing={
      <Button title="Unblock" mode="line" busy={task.busy} onPress={() => void task.run(async () => {
        await api.block(person.id, false);
        invalidate();
        toast(person.name + ' unblocked');
      })} />} />)}
    <ListEnd state={page} />
  </Screen>;
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 14 },
  setting: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  body: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 28, gap: 13 },
  profile: { gap: 13, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, padding: 15, borderRadius: 22 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stats: { flexDirection: 'row', backgroundColor: colors.greenWash, borderRadius: 15, padding: 9 },
  stat: { flex: 1, alignItems: 'center' },
  profileActions: { flexDirection: 'row', gap: 7, alignItems: 'center' },
  sampleInfo: { gap: 3, backgroundColor: colors.greenWash, borderRadius: 13, padding: 12 },
  editTop: { alignItems: 'center', gap: 8, paddingVertical: 5 },
  event: { flexDirection: 'row', gap: 9, alignItems: 'center', backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 15,
    padding: 12, minHeight: 64 },
  unread: { backgroundColor: colors.greenWash },
});
