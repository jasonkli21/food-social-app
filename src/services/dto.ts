import { validateSchedule } from '../hours';
import type { Schedule } from '../types';

const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const identity = (value: unknown): value is Record<string, unknown> => object(value) && typeof value.id === 'string' && value.id.length > 0;
const status = (value: unknown) => ['published', 'pending', 'hidden'].includes(String(value));
const textFields = (value: Record<string, unknown>, fields: string[]) => fields.every(field => typeof value[field] === 'string');
const media = (value: unknown) => value === null || (object(value) && ['photo', 'video'].includes(String(value.kind)) && typeof value.source === 'string');
function schedule(value: unknown): boolean {
  if (value == null) return true;
  try { validateSchedule(value as Schedule); return true; } catch { return false; }
}

export function isPerson(value: unknown): boolean {
  return identity(value) && textFields(value, ['name', 'handle', 'bio']) && ['followers', 'following', 'reviewCount'].every(field => number(value[field])) && typeof value.isFollowing === 'boolean';
}
export function isPlace(value: unknown): boolean {
  return identity(value) && textFields(value, ['name', 'cuisine', 'area', 'city', 'address', 'description', 'website', 'phone', 'menuURL']) &&
    number(value.lat) && number(value.lng) && number(value.ratingCount) && number(value.listingRevision) &&
    (value.price === null || number(value.price)) && (value.score === null || number(value.score)) &&
    strings(value.hours) && strings(value.dietary) && status(value.status) && media(value.cover) &&
    ['saved', 'managed', 'canManage'].every(field => typeof value[field] === 'boolean') &&
    schedule(value.schedule);
}
function isPost(value: unknown): boolean {
  return identity(value) && isPerson(value.author) && isPlace(value.restaurant) && textFields(value, ['text', 'dish', 'createdAt', 'revision']) &&
    number(value.score) && number(value.likes) && number(value.comments) && typeof value.liked === 'boolean' &&
    status(value.status) && media(value.media) && (value.ownerReply === null || (object(value.ownerReply) && textFields(value.ownerReply, ['text', 'updatedAt', 'revision'])));
}
function isVisit(value: unknown): boolean {
  return identity(value) && textFields(value, ['restaurantName', 'visitDate', 'note', 'dish', 'revision', 'createdAt', 'updatedAt']) &&
    (value.restaurantId === null || typeof value.restaurantId === 'string') && typeof value.unavailable === 'boolean' && (value.score === null || number(value.score));
}

export function validDTO(path: string, value: unknown): boolean {
  const route = path.split('?')[0] ?? '';
  if (object(value) && Array.isArray(value.items)) {
    const predicates: [RegExp, (item: unknown) => boolean][] = [
      [/^(feed|me\/ranked|places\/[^/]+\/(?:owner\/)?reviews|people\/[^/]+\/reviews)$/, isPost],
      [/^(places|me\/saved)$/, isPlace],
      [/^(people|me\/blocked)$/, isPerson],
      [/^me\/visits$/, isVisit],
      [/^me\/restaurants$/, item => identity(item) && isPlace(item.place)],
      [/^posts\/[^/]+\/comments$/, item => identity(item) && typeof item.text === 'string' && typeof item.createdAt === 'string' && isPerson(item.author)],
    ];
    const predicate = predicates.find(([pattern]) => pattern.test(route))?.[1];
    return !predicate || value.items.every(predicate);
  }
  if (/^me\/visits(?:\/[^/]+)?$/.test(route)) return isVisit(value);
  if (/^(places(?:\/[^/]+)?|places\/[^/]+\/listing)$/.test(route)) return isPlace(value);
  if (/^posts(?:\/[^/]+)?$/.test(route)) return isPost(value);
  if (/^(me|people\/[^/]+)$/.test(route)) return isPerson(value);
  return true;
}
