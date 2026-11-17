import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { AssistOutcome, DiningSuggestions, Page, PageRead, ReplyDraft, ReviewDraft, Search, Service } from '../types';
import { isPlace, validDTO } from './dto';

export const apiURL = (process.env.EXPO_PUBLIC_API_URL ?? '').trim().replace(/\/+$/, '');
const key = 'goodfork.session.v1';
let activeToken: string | null = null;
let expired: (() => void) | undefined;

export class ServiceError extends Error {
  constructor(message: string, public readonly status: number, public readonly retryAfter?: number) {
    super(message);
  }
}

export function setToken(token: string | null) {
  activeToken = token;
}

export function getToken() {
  return activeToken;
}

export function onExpired(listener?: () => void) {
  expired = listener;
}

export async function loadToken(): Promise<string | null> {
  if (Platform.OS === 'web') return globalThis.sessionStorage?.getItem(key) ?? null;
  return SecureStore.getItemAsync(key);
}

export async function storeToken(token: string | null) {
  if (Platform.OS === 'web') {
    if (token) globalThis.sessionStorage?.setItem(key, token);
    else globalThis.sessionStorage?.removeItem(key);
  } else if (token) {
    await SecureStore.setItemAsync(key, token, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  } else {
    await SecureStore.deleteItemAsync(key);
  }
}

type Body = Record<string, unknown> | FormData;
function query(values: Search & { place?: string; offset?: number; kind?: string; unanswered?: number; paging?: string; cursor?: string } = {}) {
  const params = new URLSearchParams();
  for (const [k, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') params.set(k, String(value));
  }
  const value = params.toString();
  return value ? '?' + value : '';
}

async function request<T>(path: string, method = 'GET', body?: Body, signal?: AbortSignal): Promise<T> {
  const token = activeToken;
  const multi = body instanceof FormData;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timeout = setTimeout(cancel, multi ? 56000 : method === 'GET' ? 12000 : 18000);
  try {
    const response = await fetch(apiURL + '/v1/' + path, {
      method,
      signal: abort.signal,
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(body && !multi ? { 'Content-Type': 'application/json' } : {}),
      },
      body: multi ? body : body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 204 && path === 'auth/session') return undefined as T;
    if (token !== activeToken) throw new ServiceError('Your session changed. Try again.', 0);
    if (response.status === 204) return undefined as T;
    if (!response.ok) {
      const accountRequest = path.startsWith('auth/') && !path.startsWith('auth/google/link/') && path !== 'auth/session';
      if (response.status === 401 && token && !accountRequest) expired?.();
      const problem = await response.json().catch(() => undefined) as { error?: string } | undefined;
      const retry = Number(response.headers.get('Retry-After'));
      throw new ServiceError(problem?.error ?? 'Goodfork could not complete that request.', response.status, retry > 0 ? retry : undefined);
    }
    const result = await response.json() as T;
    if (token !== activeToken) throw new ServiceError('Your session changed. Try again.', 0);
    if (!validDTO(path, result)) throw invalidResponse();
    return result;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError(abort.signal.aborted ? 'The request timed out. Please try again.' : 'Could not connect to Goodfork. Check your connection and try again.', 0);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}

function reviewBody({ attachment, ...fields }: ReviewDraft): Body {
  if (!attachment) return fields;
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  if (Platform.OS === 'web' && attachment.file) {
    form.append('media', attachment.file, attachment.name);
  } else {
    form.append('media', { uri: attachment.uri, name: attachment.name, type: attachment.mime } as unknown as Blob);
  }
  return form;
}

function segment(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new ServiceError('This link does not identify a Goodfork item.', 404);
  return encodeURIComponent(value);
}

const invalidResponse = () => new ServiceError('Goodfork returned an unexpected response. Please try again.', 502);
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasID = (value: unknown) => object(value) && typeof value.id === 'string';

async function page<T>(path: string, read?: PageRead): Promise<Page<T>> {
  const data = await request<unknown>(path, 'GET', undefined, read?.signal);
  if (!object(data) || !Array.isArray(data.items) || !data.items.every(hasID) ||
    (data.nextOffset != null && (!Number.isInteger(data.nextOffset) || Number(data.nextOffset) < 0)) ||
    (data.nextCursor != null && (typeof data.nextCursor !== 'string' || data.nextCursor.length > 384))) throw invalidResponse();
  return { items: data.items as T[], nextOffset: data.nextOffset as number | undefined ?? null, nextCursor: data.nextCursor as string | undefined, asOf: typeof data.asOf === 'string' ? data.asOf : undefined };
}

function outcome(value: unknown): value is AssistOutcome {
  return value === 'provider' || value === 'fallback' || value === 'local';
}

async function suggestions(prompt: string, filters: Search, allowRemote: boolean): Promise<DiningSuggestions> {
  const data = await request<unknown>('assist/dining', 'POST', { prompt, filters, allowRemote });
  if (!object(data) || !outcome(data.outcome) || typeof data.note !== 'string' || !object(data.filters) ||
    !Array.isArray(data.suggestions) || data.suggestions.length > 5 ||
    !data.suggestions.every(entry => object(entry) && isPlace(entry.place) && typeof entry.reason === 'string')) throw invalidResponse();
  return data as DiningSuggestions;
}

export const remote: Service = {
  config: signal => request('config', 'GET', undefined, signal),
  register: body => request('auth/register', 'POST', body),
  verifyEmail: (registrationId, code) => request('auth/verify', 'POST', { registrationId, code }),
  resendVerification: registrationId => request('auth/verify/resend', 'POST', { registrationId }),
  authenticate: (kind, body) => request('auth/' + kind, 'POST', body),
  finishGoogle: (code, verifier) => request('auth/google/finish', 'POST', { code, verifier }),
  startGoogleLink: (password, target, challenge) => request('auth/google/link/start', 'POST', { password, target, challenge }),
  finishGoogleLink: (code, verifier) => request('auth/google/link/finish', 'POST', { code, verifier }),
  logout: () => request('auth/session', 'DELETE'),
  me: signal => request('me', 'GET', undefined, signal),
  editProfile: (name, bio) => request('me', 'PATCH', { name, bio }),
  deleteAccount: password => request('me', 'DELETE', { password }),
  visits: (place, _offset, read) => page('me/visits' + query({ place, cursor: read?.cursor }), read),
  visit: (id, signal) => request('me/visits/' + segment(id), 'GET', undefined, signal),
  createVisit: input => request('me/visits', 'POST', input),
  editVisit: (id, input) => request('me/visits/' + segment(id), 'PATCH', input),
  deleteVisit: (id, revision) => request('me/visits/' + segment(id), 'DELETE', { revision }),
  feed: (kind, offset, read) => page('feed' + query({ kind, offset: kind === 'for-you' ? offset : undefined,
    paging: kind === 'for-you' ? undefined : 'cursor', cursor: read?.cursor }), read),
  place: (id, signal) => request('places/' + segment(id), 'GET', undefined, signal),
  places: (search, offset, read) => page('places' + query({ ...search, offset, asOf: read?.asOf }), read),
  submitPlace: body => request('places', 'POST', body),
  claimRestaurant: (id, email, role) => request('places/' + segment(id) + '/claim', 'POST', { email, role }),
  myRestaurants: (offset, read) => page('me/restaurants' + query({ offset }), read),
  editListing: (id, body) => request('places/' + segment(id) + '/listing', 'PATCH', body),
  previewHours: (id, schedule, date) => request('places/' + segment(id) + '/hours/preview', 'POST', { schedule, date }),
  placeReviews: (id, _offset, read) => page('places/' + segment(id) + '/reviews' + query({ paging: 'cursor', cursor: read?.cursor }), read),
  ownerReviews: (id, unanswered, _offset, read) => page('places/' + segment(id) + '/owner/reviews' + query({
    cursor: read?.cursor, unanswered: unanswered ? 1 : undefined }), read),
  suggestDining: suggestions,
  suggestReply: async (id, tone, allowRemote): Promise<ReplyDraft> => {
    const data = await request<unknown>('posts/' + segment(id) + '/reply/draft', 'POST', { tone, allowRemote });
    if (!object(data) || !outcome(data.outcome) || typeof data.draft !== 'string' || data.draft.length > 1000) throw invalidResponse();
    return { draft: data.draft, outcome: data.outcome };
  },
  person: (id, signal) => request('people/' + segment(id), 'GET', undefined, signal),
  people: (q, offset, read) => page('people' + query({ q, offset }), read),
  personReviews: (id, offset, read) => page('people/' + segment(id) + '/reviews' + query({ offset }), read),
  post: (id, signal) => request('posts/' + segment(id), 'GET', undefined, signal),
  createPost: body => request('posts', 'POST', reviewBody(body)),
  editPost: (id, body) => request('posts/' + segment(id), 'PATCH', body),
  deletePost: (id, revision) => request('posts/' + segment(id), 'DELETE', { revision }),
  replyToReview: (id, text, revision) => request('posts/' + segment(id) + '/reply', 'PUT', { text, revision }),
  deleteReply: (id, revision) => request('posts/' + segment(id) + '/reply', 'DELETE', { revision }),
  comments: (id, offset, read) => page('posts/' + segment(id) + '/comments' + query({ offset }), read),
  addComment: (id, text, requestId) => request('posts/' + segment(id) + '/comments', 'POST', { text, requestId }),
  deleteComment: id => request('comments/' + segment(id), 'DELETE'),
  like: (id, active) => request('posts/' + segment(id) + '/like', 'PUT', { active }),
  save: (id, active) => request('places/' + segment(id) + '/save', 'PUT', { active }),
  follow: (id, active) => request('people/' + segment(id) + '/follow', 'PUT', { active }),
  block: (id, active) => request('people/' + segment(id) + '/block', 'PUT', { active }),
  saved: (offset, read) => page('me/saved' + query({ offset }), read),
  ranked: (offset, read) => page('me/ranked' + query({ offset }), read),
  rank: (winner, loser) => request('me/ranked', 'PUT', { winner, loser }),
  blocked: (offset, read) => page('me/blocked' + query({ offset }), read),
  activity: (offset, read) => page('me/activity' + query({ offset }), read),
  readActivity: through => request('me/activity/read', 'PUT', { through }),
  report: (targetType, targetId, reason, revision) => request('reports', 'POST', { targetType, targetId, reason, revision }),
};
