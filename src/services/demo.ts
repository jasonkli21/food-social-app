import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import type { Activity, Comment, Media, Page, Person, Place, Post, PrivateVisit, RestaurantClaim, Search, Service, VisitInput } from '../types';
import { hoursStatus, legacyHours, validateSchedule } from '../hours';
import { ServiceError } from './client';
import { dropAttachment, keepAttachment } from './demoMedia';
import { sampleDraft, sampleIntent, tokens } from './sampleAssist';
import { cover, demoUser, samplePeople, samplePlaces, samplePosts } from './sample';

type LocalPerson = Omit<Person, 'isFollowing' | 'reviewCount'>;
type LocalPost = Omit<Post, 'author' | 'restaurant' | 'likes' | 'comments' | 'liked'> & {
  authorId: string; restaurantId: string; baseLikes: number;
};
type LocalComment = Omit<Comment, 'author'> & { authorId: string; postId: string };
type LocalClaim = Omit<RestaurantClaim, 'place'> & { placeId: string };
type LocalState = {
  version: 2;
  visits: (PrivateVisit & { requestId: string })[];
  people: LocalPerson[];
  places: Place[];
  posts: LocalPost[];
  comments: LocalComment[];
  saved: string[];
  likes: string[];
  following: string[];
  blocked: string[];
  rank: string[];
  claims: LocalClaim[];
  seen: string;
  reports: { kind: string; id: string; reason: string; revision?: string }[];
};

const key = 'goodfork.sample.v1';
const code404 = () => new ServiceError('This item is no longer available.', 404);
const sampleOnly = () => Promise.reject(new ServiceError('Accounts are available in a connected Goodfork build.', 400));
const byTime = (a: { createdAt: string }, b: { createdAt: string }) => b.createdAt.localeCompare(a.createdAt);
const now = () => new Date().toISOString();

function fixtures(): LocalState {
  const ago = (hours: number) => new Date(Date.now() - hours * 3600000).toISOString();
  return {
    version: 2, visits: [],
    people: samplePeople,
    places: samplePlaces.map(p => ({
      id: p.id, name: p.name, cuisine: p.cuisine, area: p.area, city: 'New York, NY',
      lat: p.lat, lng: p.lng, address: p.address ?? '', description: p.description ?? '',
      dietary: p.dietary ?? [], hours: p.hours ?? [], price: p.price ?? null, status: 'published',
      website: '', phone: '', menuURL: '', managed: false, canManage: false, cover: cover(p.photo), score: null, ratingCount: 0, saved: false, listingRevision: 1, listingUpdatedAt: null, myReview: null,
    })),
    posts: samplePosts.map(p => ({
      id: p.id, authorId: p.authorId, restaurantId: p.placeId, score: p.score,
      text: p.text, dish: p.dish, media: p.media, baseLikes: p.baseLikes, ownerReply: null, revision: p.id, ownershipConflict: false, status: 'published', createdAt: ago(p.age),
    })),
    comments: [
      { id: 'miso-comment-a', postId: 'review-miso', authorId: 'jules', text: 'Seconding the extra egg. The chili oil is so good.', createdAt: ago(1.8) },
      { id: 'miso-comment-b', postId: 'review-miso', authorId: 'nina', text: 'Adding this to my weekend list!', createdAt: ago(1.5) },
      { id: 'farina-comment-a', postId: 'alex-farina', authorId: 'maya', text: 'Saved for the next time I’m in the neighborhood.', createdAt: ago(18) },
    ],
    claims: [{ id: 'demo-claim', placeId: 'butter', status: 'approved', role: 'Owner', note: '', updatedAt: ago(96), revision: 1 }],
    saved: ['leo-pizza', 'butter'], following: ['jules'], blocked: [], likes: [], rank: [], seen: '', reports: [],
  };
}

let snapshot: LocalState | undefined;
let lock = Promise.resolve();
async function current() {
  if (snapshot) return snapshot;
  const stored = await AsyncStorage.getItem(key);
  try {
    const parsed = stored ? JSON.parse(stored) : undefined;
    const base = fixtures();
    if (parsed && typeof parsed === 'object' && ['people', 'places', 'posts', 'comments', 'saved', 'likes', 'following', 'blocked', 'rank', 'claims', 'reports'].every(field => Array.isArray(parsed[field]))) {
      snapshot = { ...base, ...parsed, version: 2, visits: Array.isArray(parsed.visits) ? parsed.visits : [] };
    } else snapshot = base;
  } catch {
    snapshot = fixtures();
  }
  return snapshot!;
}

async function read<T>(fn: (s: LocalState) => T): Promise<T> {
  await lock;
  return fn(await current());
}

function update<T>(fn: (s: LocalState) => T | Promise<T>): Promise<T> {
  const task = lock.then(async () => {
    const s = JSON.parse(JSON.stringify(await current())) as LocalState;
    const result = await fn(s);
    await AsyncStorage.setItem(key, JSON.stringify(s));
    snapshot = s;
    return result;
  });
  lock = task.then(() => undefined, () => undefined);
  return task;
}

export async function resetDemo() {
  const files = await update(s => {
    const retained = s.posts.map(p => p.media?.source).filter((x): x is string => !!x);
    Object.assign(s, fixtures());
    return retained;
  });
  await Promise.allSettled(files.map(dropAttachment));
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw code404();
  return value;
}

function person(s: LocalState, id: string): Person {
  const p = required(s.people.find(x => x.id === id));
  return {
    ...p, isFollowing: s.following.includes(id),
    following: id === demoUser ? s.following.length : p.following,
    followers: p.followers + (s.following.includes(id) ? 1 : 0),
    reviewCount: s.posts.filter(x => x.authorId === id && x.status === 'published').length,
  };
}
function place(s: LocalState, id: string): Place {
  const p = required(s.places.find(x => x.id === id));
  const ratings = s.posts.filter(x => x.restaurantId === id && x.status === 'published');
  const mine = s.posts.find(visit => visit.restaurantId === id && visit.authorId === demoUser);
  const managed = s.claims.some(c => c.placeId === id && c.status === 'approved');
  return {
    ...p, menuURL: p.menuURL ?? '', managed, canManage: managed, saved: s.saved.includes(id), ratingCount: ratings.length,
    hoursStatus: hoursStatus(p.schedule), schedule: p.schedule ?? null,
    listingRevision: p.listingRevision ?? 1, listingUpdatedAt: p.listingUpdatedAt ?? null,
    myReview: mine ? { id: mine.id, status: mine.status, ownershipConflict: mine.ownershipConflict ?? false } : null,
    score: ratings.length ? Math.round(ratings.reduce((n, x) => n + x.score, 0) * 10 / ratings.length) / 10 : null,
  };
}
function comment(s: LocalState, c: LocalComment): Comment {
  return { id: c.id, text: c.text, createdAt: c.createdAt, author: person(s, c.authorId) };
}
function post(s: LocalState, p: LocalPost): Post {
  const liked = s.likes.includes(p.id);
  return {
    id: p.id, author: person(s, p.authorId), restaurant: place(s, p.restaurantId),
    score: p.score, text: p.text, dish: p.dish, createdAt: p.createdAt, status: p.status, media: p.media,
    ownerReply: p.ownerReply ? { ...p.ownerReply, revision: p.ownerReply.revision ?? p.id } : null,
    revision: p.revision ?? p.id, ownershipConflict: p.ownershipConflict ?? false, liked, likes: p.baseLikes + Number(liked),
    comments: s.comments.filter(c => c.postId === p.id && !s.blocked.includes(c.authorId)).length,
  };
}
function visible(s: LocalState, p: LocalPost) {
  return !s.blocked.includes(p.authorId) && (p.status === 'published' || p.authorId === demoUser);
}
function localPost(s: LocalState, id: string) {
  return required(s.posts.find(p => p.id === id && visible(s, p)));
}
function ownPost(s: LocalState, id: string) {
  return required(s.posts.find(p => p.id === id && p.authorId === demoUser));
}
function paginate<T>(items: T[], offset = 0): Page<T> {
  return { items: items.slice(offset, offset + 20), nextOffset: items.length > offset + 20 ? offset + 20 : null };
}
function includes(haystack: string, needle = '') {
  return haystack.toLowerCase().includes(needle.trim().toLowerCase());
}
function distance(lat: number, lng: number, p: Place) {
  const rad = Math.PI / 180;
  const h = Math.sin((p.lat - lat) * rad / 2) ** 2 + Math.cos(p.lat * rad) * Math.cos(lat * rad) * Math.sin((p.lng - lng) * rad / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, h)));
}
function listPlaces(s: LocalState, filters: Search) {
  const wanted = tokens(filters.q ?? '').slice(0, 8);
  const match = (source: string[]) => wanted.every(word => source.some(token => token.startsWith(word)));
  const items = s.places.filter(p =>
    p.status === 'published' && includes(p.area + ' ' + p.city, filters.area)
    && (!filters.price || p.price === filters.price)
    && (!filters.cuisine || p.cuisine.toLowerCase() === filters.cuisine.toLowerCase())
    && (!filters.diet || p.dietary.some(tag => tag.toLowerCase() === filters.diet?.toLowerCase()))
    && (!filters.openNow || hoursStatus(p.schedule, filters.asOf ? new Date(filters.asOf) : undefined).state === 'open')
  ).flatMap(p => {
    const listing = tokens([p.name,p.cuisine,p.area,p.city,p.address].join(' '));
    const direct = match(listing);
    const hit = direct ? undefined : s.posts.filter(review => review.restaurantId === p.id && visible(s, review) &&
      review.status === 'published' && match([...listing, ...tokens(review.dish)])).sort(byTime)[0];
    if (!direct && !hit) return [];
    const query = (filters.q ?? '').trim().toLowerCase();
    const name = p.name.toLowerCase();
    const relevance = query && name === query ? 0 : query && name.startsWith(query) ? 1 : direct ? 2 : 3;
    return [{ place: { ...place(s,p.id), dishMatch: hit ? { dish: hit.dish, reviewId: hit.id } : null }, relevance }];
  });
  const compare = (a: typeof items[number], b: typeof items[number]) => a.relevance - b.relevance || a.place.name.localeCompare(b.place.name);
  if (filters.sort === 'nearby' && filters.lat !== undefined && filters.lng !== undefined) {
    const { lat, lng } = filters;
    return items.map(row => ({ ...row, distanceKm: distance(lat, lng, row.place) })).filter(row => row.distanceKm <= 50)
      .sort((a,b) => a.distanceKm - b.distanceKm || compare(a,b)).map(row => ({ ...row.place, distanceKm: row.distanceKm }));
  }
  return items.sort(compare).map(row => row.place);
}
function rankList(s: LocalState) {
  const position = (id: string) => s.rank.includes(id) ? s.rank.indexOf(id) : Infinity;
  return s.posts.filter(p => p.authorId === demoUser && p.status !== 'hidden').sort((a, b) =>
    (position(a.id) - position(b.id)) || b.score - a.score || byTime(a, b));
}
function toggle(list: string[], id: string, active: boolean) {
  return active ? [id, ...list.filter(x => x !== id)] : list.filter(x => x !== id);
}

export const demo: Service = {
  config: async () => ({ supportEmail: '', privacyURL: '', termsURL: '', googleEnabled: false }),
  register: sampleOnly,
  verifyEmail: sampleOnly,
  resendVerification: sampleOnly,
  startGoogleLink: sampleOnly,
  finishGoogleLink: sampleOnly,
  authenticate: sampleOnly,
  finishGoogle: sampleOnly,
  logout: sampleOnly,
  me: () => read(s => person(s, demoUser)),
  editProfile: (name, bio) => update(s => {
    const me = required(s.people.find(p => p.id === demoUser));
    me.name = name.trim();
    me.bio = bio.trim();
    return person(s, demoUser);
  }),
  deleteAccount: sampleOnly,
  feed: (kind, offset) => read(s => {
    const savedCuisine = new Set(s.places.filter(p => s.saved.includes(p.id)).map(p => p.cuisine));
    const weight = (p: LocalPost) => {
      const cuisine = s.places.find(x => x.id === p.restaurantId)?.cuisine ?? '';
      const lift = kind === 'for-you' ? Number(s.following.includes(p.authorId)) * 2 + Number(savedCuisine.has(cuisine)) : 0;
      return new Date(p.createdAt).getTime() + lift * 3600000;
    };
    const items = s.posts.filter(p => visible(s, p) && p.status === 'published'
      && (kind !== 'following' || s.following.includes(p.authorId))
      && (kind !== 'clips' || p.media?.kind === 'video')).sort((a, b) => weight(b) - weight(a) || byTime(a, b));
    return paginate(items.map(p => post(s, p)), offset);
  }),
  places: (search = {}, offset, readOptions) => {
    const asOf = search.openNow ? readOptions?.asOf ?? now() : undefined;
    if (asOf && (Date.now() - Date.parse(asOf) > 900000 || Date.parse(asOf) - Date.now() > 5000)) throw new ServiceError('Reload results to refresh opening hours.', 400);
    return read(s => ({ ...paginate(listPlaces(s, { ...search, asOf }), offset), asOf }));
  },
  place: id => read(s => place(s, id)),
  submitPlace: input => update(s => {
    if (s.places.some(p => p.name.toLowerCase() === input.name.toLowerCase() && p.address.toLowerCase() === input.address.toLowerCase())) {
      throw new ServiceError('That restaurant is already in your sample directory.', 409);
    }
    const item: Place = { ...input, id: randomUUID(), status: 'published', cover: null, menuURL: '', managed: false, canManage: false, score: null, ratingCount: 0, saved: false, listingRevision: 1, listingUpdatedAt: null, myReview: null };
    s.places.push(item);
    return item;
  }),
  claimRestaurant: (id, _email, role) => update(s => {
    if (place(s, id).managed) throw new ServiceError('This listing already has a verified manager.', 409);
    const previous = s.claims.find(c => c.placeId === id);
    const claim: LocalClaim = { id: previous?.id ?? randomUUID(), placeId: id, status: 'pending', role, note: '', updatedAt: now(), revision: (previous?.revision ?? 0) + 1 };
    s.claims = [claim, ...s.claims.filter(c => c.placeId !== id)];
    return { id: claim.id, status: 'pending', revision: claim.revision };
  }),
  myRestaurants: offset => read(s => paginate(s.claims.map(({ placeId, ...claim }) => ({ ...claim, revision: claim.revision ?? 1, place: place(s, placeId) })), offset)),
  editListing: (id, { revision, ...details }) => update(s => {
    const prior = place(s, id);
    if (!prior.canManage) throw code404();
    if (prior.listingRevision !== revision) throw new ServiceError('The listing changed. Load the latest version before trying again.', 409);
    if (details.schedule) {
      validateSchedule(details.schedule);
      details.hours = legacyHours(details.schedule);
    }
    Object.assign(required(s.places.find(p => p.id === id)), details, { listingRevision: revision + 1, listingUpdatedAt: now() });
    return place(s, id);
  }),
  previewHours: (id, schedule, date) => read(s => {
    if (!place(s, id).canManage) throw code404();
    validateSchedule(schedule);
    // Pick the preview's local calendar date without depending on the device timezone.
    let at = new Date();
    if (date) {
      at = new Date(date + 'T12:00:00Z');
      for (let i = 0; i < 2; i++) {
        const parts = new Intl.DateTimeFormat('en', { timeZone: schedule.timezone, hour: 'numeric', hourCycle: 'h23' }).format(at);
        at = new Date(at.getTime() + (12 - Number(parts)) * 3600000);
      }
    }
    const status = hoursStatus(schedule, at);
    const local = new Intl.DateTimeFormat('en-CA', { timeZone: schedule.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
    const day = new Date((date ?? local) + 'T12:00:00Z').getUTCDay();
    return { open: status.state === 'open', timezone: schedule.timezone, asOf: at.toISOString(), week: legacyHours(schedule),
      periods: schedule.exceptions.find(row => row.date === (date ?? local))?.periods ?? schedule.week[day] ?? [] };
  }),
  placeReviews: (id, offset) => read(s => paginate(s.posts.filter(p => visible(s, p) && p.restaurantId === id)
    .sort(byTime).map(p => post(s, p)), offset)),
  ownerReviews: (id, unanswered, offset) => read(s => {
    if (!place(s,id).canManage) throw code404();
    return paginate(s.posts.filter(p => p.restaurantId === id && p.authorId !== demoUser && visible(s,p) &&
      p.status === 'published' && (!unanswered || !p.ownerReply)).sort(byTime).map(p => post(s,p)),offset);
  }),
  suggestDining: (prompt, overrides) => read(s => {
    const { filters, note, ambiguous } = sampleIntent(prompt,overrides,s.places.map(p => p.area));
    if (ambiguous) return { filters, suggestions: [], note, outcome: 'local' };
    const suggestions = listPlaces(s, filters).slice(0,5).map(item => ({ place:item, reason:item.dishMatch
      ? 'A diner mentioned ' + item.dishMatch.dish : 'Listed as ' + item.cuisine + (filters.diet ? ' with a ' + filters.diet + ' listing tag' : '') }));
    return { filters, suggestions, note: suggestions.length ? note : 'No restaurants match these filters. Try changing an area, dish, or price tier.', outcome:'local' };
  }),
  suggestReply: (id, tone) => read(s => {
    const target = localPost(s,id);
    if (!place(s,target.restaurantId).canManage || target.authorId === demoUser || target.status !== 'published') throw code404();
    return { draft: sampleDraft(target.text,target.score,tone), outcome:'local' };
  }),
  people: (q = '', offset) => read(s => paginate(s.people.filter(p => p.id !== demoUser && !s.blocked.includes(p.id) && includes(p.name + ' ' + p.handle, q.replace(/^@/, '')))
    .map(p => person(s, p.id)), offset)),
  person: id => read(s => {
    if (s.blocked.includes(id)) throw code404();
    return person(s, id);
  }),
  personReviews: (id, offset) => read(s => paginate(s.posts.filter(p => visible(s, p) && p.authorId === id).sort(byTime).map(p => post(s, p)), offset)),
  post: id => read(s => post(s, localPost(s, id))),
  createPost: input => update(async s => {
    const prior = s.posts.find(x => x.id === input.requestId);
    if (prior) return post(s, prior);
    if (s.posts.some(x => x.restaurantId === input.restaurantId && x.authorId === demoUser)) {
      throw new ServiceError('You already reviewed this restaurant. Edit your review from your profile.', 409);
    }
    if (place(s, input.restaurantId).canManage) throw new ServiceError('Use Restaurant tools to respond to diners at the restaurant you manage.', 409);
    const media: Media | null = input.attachment ? {
      kind: input.attachment.kind, source: await keepAttachment(input.attachment, input.requestId),
    } : null;
    const p: LocalPost = { id: input.requestId, authorId: demoUser, restaurantId: input.restaurantId, score: input.score,
      text: input.text.trim(), dish: input.dish.trim(), status: 'published', baseLikes: 0, ownerReply: null, revision: randomUUID(), ownershipConflict: false, media, createdAt: now() };
    s.posts.unshift(p);
    return post(s, p);
  }),
  editPost: (id, input) => update(s => {
    const current = ownPost(s, id);
    if ((current.revision ?? id) !== input.revision && (current.score !== input.score || current.text !== input.text || current.dish !== input.dish)) throw new ServiceError('This review changed. Load its current version.', 409);
    return post(s, Object.assign(current, input, { revision: randomUUID() }));
  }),
  deletePost: async (id, revision) => {
    const file = await update(s => {
      const p = ownPost(s, id);
      if ((p.revision ?? id) !== revision) throw new ServiceError('This review changed. Reload it before deleting.', 409);
      s.posts = s.posts.filter(x => x.id !== id);
      s.comments = s.comments.filter(c => c.postId !== id);
      s.likes = s.likes.filter(x => x !== id);
      s.rank = s.rank.filter(x => x !== id);
      return p.media?.source;
    });
    if (file) await dropAttachment(file).catch(() => undefined);
  },
  replyToReview: (id, text, revision) => update(s => {
    const target = localPost(s, id);
    if (!place(s, target.restaurantId).canManage || target.authorId === demoUser) throw code404();
    if ((target.ownerReply?.revision ?? (target.ownerReply ? target.id : '')) !== (revision ?? '')) {
      throw new ServiceError('The restaurant response changed. Reopen this review.', 409);
    }
    target.ownerReply = { text: text.trim(), updatedAt: now(), revision: randomUUID() };
  }),
  deleteReply: (id, revision) => update(s => {
    const target = localPost(s, id);
    if (!place(s, target.restaurantId).canManage) throw code404();
    if (target.ownerReply && (target.ownerReply.revision ?? target.id) !== revision) {
      throw new ServiceError('The restaurant response changed. Reopen this review.', 409);
    }
    target.ownerReply = null;
  }),
  comments: (id, offset) => read(s => {
    localPost(s, id);
    return paginate(s.comments.filter(c => c.postId === id && !s.blocked.includes(c.authorId)).sort((a, b) => byTime(b, a)).map(c => comment(s, c)), offset);
  }),
  addComment: (postId, text, id) => update(s => {
    localPost(s, postId);
    const existing = s.comments.find(c => c.id === id);
    if (existing) return comment(s, existing);
    const c: LocalComment = { id, postId, text: text.trim(), authorId: demoUser, createdAt: now() };
    s.comments.push(c);
    return comment(s, c);
  }),
  deleteComment: id => update(s => { s.comments = s.comments.filter(c => c.id !== id || c.authorId !== demoUser); }),
  like: (id, active) => update(s => { localPost(s, id); s.likes = toggle(s.likes, id, active); }),
  save: (id, active) => update(s => { place(s, id); s.saved = toggle(s.saved, id, active); }),
  follow: (id, active) => update(s => { person(s, id); s.following = toggle(s.following, id, active); }),
  block: (id, active) => update(s => {
    person(s, id);
    s.blocked = toggle(s.blocked, id, active);
    if (active) s.following = toggle(s.following, id, false);
  }),
  saved: offset => read(s => paginate(s.saved.map(id => place(s, id)), offset)),
  ranked: offset => read(s => paginate(rankList(s).map(p => post(s, p)), offset)),
  rank: (winner, loser) => update(s => {
    ownPost(s, winner);
    ownPost(s, loser);
    s.rank = rankList(s).filter(p => p.id !== winner).flatMap(p => p.id === loser ? [winner, loser] : [p.id]);
  }),
  blocked: offset => read(s => paginate(s.blocked.map(id => person(s, id)), offset)),
  activity: offset => read(s => {
    const own = s.posts.filter(p => p.authorId === demoUser).map(p => p.id);
    const comments: Activity[] = s.comments.filter(c => own.includes(c.postId) && c.authorId !== demoUser && !s.blocked.includes(c.authorId))
      .map(c => ({ id: c.id, actor: person(s, c.authorId), createdAt: c.createdAt, read: c.createdAt <= s.seen, kind: 'comment', postId: c.postId }));
    return paginate(comments.sort(byTime), offset);
  }),
  readActivity: through => update(s => { if (through > s.seen) s.seen = through; }),
  report: (kind, id, reason, revision) => update(s => {
    if (kind === 'reply') {
      const reply = localPost(s,id).ownerReply;
      if (!reply || (reply.revision ?? id) !== revision) throw new ServiceError('Open the current restaurant response before reporting it.', 409);
    }
    if (kind === 'post') revision = localPost(s, id).revision ?? id;
    if (kind === 'place') revision = String(place(s, id).listingRevision);
    if (s.reports.some(r => r.kind === kind && r.id === id && r.revision === revision)) throw new ServiceError('You have already reported this version.', 409);
    s.reports.push({ kind, id, reason, revision });
  }),
  visits: (placeId, offset) => read(s => paginate(s.visits.filter(entry => !placeId || entry.restaurantId === placeId)
    .sort((a, b) => b.visitDate.localeCompare(a.visitDate) || b.id.localeCompare(a.id)), offset)),
  visit: id => read(s => required(s.visits.find(entry => entry.id === id))),
  createVisit: input => update(s => {
    const existing = s.visits.find(entry => entry.requestId === input.requestId);
    if (existing) return existing;
    validateVisit(input);
    const restaurant = place(s, input.restaurantId);
    const entry = { ...input, id: randomUUID(), restaurantName: restaurant.name, unavailable: false, revision: randomUUID(), createdAt: now(), updatedAt: now() };
    s.visits.push(entry);
    return entry;
  }),
  editVisit: (id, input) => update(s => {
    validateVisit(input);
    const entry = required(s.visits.find(entry => entry.id === id));
    if (entry.revision !== input.revision) throw new ServiceError('This memory changed. Load its current version.', 409);
    Object.assign(entry, input, { revision: randomUUID(), updatedAt: now() });
    return entry;
  }),
  deleteVisit: (id, revision) => update(s => {
    const entry = required(s.visits.find(entry => entry.id === id));
    if (entry.revision !== revision) throw new ServiceError('This memory changed. Reload your journal.', 409);
    s.visits = s.visits.filter(entry => entry.id !== id);
  }),
};

function validateVisit(input: VisitInput) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.visitDate) || !Number.isFinite(Date.parse(input.visitDate)) || new Date(input.visitDate).toISOString().slice(0, 10) !== input.visitDate) throw new ServiceError('Enter a valid date in YYYY-MM-DD format.', 400);
  if (input.note.length > 1500 || input.dish.length > 160 || (input.score !== null && (input.score < 1 || input.score > 10 || !Number.isFinite(input.score) || Math.abs(Math.round(input.score * 10) - input.score * 10) > 0.0001))) throw new ServiceError('Check the private note, dishes, and optional score.', 400);
}
