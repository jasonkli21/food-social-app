import '@expo/metro-runtime';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { DMSans_400Regular } from '@expo-google-fonts/dm-sans/400Regular';
import { DMSans_500Medium } from '@expo-google-fonts/dm-sans/500Medium';
import { DMSans_600SemiBold } from '@expo-google-fonts/dm-sans/600SemiBold';
import { DMSans_700Bold } from '@expo-google-fonts/dm-sans/700Bold';
import { InstrumentSerif_400Regular } from '@expo-google-fonts/instrument-serif/400Regular';
import { JournalScreen, VisitScreen } from './src/screens/Journal';
import { Bookmark, Compass, Plus, Search, UserRound } from 'lucide-react-native';
import type { Props, Routes, Tab } from './src/navigation';
import { AppStateProvider, useApp, useMember } from './src/state';
import { colors } from './src/theme';
import { Brand, Loading, T, Tap, type Icon, ui } from './src/components/ui';
import { Discover } from './src/screens/Discover';
import { ChooseScreen } from './src/screens/Choose';
import { Explore } from './src/screens/Explore';
import { CompareScreen, Saved } from './src/screens/Saved';
import { ActivityScreen, BlockedScreen, EditProfileScreen, PersonScreen, You } from './src/screens/Profile';
import { PlaceScreen, ReviewScreen } from './src/screens/Details';
import { AddPlaceScreen, ComposeScreen } from './src/screens/Compose';
import { AuthScreen, ReportScreen, SettingsScreen } from './src/screens/Account';
import { ClaimScreen, EditListingScreen, ManageScreen, OwnerToolsScreen } from './src/screens/Owner';

void SplashScreen.preventAutoHideAsync().catch(() => undefined);

const Stack = createNativeStackNavigator<Routes>();
const theme = { ...DefaultTheme, colors: { ...DefaultTheme.colors, primary: colors.green,
  background: colors.paper, card: colors.paper, text: colors.ink, border: colors.line, notification: colors.gold } };
const linking = {
  prefixes: ['goodfork://'],
  config: { initialRouteName: 'Main' as const, screens: {
    Main: '', Place: 'restaurant/:id', Review: 'review/:id', Person: 'diner/:id', Journal: 'journal', Visit: 'journal/:id',
  } },
};

export default function App() {
  const [loaded, error] = useFonts({ DMSans_400Regular, DMSans_500Medium, DMSans_600SemiBold, DMSans_700Bold,
    InstrumentSerif_400Regular });
  useEffect(() => { if (loaded || error) void SplashScreen.hideAsync().catch(() => undefined); }, [loaded, error]);
  if (!loaded && !error) return <View style={ui.safe} />;

  return <SafeAreaProvider>
    <StatusBar style="dark" />
    <AppStateProvider>
      <Router />
    </AppStateProvider>
  </SafeAreaProvider>;
}

function Router() {
  const { initialized, sessionGeneration } = useApp();
  if (!initialized) return <SafeAreaView style={[ui.safe, styles.wait]}><Brand /><Loading /></SafeAreaView>;
  return <NavigationContainer theme={theme} linking={linking}>
    <Stack.Navigator initialRouteName="Main" screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.paper } }}>
      <Stack.Screen name="Main" component={Main} />
      <Stack.Screen name="Place" component={PlaceScreen} />
      <Stack.Screen name="Review" component={ReviewScreen} />
      <Stack.Screen name="Person" component={PersonScreen} />
      <Stack.Group navigationKey={'private-' + sessionGeneration}>
        <Stack.Screen name="Visit" component={VisitScreen} />
        <Stack.Screen name="Journal" component={JournalScreen} />
        <Stack.Screen name="Activity" component={ActivityScreen} />
        <Stack.Screen name="Settings" component={SettingsScreen} />
        <Stack.Screen name="EditProfile" component={EditProfileScreen} />
        <Stack.Screen name="Blocked" component={BlockedScreen} />
        <Stack.Screen name="OwnerTools" component={OwnerToolsScreen} />
        <Stack.Screen name="Manage" component={ManageScreen} />
      </Stack.Group>
      <Stack.Group screenOptions={{ presentation: 'fullScreenModal' }}>
        <Stack.Screen name="Auth" component={AuthScreen} />
        <Stack.Screen name="Choose" component={ChooseScreen} />
      </Stack.Group>
      <Stack.Group navigationKey={'private-form-' + sessionGeneration} screenOptions={{ presentation: 'fullScreenModal' }}>
        <Stack.Screen name="Compose" component={ComposeScreen} />
        <Stack.Screen name="AddPlace" component={AddPlaceScreen} />
        <Stack.Screen name="Report" component={ReportScreen} />
        <Stack.Screen name="Compare" component={CompareScreen} />
        <Stack.Screen name="Claim" component={ClaimScreen} />
        <Stack.Screen name="EditListing" component={EditListingScreen} />
      </Stack.Group>
    </Stack.Navigator>
  </NavigationContainer>;
}

const left: [Tab, string, Icon][] = [['discover', 'Discover', Compass], ['explore', 'Explore', Search]];
const right: [Tab, string, Icon][] = [['saved', 'Saved', Bookmark], ['you', 'You', UserRound]];

function Main({ route, navigation }: Props<'Main'>) {
  const [tab, setTab] = useState<Tab>(route.params?.tab ?? 'discover');
  const [visited, setVisited] = useState<Tab[]>([tab]);
  const [query, setQuery] = useState(route.params?.exploreQuery);
  const [preset, setPreset] = useState(route.params?.exploreFilters);
  const insets = useSafeAreaInsets();
  const member = useMember();

  function select(value: Tab) {
    setTab(value);
    setVisited(old => old.includes(value) ? old : [...old, value]);
  }
  useEffect(() => {
    if (route.params?.tab) {
      setQuery(route.params.exploreQuery);
      setPreset(route.params.exploreFilters);
      select(route.params.tab);
      navigation.setParams({ tab: undefined, exploreQuery: undefined, exploreFilters: undefined });
    }
  }, [route.params?.tab, route.params?.exploreQuery, route.params?.exploreFilters, navigation]);

  const openExplore = () => { setQuery(undefined); select('explore'); };
  const renderTab = ([key, title, Glyph]: [Tab, string, Icon]) => {
    const active = key === tab;
    return <Tap key={key} onPress={() => select(key)} accessibilityRole="tab" accessibilityState={{ selected: active }} style={styles.tab}>
      <View style={[styles.tabGlyph, active && styles.activeGlyph]}><Glyph size={22} color={active ? colors.ink : colors.muted} strokeWidth={active ? 2.15 : 1.7} /></View>
      <T kind="small" color={active ? colors.ink : colors.muted} style={styles.tabLabel}>{title}</T>
    </Tap>;
  };
  return <SafeAreaView style={ui.safe} edges={['top', 'left', 'right']}>
    <View style={ui.frame}>
      {visited.includes('discover') && <View style={tab === 'discover' ? ui.fill : styles.hidden}><Discover explore={openExplore} visible={tab === 'discover'} /></View>}
      {visited.includes('explore') && <View style={tab === 'explore' ? ui.fill : styles.hidden}><Explore initial={query} preset={preset} /></View>}
      {visited.includes('saved') && <View style={tab === 'saved' ? ui.fill : styles.hidden}><Saved explore={openExplore} /></View>}
      {visited.includes('you') && <View style={tab === 'you' ? ui.fill : styles.hidden}><You /></View>}
      <View accessibilityRole="tablist" style={[styles.tabbar, { paddingBottom: Math.max(8, insets.bottom) }]}>
        {left.map(renderTab)}
        <Tap accessibilityLabel="Log a visit" onPress={() => { if (member()) navigation.push('Compose'); }} style={styles.compose}>
          <Plus color={colors.ink} strokeWidth={2.3} size={27} />
        </Tap>
        {right.map(renderTab)}
      </View>
    </View>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  hidden: { display: 'none' },
  wait: { justifyContent: 'center', alignItems: 'center' },
  tabbar: { minHeight: 63, paddingTop: 6, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.white },
  tab: { alignItems: 'center', justifyContent: 'center', minHeight: 48, flex: 1, gap: 1 },
  tabGlyph: { borderRadius: 17, width: 44, height: 29, alignItems: 'center', justifyContent: 'center' },
  activeGlyph: { backgroundColor: colors.goldWash },
  tabLabel: { fontSize: 11, lineHeight: 15 },
  compose: { width: 49, height: 49, marginHorizontal: 10, borderRadius: 18, backgroundColor: colors.gold,
    alignItems: 'center', justifyContent: 'center' },
});
