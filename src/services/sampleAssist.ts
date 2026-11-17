import type { ReplyTone, Search } from '../types';

export function tokens(text: string) {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

const cuisines = ['Japanese', 'Italian', 'Mexican', 'Korean', 'Vietnamese', 'Thai', 'Indian', 'Chinese', 'French', 'Ethiopian', 'Greek'];
const diets = [['gluten free', 'Gluten-free options'], ['vegetarian', 'Vegetarian'], ['vegan', 'Vegan'], ['halal', 'Halal']] as const;
const fillers = new Set('a an and are find for get give good have i im in is it like looking me my near nearby need of on options or place please restaurant restaurants should some something the to try want what where with would around any cheap inexpensive affordable budget moderately priced upscale dinner lunch tonight now eat'.split(' '));
const priceAmount = /\b(?:under|below|less than|up to)\s*\$?\d+(?:\.\d+)?(?:\s*dollars)?\b/i;

export function sampleIntent(prompt: string, overrides: Search, knownAreas: string[]) {
  if (/\b(?:not|no|avoid|without|except)\s+(?:\w+\s+)?(?:italian|japanese|mexican|korean|vietnamese|thai|indian|chinese|french|ethiopian|greek|vegetarian|vegan|halal|gluten)\b/i.test(prompt)) {
    return { filters: { ...overrides }, note: 'This request contains an exclusion. Choose the cuisines or dietary tags you want in the editable filters.', ambiguous: true };
  }
  let normalized = ' ' + tokens(prompt.replace(priceAmount, ' ')).join(' ') + ' ';
  const contains = (word: string) => normalized.includes(' ' + tokens(word).join(' ') + ' ');
  const remove = (word: string) => { normalized = normalized.replace(' ' + tokens(word).join(' ') + ' ', ' '); };
  const discoveredArea = [...knownAreas].filter(Boolean).sort((a, b) => b.length - a.length).find(contains);
  if (discoveredArea) remove(discoveredArea);
  const cuisine = cuisines.find(contains);
  for (const candidate of cuisines.filter(contains)) remove(candidate);
  const matchedDiets = diets.filter(([label]) => contains(label));
  for (const [label] of matchedDiets) remove(label);
  const price = ['cheap', 'inexpensive', 'budget'].some(contains) ? 1 :
    ['affordable', 'moderately priced'].some(contains) ? 2 : contains('upscale') ? 3 : undefined;
  return {
    filters: {
      q: normalized.split(' ').filter(word => word && word !== 'open' && !fillers.has(word)).join(' ').slice(0, 120),
      openNow: /\bopen now\b/i.test(prompt) || undefined,
      cuisine, diet: matchedDiets[0]?.[1], area: discoveredArea, price, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value != null && value !== '')),
    },
    note: priceAmount.test(prompt) ? 'Exact prices are unavailable. You can narrow the list using price tiers.' :
      matchedDiets.length > 1 ? 'Check the selected dietary filter and adjust it before searching again.' : '',
  };
}

export function sampleDraft(review: string, score: number, tone: ReplyTone) {
  const topic = [
    [/wait|line|slow|queue/i, 'wait times'], [/server|staff|service|friendly/i, 'service'],
    [/dish|food|delicious|flavor|cold|soup|ramen|taco|pizza/i, 'the food'],
    [/price|value|expensive|cost/i, 'value'], [/room|loud|cozy|atmosphere|music/i, 'the dining room'],
  ] as const;
  const match = topic.find(([matcher]) => matcher.test(review));
  const opening = tone === 'warm' ? 'We appreciate you taking the time to tell us about your visit.' : 'Thank you for sharing your feedback.';
  return opening + (match ? ' Your feedback about ' + match[1] + ' is helpful to our team.' : '') + (score >= 8 ? ' We hope to see you again.' : '');
}
