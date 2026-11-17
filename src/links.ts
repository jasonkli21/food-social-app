import { Linking, Platform, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import type { Place } from './types';
import { apiURL } from './services/client';

export async function openLink(url: string) {
  if (!/^(https:\/\/|tel:\+?[0-9]+$|mailto:)/i.test(url)) throw new Error('This link is unavailable.');
  await Linking.openURL(url);
}

export function mapURL(place: Place, directions = false) {
  if (Platform.OS === 'ios') {
    return directions
      ? 'https://maps.apple.com/?daddr=' + encodeURIComponent(place.lat + ',' + place.lng)
      : 'https://maps.apple.com/?ll=' + encodeURIComponent(place.lat + ',' + place.lng) + '&q=' + encodeURIComponent(place.name);
  }
  return directions
    ? 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(place.lat + ',' + place.lng)
    : 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(place.lat + ',' + place.lng);
}

export async function shareContent(kind: 'place' | 'review', id: string, name: string) {
  const link = apiURL ? apiURL + (kind === 'place' ? '/r/' : '/p/') + id : '';
  const message = name + ' on Goodfork' + (link ? '\n' + link : ' · Sample mode');
  if (Platform.OS === 'web') {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ text: message });
        return false;
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return false;
      }
    }
    await Clipboard.setStringAsync(message);
    return true;
  }
  await Share.share({ message });
  return false;
}
