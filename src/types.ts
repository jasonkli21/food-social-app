export type Status = 'pending' | 'published' | 'hidden';
export type FeedKind = 'for-you' | 'following' | 'clips';
export type ReportKind = 'post' | 'comment' | 'person' | 'place' | 'reply';

export type Media = { kind: 'photo' | 'video'; source: string; poster?: string };
export type Attachment = {
  kind: Media['kind'];
  uri: string;
  name: string;
  mime: string;
  file?: File;
};

export type Person = {
  id: string;
  name: string;
  handle: string;
  bio: string;
  followers: number;
  following: number;
  reviewCount: number;
  isFollowing: boolean;
  email?: string | null;
  hasPassword?: boolean;
  googleLinked?: boolean;
};

export type HoursPeriod = { start: number; end: number };
export type Schedule = { timezone: string; week: HoursPeriod[][]; exceptions: { date: string; periods: HoursPeriod[] }[] };
export type HoursPreview = { open: boolean; timezone: string; asOf: string; week: string[]; periods: HoursPeriod[] };
export type PrivateVisit = {
  id: string; restaurantId: string | null; restaurantName: string; unavailable: boolean;
  visitDate: string; note: string; dish: string; score: number | null; revision: string; createdAt: string; updatedAt: string;
};
export type VisitInput = Pick<PrivateVisit, 'visitDate' | 'note' | 'dish' | 'score'>;

export type Place = {
  id: string;
  name: string;
  cuisine: string;
  area: string;
  city: string;
  address: string;
  lat: number;
  lng: number;
  price: number | null;
  description: string;
  dietary: string[];
  hours: string[];
  website: string;
  phone: string;
  menuURL: string;
  managed: boolean;
  canManage: boolean;
  cover: Media | null;
  score: number | null;
  ratingCount: number;
  saved: boolean;
  status: Status;
  distanceKm?: number | null;
  listingRevision: number;
  listingUpdatedAt: string | null;
  myReview: { id: string; status: Status; ownershipConflict: boolean } | null;
  dishMatch?: { reviewId: string; dish: string } | null;
  schedule?: Schedule | null;
  hoursStatus?: { state: 'open' | 'closed' | 'unknown'; timezone: string | null; asOf: string };
};

export type PlaceInput = Pick<Place,
  'name' | 'cuisine' | 'area' | 'city' | 'address' | 'lat' | 'lng' | 'price' | 'description' | 'dietary' | 'hours' | 'website' | 'phone'>;

export type ListingEdit = { revision: number; schedule?: Schedule | null } & Pick<Place, 'description' | 'price' | 'dietary' | 'hours' | 'website' | 'menuURL' | 'phone'>;
export type ClaimRole = 'Owner' | 'General manager' | 'Authorized staff';
export type ClaimStatus = 'pending' | 'approved' | 'declined' | 'revoked';
export type RestaurantClaim = {
  id: string; place: Place; status: ClaimStatus; role: ClaimRole; note: string; updatedAt: string; revision: number;
};

export type Post = {
  id: string;
  author: Person;
  restaurant: Place;
  score: number;
  text: string;
  dish: string;
  media: Media | null;
  createdAt: string;
  status: Status;
  likes: number;
  comments: number;
  liked: boolean;
  revision: string;
  ownershipConflict: boolean;
  ownerReply: { text: string; updatedAt: string; revision: string } | null;
};

export type Comment = { id: string; text: string; author: Person; createdAt: string };
export type Activity = {
  id: string;
  actor: Person;
  kind: 'follow' | 'like' | 'comment';
  postId: string | null;
  createdAt: string;
  read: boolean;
};

export type Page<T> = { items: T[]; nextOffset: number | null; nextCursor?: string; asOf?: string };
export type PageRead = { signal?: AbortSignal; cursor?: string; asOf?: string };
export type Search = {
  q?: string;
  price?: number;
  cuisine?: string;
  area?: string;
  diet?: string;
  lat?: number;
  lng?: number;
  sort?: 'nearby' | 'relevance';
  openNow?: boolean;
  asOf?: string;
};

export type ReviewText = Pick<Post, 'score' | 'text' | 'dish'>;
export type ReviewDraft = ReviewText & { restaurantId: string; requestId: string; attachment?: Attachment };
export type AssistOutcome = 'local' | 'provider' | 'fallback';
export type DiningSuggestions = { filters: Search; suggestions: { place: Place; reason: string }[]; note: string; outcome: AssistOutcome };
export type ReplyDraft = { draft: string; outcome: AssistOutcome };
export type ReplyTone = 'warm' | 'concise';
export type BrowserTarget = 'native' | 'web';

export type PublicConfig = {
  supportEmail: string; privacyURL: string; termsURL: string; googleEnabled: boolean;
  assistRemote?: { dining: boolean; reply: boolean };
};
export type Credentials = { email: string; password: string; recoveryCode?: string };
export type Registration = Credentials & { handle: string; name: string; agreed: boolean };
export type AuthResult = { token: string; recoveryCode?: string };

export type Service = {
  config(signal?: AbortSignal): Promise<PublicConfig>;
  register(input: Registration): Promise<{ registrationId: string }>;
  verifyEmail(registrationId: string, code: string): Promise<AuthResult>;
  resendVerification(registrationId: string): Promise<void>;
  startGoogleLink(password: string, target: BrowserTarget, challenge: string): Promise<{ authorizationURL: string }>;
  finishGoogleLink(code: string, verifier: string): Promise<void>;
  authenticate(kind: 'login' | 'recover', credentials: Credentials): Promise<AuthResult>;
  finishGoogle(code: string, verifier: string): Promise<AuthResult>;
  logout(): Promise<void>;
  me(signal?: AbortSignal): Promise<Person>;
  editProfile(name: string, bio: string): Promise<Person>;
  deleteAccount(password: string): Promise<void>;
  visits(placeId?: string, offset?: number, read?: PageRead): Promise<Page<PrivateVisit>>;
  visit(id: string, signal?: AbortSignal): Promise<PrivateVisit>;
  createVisit(input: VisitInput & { restaurantId: string; requestId: string }): Promise<PrivateVisit>;
  editVisit(id: string, input: VisitInput & { revision: string }): Promise<PrivateVisit>;
  deleteVisit(id: string, revision: string): Promise<void>;
  feed(kind: FeedKind, offset?: number, read?: PageRead): Promise<Page<Post>>;
  places(search?: Search, offset?: number, read?: PageRead): Promise<Page<Place>>;
  place(id: string, signal?: AbortSignal): Promise<Place>;
  submitPlace(place: PlaceInput): Promise<Place>;
  claimRestaurant(id: string, email: string, role: ClaimRole): Promise<{ id: string; status: 'pending'; revision: number }>;
  myRestaurants(offset?: number, read?: PageRead): Promise<Page<RestaurantClaim>>;
  editListing(id: string, details: ListingEdit): Promise<Place>;
  previewHours(id: string, schedule: Schedule, date?: string): Promise<HoursPreview>;
  placeReviews(id: string, offset?: number, read?: PageRead): Promise<Page<Post>>;
  ownerReviews(id: string, unanswered: boolean, offset?: number, read?: PageRead): Promise<Page<Post>>;
  suggestDining(prompt: string, filters: Search, allowRemote: boolean): Promise<DiningSuggestions>;
  suggestReply(id: string, tone: ReplyTone, allowRemote: boolean): Promise<ReplyDraft>;
  people(q?: string, offset?: number, read?: PageRead): Promise<Page<Person>>;
  person(id: string, signal?: AbortSignal): Promise<Person>;
  personReviews(id: string, offset?: number, read?: PageRead): Promise<Page<Post>>;
  post(id: string, signal?: AbortSignal): Promise<Post>;
  createPost(review: ReviewDraft): Promise<Post>;
  editPost(id: string, review: ReviewText & { revision: string }): Promise<Post>;
  deletePost(id: string, revision: string): Promise<void>;
  replyToReview(id: string, text: string, revision?: string): Promise<void>;
  deleteReply(id: string, revision: string): Promise<void>;
  comments(id: string, offset?: number, read?: PageRead): Promise<Page<Comment>>;
  addComment(id: string, text: string, requestId: string): Promise<Comment>;
  deleteComment(id: string): Promise<void>;
  like(id: string, active: boolean): Promise<void>;
  save(id: string, active: boolean): Promise<void>;
  follow(id: string, active: boolean): Promise<void>;
  block(id: string, active: boolean): Promise<void>;
  saved(offset?: number, read?: PageRead): Promise<Page<Place>>;
  ranked(offset?: number, read?: PageRead): Promise<Page<Post>>;
  rank(winner: string, loser: string): Promise<void>;
  blocked(offset?: number, read?: PageRead): Promise<Page<Person>>;
  activity(offset?: number, read?: PageRead): Promise<Page<Activity>>;
  readActivity(through: string): Promise<void>;
  report(targetType: ReportKind, targetId: string, reason: string, revision?: string): Promise<void>;
};
