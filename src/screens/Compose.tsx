import { useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Camera, ChevronRight, CirclePlus, MapPin, Minus, Pencil, Plus, Send, Store, Utensils, X } from 'lucide-react-native';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { randomUUID } from 'expo-crypto';
import type { Props } from '../navigation';
import { useNav } from '../navigation';
import { useApp, useMember } from '../state';
import { useData, useDebounced, usePage, useTask } from '../hooks';
import { colors, fonts } from '../theme';
import type { Attachment, Place, Post } from '../types';
import { PlaceRow } from '../components/cards';
import { ClipPlayer, Photo } from '../components/media';
import { Button, Chip, Empty, Field, IButton, Issue, ListEnd, Loading, Screen, T, Tap } from '../components/ui';
import { SearchField } from './Explore';
import { PrivateMemoryForm } from './Journal';
import { Segment } from '../components/ui';

export function ComposeScreen({ route }: Props<'Compose'>) {
  const { api } = useApp();
  const postId = route.params?.postId;
  const [mode, setMode] = useState<'memory' | 'review'>(postId ? 'review' : route.params?.mode ?? 'memory');
  const [placeId, choose] = useState(route.params?.placeId);
  const prior = useData('post:' + postId, signal => api.post(postId!, signal), !!postId);
  const selected = useData('place:' + placeId, signal => api.place(placeId!, signal), !!placeId && !postId);
  const place = prior.data?.restaurant ?? selected.data;
  const issue = prior.error ?? selected.error;
  return <Screen close title={postId ? 'Edit review' : 'Log a visit'} form>
    {issue && <Issue message={issue} retry={postId ? prior.reload : selected.reload} />}
    {place ? <>
      {!postId && <Segment value={mode} onChange={setMode} options={[{ key: 'memory', title: 'Private memory' }, { key: 'review', title: 'Public review' }]} />}
      {mode === 'memory' && !postId ? <PrivateMemoryForm key={place.id} placeId={place.id} placeName={place.name} />
        : <ReviewForm key={postId ?? place.id} place={place} prior={prior.data} choosePlace={route.params?.placeId || postId ? undefined : () => choose(undefined)} />}
    </>
      : postId || placeId ? !issue && <Loading /> : <RestaurantPicker choose={place => choose(place.id)} />}
  </Screen>;
}

function RestaurantPicker({ choose }: { choose: (place: Place) => void }) {
  const nav = useNav();
  const { api } = useApp();
  const [search, searchFor] = useState('');
  const q = useDebounced(search);
  const page = usePage('directory:compose:' + q, (offset, read) => api.places({ q }, offset, read));
  return <>
    <T kind="title">Where did you eat?</T>
    <SearchField value={search} onChange={searchFor} placeholder="Find a restaurant" />
    {page.error && <Issue message={page.error} retry={page.reload} />}
    {page.loading && !page.items.length && <Loading />}
    {!page.loading && !page.error && !page.items.length && <Empty icon={Utensils} title="No matching restaurants" />}
    {page.items.map(p => <PlaceRow key={p.id} place={p} onPress={() => choose(p)} />)}
    <ListEnd state={page} />
    <Button mode="line" icon={CirclePlus} title="Suggest a restaurant" onPress={() => nav.push('AddPlace', { name: search.trim() })} />
  </>;
}

function ReviewForm({ place, prior, choosePlace }: { place: Place; prior?: Post; choosePlace?: () => void }) {
  const nav = useNav();
  const { api, invalidate, toast } = useApp();
  const member = useMember();
  const [score, setScore] = useState(prior?.score.toFixed(1) ?? '');
  const [text, setText] = useState(prior?.text ?? '');
  const [dish, setDish] = useState(prior?.dish ?? '');
  const [revision, setRevision] = useState(prior?.revision ?? '');
  const [latest, setLatest] = useState<Post>();
  const refresh = useTask();
  const [attachment, setAttachment] = useState<Attachment>();
  const requestId = useRef(randomUUID());
  const sending = useTask();
  const picker = useTask();
  const value = Number(score.replace(',', '.'));
  const valid = Number.isFinite(value) && value >= 1 && value <= 10 && Math.abs(Math.round(value * 10) - value * 10) < 0.0001;
  const increment = (by: number) => setScore(Math.min(10, Math.max(1, (valid ? value : 5) + by)).toFixed(1));
  if (place.canManage) return <Empty icon={Store} title={place.name} body="Open Restaurant tools to respond to customer reviews."
    action="Manage restaurant" onPress={() => nav.replace('Manage', { id: place.id })} />;
  if (!prior && place.myReview) return <Empty icon={Pencil} title="You’ve reviewed this restaurant"
    body={place.myReview.status === 'pending' ? 'Your review is awaiting moderation.' : 'Open the existing review to see its current status.'}
    action="Open my review" onPress={() => nav.replace('Review', { id: place.myReview!.id })} />;
  if (prior?.ownershipConflict) return <Empty icon={Store} title="Review held by moderation"
    body="A moderator can restore this review after the ownership conflict is resolved." />;
  const description = !valid ? 'Choose a score from 1 to 10'
    : value >= 9 ? 'A favorite' : value >= 7 ? 'Worth going back' : value >= 5 ? 'Good enough' : 'Would pass';

  return <>
    <View style={styles.venue}>
      <Photo media={place.cover} style={styles.thumb} /><View style={{ flex: 1 }}>
        <T kind="section">{place.name}</T><T kind="small" color={colors.muted}>{place.cuisine} · {place.area || place.city}</T>
      </View>
      {choosePlace && <Tap style={styles.change} onPress={choosePlace}><T kind="label" color={colors.green}>Change</T></Tap>}
    </View>
    <View style={styles.scorePanel}>
      <T kind="heading">How was it?</T>
      <View style={styles.scoreRow}>
        <IButton icon={Minus} label="Lower score by half a point" onPress={() => increment(-0.5)} style={styles.scoreButton} />
        <Field label="Your score out of 10" value={score} onChangeText={setScore} maxLength={4} keyboardType="decimal-pad"
          selectTextOnFocus placeholder="—" style={styles.scoreInput} />
        <IButton icon={Plus} label="Raise score by half a point" onPress={() => increment(0.5)} style={styles.scoreButton} />
      </View>
      <T kind="label" color={colors.green} accessibilityLiveRegion="polite">{description}</T>
      <View style={styles.fields}>
        {[{ score: 3, title: 'Would pass' }, { score: 6, title: 'Good' }, { score: 9, title: 'A favorite' }].map(option =>
          <Chip key={option.score} title={option.title + ' · ' + option.score} active={valid && value === option.score}
            onPress={() => setScore(option.score.toFixed(1))} />)}
      </View>
    </View>
    <Field label="What did you order?" placeholder="The dish worth coming back for" value={dish} maxLength={72} onChangeText={setDish} />
    <Field label="Your review" placeholder="What should someone know before they go?" value={text} onChangeText={setText} maxLength={1500} multiline />
    <T kind="small" color={colors.muted}>{text.length} / 1500</T>
    {!prior && (attachment
      ? <View style={styles.attachment}>
        {attachment.kind === 'photo'
          ? <Photo media={{ kind: 'photo', source: attachment.uri }} style={styles.attachmentPhoto} />
          : <View style={styles.video}><ClipPlayer media={{ kind: 'video', source: attachment.uri }} muted playing={false} controls /></View>}
        <View style={styles.attachmentLabel}>
          <T kind="label" style={{ flex: 1 }} numberOfLines={1}>{attachment.name}</T>
          <IButton icon={X} label="Remove attachment" onPress={() => setAttachment(undefined)} />
        </View>
      </View>
      : <Button title="Add a photo or clip" icon={Camera} mode="line" busy={picker.busy} onPress={() => {
        void picker.run(async () => {
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images', 'videos'],
            quality: 0.8,
            videoMaxDuration: 30,
            videoExportPreset: ImagePicker.VideoExportPreset.MediumQuality,
            preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
            allowsMultipleSelection: false,
          });
          if (result.canceled || !result.assets[0]) return;
          const asset = result.assets[0];
          setAttachment(await prepareAttachment(asset));
        });
      }} />)}
    {prior?.media?.kind === 'photo' && <Photo media={prior.media} style={styles.attachmentPhoto} privateMedia={prior.status === 'pending'} />}
    {!prior && <T kind="small" color={colors.muted}>Attach a photo or an H.264 clip up to 30 seconds and 16 MB.</T>}
    {sending.error && <Issue message={sending.error} />}
    {sending.status === 409 && prior && <Button title="Load current review" mode="line" busy={refresh.busy} onPress={() => void refresh.run(async () => {
      setLatest(await api.post(prior.id));
    }, true)} />}
    {refresh.error && <Issue message={refresh.error} />}
    {latest && <View style={{ gap: 9 }}>
      <T kind="heading">Current public review</T>
      <T>{latest.score.toFixed(1)} · {latest.dish}</T><T>{latest.text}</T>
      <Button title="Keep my review draft" mode="line" onPress={() => { setRevision(latest.revision); setLatest(undefined); sending.setError(''); }} />
      <Button title="Use current review" mode="line" onPress={() => {
        setRevision(latest.revision); setScore(latest.score.toFixed(1)); setText(latest.text); setDish(latest.dish);
        setLatest(undefined); sending.setError('');
      }} />
    </View>}
    <Button icon={prior ? Pencil : Send} title={prior ? 'Save changes' : 'Post review'} disabled={!valid || text.trim().length < 5 || Boolean(latest) || (sending.status === 409 && !!sending.error)}
      busy={sending.busy} onPress={() => {
        if (!member()) return;
        void sending.run(async () => {
          const input = { score: value, dish, text };
          const post = prior ? await api.editPost(prior.id, { ...input, revision })
            : await api.createPost({ ...input, attachment, restaurantId: place.id, requestId: requestId.current });
          invalidate('feed', 'directory', 'ranked', 'profile', 'place:' + place.id, 'place-reviews:' + place.id, 'post:' + post.id);
          toast(post.status === 'pending' ? 'Review submitted for moderation' : prior ? 'Review updated' : 'Review posted');
          if (prior && nav.canGoBack()) nav.goBack();
          else nav.replace('Review', { id: post.id, justPosted: !prior });
        }, true);
      }} />
  </>;
}

async function prepareAttachment(asset: ImagePicker.ImagePickerAsset): Promise<Attachment> {
  if (asset.type === 'video') {
    if (asset.fileSize && asset.fileSize > 16 * 1024 * 1024) throw new Error('Choose a clip up to 16 MB.');
    if (asset.duration && asset.duration > 30000) throw new Error('Choose a clip up to 30 seconds.');
    if (asset.fileName && !/\.(mp4|mov)$/i.test(asset.fileName)) throw new Error('Choose an H.264 clip in MP4 or MOV.');
    return { kind: 'video', uri: asset.uri, name: asset.fileName ?? 'clip.mp4', mime: asset.mimeType ?? 'video/mp4', file: asset.file };
  }
  try {
    const image = ImageManipulator.manipulate(asset.uri);
    if (Math.max(asset.width,asset.height) > 2048) image.resize(asset.width >= asset.height ? { width: 2048 } : { height: 2048 });
    const decoded = await image.renderAsync();
    const JPEG = await decoded.saveAsync({ format: SaveFormat.JPEG, compress: 0.84 });
    const file = Platform.OS === 'web' ? new File([await (await fetch(JPEG.uri)).blob()], 'photo.jpg', { type: 'image/jpeg' }) : undefined;
    return { kind: 'photo', uri: JPEG.uri, name: 'photo.jpg', mime: 'image/jpeg', file };
  } catch {
    throw new Error('This photo could not be opened. Choose a JPEG or PNG photo.');
  }
}

export function AddPlaceScreen({ route, navigation: nav }: Props<'AddPlace'>) {
  const { api, invalidate, isDemo, toast } = useApp();
  const member = useMember();
  const [name, setName] = useState(route.params?.name ?? '');
  const [cuisine, setCuisine] = useState('');
  const [area, setArea] = useState('');
  const [city, setCity] = useState(isDemo ? 'New York, NY' : '');
  const [address, setAddress] = useState('');
  const [latitude, setLat] = useState('');
  const [longitude, setLng] = useState('');
  const [price, setPrice] = useState<number | null>(null);
  const [website, setWebsite] = useState('');
  const [phone, setPhone] = useState('');
  const [hours, setHours] = useState('');
  const [dietary, setDietary] = useState<string[]>([]);
  const [description, setDescription] = useState('');
  const [optional, setOptional] = useState(false);
  const find = useTask();
  const save = useTask();
  const lat = Number(latitude), lng = Number(longitude);
  const validAddress = address.trim().length >= 4 && !!city.trim();
  const coordinates = !!latitude.trim() && !!longitude.trim() && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  const invalidateCoords = () => { setLat(''); setLng(''); };

  return <Screen title="Suggest a restaurant" form>
    <T kind="title">Add a place to the map.</T>
    <Field label="Restaurant name" placeholder="Name on the sign" value={name} onChangeText={setName} maxLength={100} />
    <Field label="Cuisine" placeholder="For example, Japanese" value={cuisine} onChangeText={setCuisine} maxLength={48} />
    <Field label="Street address" placeholder="Street number and name" value={address} maxLength={180}
      onChangeText={value => { setAddress(value); invalidateCoords(); }} />
    <Field label="City" placeholder="City and state" value={city} maxLength={72}
      onChangeText={value => { setCity(value); invalidateCoords(); }} />
    <Field label="Neighborhood (optional)" value={area} onChangeText={setArea} maxLength={72} />
    {Platform.OS !== 'web' && <Button icon={MapPin} title="Find coordinates from address" mode="line" disabled={!validAddress} busy={find.busy} onPress={() =>
      void find.run(async () => {
        if (Platform.OS === 'android' && !(await Location.requestForegroundPermissionsAsync()).granted) {
          throw new Error('Enter the coordinates below or allow location access to look up this address.');
        }
        const [match] = await Location.geocodeAsync(address.trim() + ', ' + city.trim());
        if (!match) throw new Error('Could not find that address. Check it or enter coordinates below.');
        setLat(match.latitude.toFixed(6));
        setLng(match.longitude.toFixed(6));
      }, true)} />}
    {find.error && <Issue message={find.error} />}
    <View style={styles.fields}>
      <View style={{ flex: 1 }}><Field label="Latitude" value={latitude} onChangeText={setLat} maxLength={14} keyboardType="numbers-and-punctuation" /></View>
      <View style={{ flex: 1 }}><Field label="Longitude" value={longitude} onChangeText={setLng} maxLength={14} keyboardType="numbers-and-punctuation" /></View>
    </View>
    <Tap style={styles.moreDetails} onPress={() => setOptional(x => !x)}><T kind="strong">{optional ? 'Hide optional details' : 'Add optional details'}</T><ChevronRight color={colors.green} size={19} /></Tap>
    {optional && <>
      <T kind="label">Price</T>
      <View style={styles.fields}>{[1, 2, 3, 4].map(n => <Chip key={n} title={'$'.repeat(n)} active={n === price} onPress={() => setPrice(price === n ? null : n)} />)}</View>
      <T kind="label">Dietary options</T>
      <View style={styles.fields}>{['Vegetarian', 'Vegan', 'Gluten-free options', 'Halal'].map(tag => <Chip key={tag} title={tag}
        active={dietary.includes(tag)} onPress={() => setDietary(previous => previous.includes(tag) ? previous.filter(t => t !== tag) : [...previous, tag])} />)}</View>
      <Field label="Website" autoCapitalize="none" keyboardType="url" value={website} onChangeText={setWebsite} maxLength={240} placeholder="https://" />
      <Field label="Phone" keyboardType="phone-pad" value={phone} onChangeText={setPhone} maxLength={32} />
      <Field label="Hours" hint="Enter up to seven lines" maxLength={511} multiline value={hours} onChangeText={setHours} />
      <Field label="Description" maxLength={650} multiline value={description} onChangeText={setDescription} />
    </>}
    {save.error && <Issue message={save.error} />}
    <Button title="Submit restaurant" icon={Send} busy={save.busy} disabled={!name.trim() || !cuisine.trim() || !validAddress || !coordinates} onPress={() => {
      if (!member()) return;
      void save.run(async () => {
        const place = await api.submitPlace({ name: name.trim(), cuisine: cuisine.trim(), area: area.trim(),
          city: city.trim(), address: address.trim(), lat, lng, price, website: website.trim(), phone: phone.trim(), dietary,
          hours: hours.split('\n').map(line => line.trim()).filter(Boolean), description: description.trim() });
        invalidate('directory', 'claims');
        toast(place.status === 'pending' ? 'Restaurant submitted for moderation' : 'Restaurant added');
        nav.replace('Place', { id: place.id });
      }, true);
    }} />
  </Screen>;
}

const styles = StyleSheet.create({
  venue: { borderWidth: 1, borderColor: colors.line, borderRadius: 17, padding: 10, gap: 10, flexDirection: 'row', alignItems: 'center', backgroundColor: colors.white },
  thumb: { width: 60, height: 60, borderRadius: 12 },
  change: { paddingHorizontal: 8, justifyContent: 'center', minHeight: 44 },
  scorePanel: { backgroundColor: colors.greenWash, borderRadius: 20, padding: 16, alignItems: 'center', gap: 9 },
  scoreRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'center', gap: 14 },
  scoreInput: { textAlign: 'center', fontFamily: fonts.display, fontSize: 36, paddingVertical: 0, minWidth: 130, minHeight: 57, color: colors.green },
  scoreButton: { backgroundColor: colors.white, marginBottom: 6 },
  attachment: { borderWidth: 1, borderColor: colors.line, borderRadius: 15, overflow: 'hidden', backgroundColor: colors.white },
  attachmentPhoto: { height: 163, borderRadius: 14 },
  attachmentLabel: { paddingLeft: 12, flexDirection: 'row', alignItems: 'center', gap: 7 },
  video: { height: 210, backgroundColor: colors.dark },
  fields: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  moreDetails: { minHeight: 44, alignItems: 'center', justifyContent: 'space-between', flexDirection: 'row' },
});
