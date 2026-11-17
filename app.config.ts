import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const mapsKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY;
  const apiURL = process.env.EXPO_PUBLIC_API_URL?.trim();
  if (apiURL || process.env.EAS_BUILD_PROFILE === 'production') {
    let origin: URL | undefined;
    try { origin = new URL(apiURL ?? ''); } catch { /* Report the same setup error for malformed URLs. */ }
    if (!origin || !origin.hostname || origin.username || origin.password || origin.search || origin.hash ||
      origin.pathname !== '/' || !['https:', 'http:'].includes(origin.protocol) ||
      (process.env.EAS_BUILD_PROFILE === 'production' && origin.protocol !== 'https:')) {
      throw new Error('Set EXPO_PUBLIC_API_URL to the Goodfork API origin. Production builds require HTTPS.');
    }
  }

  return {
    ...config,
    name: 'Goodfork',
    slug: 'goodfork',
    scheme: 'goodfork',
    version: '1.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'light',
    icon: './assets/icon.png',
    ios: {
      bundleIdentifier: 'app.goodfork.mobile',
      supportsTablet: true,
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        ...(apiURL?.startsWith('http://') ? { NSAppTransportSecurity: { NSAllowsLocalNetworking: true } } : {}),
      },
    },
    android: {
      package: 'app.goodfork.mobile',
      adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#F7CC57' },
      blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.CAMERA'],
    },
    web: { bundler: 'metro', favicon: './assets/icon.png' },
    plugins: [
      ['expo-splash-screen', { image: './assets/adaptive-icon.png', imageWidth: 160, backgroundColor: '#F9F6EF' }],
      ['expo-image-picker', {
        photosPermission: 'Allow Goodfork to attach photos and short videos that you select for your reviews.',
        cameraPermission: false,
        microphonePermission: false,
      }],
      ['expo-location', {
        locationWhenInUsePermission: 'Allow Goodfork to find restaurants near your current location.',
      }],
      'expo-secure-store',
      'expo-video',
      ['expo-build-properties', {
        android: { usesCleartextTraffic: apiURL?.startsWith('http://') ?? false },
      }],
      ...(mapsKey ? [['react-native-maps', { androidGoogleMapsApiKey: mapsKey }] as [string, object]] : []),
    ],
  };
};
