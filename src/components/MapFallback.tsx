import { StyleSheet, View } from 'react-native';
import { MapPin } from 'lucide-react-native';
import type { Place } from '../types';
import { useTask } from '../hooks';
import { mapURL, openLink } from '../links';
import { colors } from '../theme';
import { Button, T } from './ui';

export type MapProps = { places: Place[]; onSelect: (place: Place) => void };
export default function MapPanel({ places }: MapProps) {
  const task = useTask();
  const first = places[0];
  return <View style={styles.panel}>
    <MapPin color={colors.green} size={31} strokeWidth={1.6} />
    <T kind="heading">Explore the area</T>
    <T color={colors.muted} style={styles.text}>Open the map for a restaurant to see its location.</T>
    {first && <Button title={'Map for ' + first.name} mode="line" onPress={() => void task.run(() => openLink(mapURL(first)))} />}
  </View>;
}

const styles = StyleSheet.create({
  panel: { backgroundColor: colors.greenWash, borderRadius: 20, minHeight: 210, padding: 20,
    alignItems: 'center', justifyContent: 'center', gap: 8 },
  text: { textAlign: 'center' },
});
