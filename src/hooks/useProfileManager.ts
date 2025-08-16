import { useState, useEffect, useCallback } from 'react';
import { RoutingProfile } from '@/types/profiles';
import { ProfileManager } from '@/services/ProfileManager';

export function useProfileManager() {
  const [profiles, setProfiles] = useState<RoutingProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<RoutingProfile | null>(null);

  useEffect(() => {
    const allProfiles = ProfileManager.getProfiles();
    setProfiles(allProfiles);
    const defaultProfile = allProfiles.find(p => p.isDefault) || allProfiles[0];
    setActiveProfile(defaultProfile);
  }, []);

  const addProfile = useCallback((profile: Omit<RoutingProfile, 'id' | 'isCustom'>) => {
    const newProfile = ProfileManager.addProfile(profile);
    setProfiles(prev => [...prev, newProfile]);
    return newProfile;
  }, []);

  const updateProfile = useCallback((profile: RoutingProfile) => {
    const updatedProfile = ProfileManager.updateProfile(profile);
    setProfiles(prev => prev.map(p => p.id === updatedProfile.id ? updatedProfile : p));
    if (activeProfile?.id === updatedProfile.id) {
      setActiveProfile(updatedProfile);
    }
    return updatedProfile;
  }, [activeProfile]);

  const deleteProfile = useCallback((profileId: string) => {
    ProfileManager.deleteProfile(profileId);
    setProfiles(prev => prev.filter(p => p.id !== profileId));
    if (activeProfile?.id === profileId) {
      const defaultProfile = profiles.find(p => p.isDefault) || profiles[0];
      setActiveProfile(defaultProfile);
    }
  }, [activeProfile, profiles]);

  const selectProfile = useCallback((profileId: string) => {
    const profile = profiles.find(p => p.id === profileId);
    if (profile) {
      setActiveProfile(profile);
    }
  }, [profiles]);

  return {
    profiles,
    activeProfile,
    addProfile,
    updateProfile,
    deleteProfile,
    selectProfile,
  };
}
