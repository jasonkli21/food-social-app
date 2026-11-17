import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { ArrowUpRight } from 'lucide-react-native';
import { colors } from '../theme';
import { T, Tap } from './ui';
import FallbackMap, { type MapProps } from './MapFallback';

export default function MapPanel(props: MapProps) {
  if (Platform.OS === 'android' && !process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY) return <FallbackMap {...props} />;
  return <NativeMap {...props} />;
}

function NativeMap({ places, onSelect }: MapProps) {
  const map = useRef<MapView>(null);
  const fitted = useRef(false);
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState<string>();
  const point = places.find(place => place.id === selected);
  const coords = places.map(place => ({ latitude: place.lat, longitude: place.lng }));
  const serialized = JSON.stringify(coords);
  const initial = coords[0] ?? { latitude: 40.726, longitude: -73.986 };
  useEffect(() => {
    if (!ready || places.length === 0 || fitted.current) return;
    fitted.current = true;
    const pins = JSON.parse(serialized) as { latitude: number; longitude: number }[];
    if (pins.length === 1 && pins[0]) map.current?.animateToRegion({ ...pins[0], latitudeDelta: 0.025, longitudeDelta: 0.025 }, 220);
    else map.current?.fitToCoordinates(pins, { edgePadding: { top: 50, right: 48, bottom: 80, left: 48 }, animated: true });
  }, [serialized, places.length, ready]);
  return <View style={styles.frame}>
    <MapView ref={map} style={StyleSheet.absoluteFill} onMapReady={() => setReady(true)} accessibilityLabel="Restaurant map"
      initialRegion={{ ...initial, latitudeDelta: 0.04, longitudeDelta: 0.04 }}>
      {places.map(place => <Marker key={place.id} coordinate={{ latitude: place.lat, longitude: place.lng }}
        title={place.name} pinColor={place.id === selected ? '#CC7637' : colors.green} onPress={() => setSelected(place.id)}
        onCalloutPress={() => onSelect(place)} />)}
    </MapView>
    {point && <Tap onPress={() => onSelect(point)} style={styles.pin} accessibilityLabel={'View ' + point.name + ' from map'}>
      <T kind="strong" style={{ flex: 1 }}>{point.name}</T><ArrowUpRight size={18} color={colors.green} />
    </Tap>}
  </View>;
}

const styles = StyleSheet.create({
  frame: { height: 295, borderRadius: 20, overflow: 'hidden', backgroundColor: colors.greenWash },
  pin: { position: 'absolute', left: 12, right: 12, bottom: 13, paddingHorizontal: 14, paddingVertical: 11,
    borderRadius: 13, backgroundColor: colors.white, flexDirection: 'row', alignItems: 'center', minHeight: 45 },
});
