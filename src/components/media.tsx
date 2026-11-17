import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Platform, StyleSheet, View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';
import { useEvent } from 'expo';
import { Image } from 'expo-image';
import { VideoView, useVideoPlayer } from 'expo-video';
import { LinearGradient } from 'expo-linear-gradient';
import { Utensils } from 'lucide-react-native';
import type { Media } from '../types';
import { apiURL, getToken } from '../services/client';
import { resolveAttachment } from '../services/demoMedia';
import { colors } from '../theme';
import { T, Tap } from './ui';
import { useApp } from '../state';

const sampleAssets: Record<string, number> = {
  'sample:ramen': require('../../assets/food/ramen.jpg'),
  'sample:pizza': require('../../assets/food/pizza.jpg'),
  'sample:tacos': require('../../assets/food/tacos.jpg'),
  'sample:toast': require('../../assets/food/toast.jpg'),
  'sample:reel': require('../../assets/food/ramen-reel.mp4'),
};

type Source = number | { uri: string; headers?: Record<string, string> };

const objectPath = /^\/v1\/media\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function useSource(raw: string | undefined, privateMedia = false, attempt = 0) {
  const { sessionGeneration, revision } = useApp();
  const protectedPath = raw && objectPath.test(raw) && apiURL ? raw : undefined;
  const token = protectedPath ? getToken() : null;
  const webFetch = Platform.OS === 'web' && Boolean(token && protectedPath);
  const key = JSON.stringify([raw, sessionGeneration, revision, attempt]);
  const [loaded, setLoaded] = useState<{ key: string; uri?: string; failed?: boolean }>();
  useEffect(() => {
    if (raw?.startsWith('local:')) {
      let active = true;
      void resolveAttachment(raw).then(uri => { if (active) setLoaded({ key, uri, failed: !uri }); })
        .catch(() => { if (active) setLoaded({ key, failed: true }); });
      return () => { active = false; };
    }
    if (!webFetch || !protectedPath || !token) return;
    const stop = new AbortController();
    let objectURL: string | undefined;
    const timeout = setTimeout(() => stop.abort(), 18000);
    let active = true;
    void fetch(apiURL + protectedPath, { headers: { Authorization: 'Bearer ' + token }, signal: stop.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('Media unavailable');
        const blob = await response.blob();
        if (active) {
          objectURL = URL.createObjectURL(blob);
          setLoaded({ key, uri: objectURL });
        }
      }).catch(() => { if (active) setLoaded({ key, failed: true }); }).finally(() => clearTimeout(timeout));
    return () => {
      active = false;
      clearTimeout(timeout);
      stop.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [raw, key, token, protectedPath, webFetch]);
  let source: Source | undefined;
  let failed = false;
  if (raw?.startsWith('sample:')) {
    source = sampleAssets[raw];
  } else if (webFetch || raw?.startsWith('local:')) {
    if (loaded?.key === key) {
      source = loaded.uri ? { uri: loaded.uri } : undefined;
      failed = Boolean(loaded.failed);
    }
  } else if (protectedPath && (!privateMedia || token)) {
    source = { uri: apiURL + protectedPath, ...(token ? { headers: { Authorization: 'Bearer ' + token } } : {}) };
  } else if (raw && /^(https:\/\/|file:|blob:|data:image\/)/.test(raw)) {
    source = { uri: raw };
  } else {
    failed = Boolean(raw);
  }
  return { source, failed, key, protectedPath };
}

export function Photo({ media, fallback, style, label, privateMedia }: {
  media?: Media | null; fallback?: Media | null; style?: StyleProp<ViewStyle>; label?: string; privateMedia?: boolean;
}) {
  const raw = media?.kind === 'photo' ? media.source : media?.poster ?? fallback?.source;
  const { source, key, protectedPath } = useSource(raw, privateMedia);
  const [failed, setFailed] = useState<string>();
  return <View style={[styles.photo, style]}>
    {source && failed !== key ? <Image key={key} source={source} contentFit="cover" transition={160}
      accessibilityLabel={label} accessible={!!label} cachePolicy={protectedPath ? 'none' : 'memory-disk'}
      onError={() => setFailed(key)} style={StyleSheet.absoluteFill} />
      : <LinearGradient colors={['#EEE3C9', '#D7C09B']} style={styles.placeholder}>
        <Utensils size={26} color="#7F6549" strokeWidth={1.6} />
      </LinearGradient>}
  </View>;
}

export function ClipPlayer({ media, playing, muted, privateMedia, controls = false, enabled = true }: {
  media: Media; playing: boolean; muted: boolean; privateMedia?: boolean; controls?: boolean; enabled?: boolean;
}) {
  const [retry, setRetry] = useState(0);
  const { source, key, failed } = useSource(media.source, privateMedia, retry);
  const again = () => setRetry(n => n + 1);
  if (failed) return <View style={styles.videoFill}><ClipError retry={again} /></View>;
  if (!source) return <View style={styles.videoFill}><ActivityIndicator accessibilityLabel="Loading clip" color={colors.white} /></View>;
  return <Playback key={key} source={source} playing={playing} muted={muted} controls={controls} enabled={enabled} retry={again} />;
}

function ClipError({ retry }: { retry: () => void }) {
  return <View style={styles.videoError}>
    <T kind="label" color={colors.white} accessibilityLiveRegion="polite">This clip could not be played.</T>
    <Tap style={styles.retry} onPress={retry}><T kind="label" color={colors.white}>Retry clip</T></Tap>
  </View>;
}

function Playback({ source, playing, muted, controls, enabled, retry }: {
  source: Source; playing: boolean; muted: boolean; controls: boolean; enabled: boolean; retry: () => void;
}) {
  const player = useVideoPlayer(source, instance => {
    instance.loop = !controls;
    instance.muted = muted;
  });
  const { status } = useEvent(player, 'statusChange', { status: player.status });
  const [foreground, setForeground] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const watch = AppState.addEventListener('change', change => setForeground(change === 'active'));
    return () => watch.remove();
  }, []);
  useEffect(() => { player.muted = muted; }, [player, muted]);
  useEffect(() => {
    if (playing && enabled && foreground) player.play();
    else player.pause();
  }, [player, playing, enabled, foreground]);
  return <View style={styles.videoFill}>
    <VideoView player={player} nativeControls={controls} contentFit={controls ? 'contain' : 'cover'} style={StyleSheet.absoluteFill} />
    {status === 'loading' && <ActivityIndicator color={colors.white} />}
    {status === 'error' && <ClipError retry={retry} />}
  </View>;
}

const styles = StyleSheet.create({
  photo: { overflow: 'hidden', backgroundColor: '#E1D2BB' },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  videoError: { padding: 12, borderRadius: 14, alignItems: 'center', backgroundColor: '#16130FCF' },
  retry: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
  videoFill: { flex: 1, backgroundColor: colors.dark, alignItems: 'center', justifyContent: 'center' },
});
