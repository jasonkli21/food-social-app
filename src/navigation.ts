import type { NativeStackNavigationProp, NativeStackScreenProps } from '@react-navigation/native-stack';
import { useNavigation } from '@react-navigation/native';
import type { ReportKind, Search } from './types';

export type Tab = 'discover' | 'explore' | 'saved' | 'you';
export type Routes = {
  Main: { tab?: Tab; exploreQuery?: string; exploreFilters?: Search } | undefined;
  Place: { id: string };
  Review: { id: string; justPosted?: boolean };
  Person: { id: string };
  Compose: { placeId?: string; postId?: string; mode?: 'memory' | 'review' } | undefined;
  Visit: { id: string };
  Journal: { placeId?: string } | undefined;
  Compare: { visitId: string } | undefined;
  AddPlace: { name?: string } | undefined;
  Auth: undefined;
  Choose: { prompt?: string; filters?: Search } | undefined;
  Activity: undefined;
  Settings: undefined;
  EditProfile: undefined;
  Blocked: undefined;
  OwnerTools: undefined;
  Claim: { id: string };
  Manage: { id: string };
  EditListing: { id: string };
  Report: { kind: ReportKind; id: string; revision?: string };
};

export type Props<K extends keyof Routes> = NativeStackScreenProps<Routes, K>;
export const useNav = () => useNavigation<NativeStackNavigationProp<Routes>>();
