import type { Media, PlaceInput, ReviewText } from '../types';

export const demoUser = 'alex';
export const cover = (name: string): Media => ({ kind: 'photo', source: 'sample:' + name });

export const samplePeople = [
  { id: 'alex', name: 'Alex Chen', handle: 'alexchen', bio: 'Always up for a long lunch.', followers: 2, following: 0 },
  { id: 'maya', name: 'Maya Reyes', handle: 'mayabites', bio: 'Noodles, natural wine, and a seat at the counter.', followers: 58, following: 24 },
  { id: 'jules', name: 'Jules Park', handle: 'julesatlarge', bio: 'Brooklyn by way of a very long dinner.', followers: 43, following: 18 },
  { id: 'leo', name: 'Leo Morgan', handle: 'leotastes', bio: 'Usually ordering one more for the table.', followers: 37, following: 21 },
  { id: 'nina', name: 'Nina Patel', handle: 'ninaplates', bio: 'Keeping a list of good toast.', followers: 26, following: 32 },
];

type SamplePlace = Partial<PlaceInput> & Pick<PlaceInput, 'name' | 'cuisine' | 'area' | 'lat' | 'lng'> & { id: string; photo: string };

export const samplePlaces: SamplePlace[] = [
  { id: 'miso', photo: 'ramen', name: 'Miso House', cuisine: 'Japanese', area: 'East Village', lat: 40.7291, lng: -73.9831, price: 2,
    address: 'East Village, Manhattan', description: 'A sixteen-seat ramen counter with slow-cooked broths, handmade noodles, and just enough room for a second bowl.',
    hours: ['Tue–Thu 5–10 PM', 'Fri–Sat 5–11 PM', 'Sun 5–9 PM'], dietary: ['Vegetarian'] },
  { id: 'leo-pizza', photo: 'pizza', name: 'Bar Farina', cuisine: 'Italian', area: 'Williamsburg', lat: 40.7135, lng: -73.9612, price: 2,
    address: 'Williamsburg, Brooklyn', description: 'Naturally leavened pies with blistered crusts and seasonal toppings, sliced at a lively neighborhood bar.',
    hours: ['Mon–Thu 4–10 PM', 'Fri–Sun 12–11 PM'], dietary: ['Vegetarian'] },
  { id: 'santo', photo: 'tacos', name: 'Santo Taco', cuisine: 'Mexican', area: 'Lower East Side', lat: 40.7185, lng: -73.9882, price: 1,
    address: 'Lower East Side, Manhattan', description: 'A corner taqueria with al pastor off the spit, fresh tortillas and a rotating salsa bar.',
    hours: ['Mon–Sun 12–10 PM'], dietary: ['Gluten-free options'] },
  { id: 'butter', photo: 'toast', name: 'Soft Butter', cuisine: 'Café', area: 'Greenpoint', lat: 40.7302, lng: -73.9547, price: 2,
    address: 'Greenpoint, Brooklyn', description: 'A sunlit corner café for slow mornings, good coffee and thick-cut brioche.',
    hours: ['Mon–Fri 8 AM–3 PM', 'Sat–Sun 9 AM–4 PM'], dietary: ['Vegetarian'] },
];

export type SamplePost = ReviewText & {
  id: string;
  authorId: string;
  placeId: string;
  media: Media | null;
  age: number;
  baseLikes: number;
};

export const samplePosts: SamplePost[] = [
  { id: 'review-miso', authorId: 'maya', placeId: 'miso', score: 9.4, dish: 'Spicy miso ramen',
    text: 'The broth is deep, silky, and just spicy enough. Get the extra egg, and take the seat right by the counter.',
    media: cover('ramen'), age: 2, baseLikes: 128 },
  { id: 'review-farina', authorId: 'jules', placeId: 'leo-pizza', score: 9.1, dish: 'Hot honey burrata pie',
    text: 'The crust had those tiny charred bubbles that make the whole pie. The hot honey and cold burrata were worth ordering again.',
    media: cover('pizza'), age: 5, baseLikes: 86 },
  { id: 'review-santo', authorId: 'leo', placeId: 'santo', score: 8.9, dish: 'Al pastor tacos',
    text: 'Order three, squeeze the lime, and get the green salsa. The pineapple had the perfect little bit of char.',
    media: cover('tacos'), age: 9, baseLikes: 67 },
  { id: 'review-butter', authorId: 'nina', placeId: 'butter', score: 8.7, dish: 'Brioche French toast',
    text: 'Crisp edges, soft centers, and lots of berries. A good place to linger if you can get a table by the window.',
    media: cover('toast'), age: 17, baseLikes: 41 },
  { id: 'reel-miso', authorId: 'jules', placeId: 'miso', score: 9.2, dish: 'Tamari miso ramen',
    text: 'A closer look at the bowl I keep thinking about.',
    media: { kind: 'video', source: 'sample:reel', poster: 'sample:ramen' }, age: 24, baseLikes: 55 },
  { id: 'alex-santo', authorId: 'alex', placeId: 'santo', score: 8.6, dish: 'Two al pastor tacos',
    text: 'I stopped for lunch and went back for another order of al pastor.',
    media: null, age: 48, baseLikes: 3 },
  { id: 'alex-farina', authorId: 'alex', placeId: 'leo-pizza', score: 9.0, dish: 'Pepperoni pie',
    text: 'Sit at the bar and split a pie. The pepperoni gets wonderfully crisp.',
    media: null, age: 50, baseLikes: 5 },
];
