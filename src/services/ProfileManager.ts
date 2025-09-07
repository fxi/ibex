import { RoutingProfile } from "@/types/profiles";
import { v4 as uuidv4 } from "uuid";

const PREDEFINED_PROFILES: RoutingProfile[] = [
  {
    id: "gravel-adventure",
    name: "Gravel Adventure",
    description: "For the adventurous gravel cyclist who loves unpaved roads.",
    bikeType: "GRAVEL_BIKE",
    surface: "AVOID_BAD_SMOOTHNESS_ONLY",
    traffic: "AVOID_IF_POSSIBLE",
    climbs: "AVOID_IF_REASONABLE",
    isDefault: true,
    isCustom: false,
    averageSpeed: 20,
    allowedTransportModes: ["BIKE"],
    stairs: "AVOID_IF_POSSIBLE",
    pavements: "AVOID_IF_POSSIBLE",
    oneways: "AVOID_IF_POSSIBLE",
    bikeSharingProvidersIds: [],
    addRouteGeoJson: true,
    optimizeWaypointOrder: true,
  },
  {
    id: "relaxed-road-trip",
    name: "Relaxed Road Trip",
    description:
      "A comfortable ride on smooth surfaces, avoiding traffic and steep climbs.",
    bikeType: "HYBRID_BIKE",
    surface: "AVOID_NON_SMOOTH",
    traffic: "AVOID_IF_POSSIBLE",
    climbs: "AVOID_IF_POSSIBLE",
    isDefault: false,
    isCustom: false,
    averageSpeed: 18,
    allowedTransportModes: ["BIKE"],
    stairs: "STRICTLY_AVOID",
    pavements: "AVOID_IF_POSSIBLE",
    oneways: "AVOID_IF_POSSIBLE",
    bikeSharingProvidersIds: [],
    addRouteGeoJson: true,
    optimizeWaypointOrder: true,
  },
  {
    id: "urban-commuter",
    name: "Urban Commuter",
    description: "A fast and efficient ride for city commuting.",
    bikeType: "CITY_BIKE",
    surface: "AVOID_NON_SMOOTH",
    traffic: "AVOID_IF_REASONABLE",
    climbs: "IGNORE",
    isDefault: false,
    isCustom: false,
    averageSpeed: 15,
    allowedTransportModes: ["BIKE"],
    stairs: "AVOID_IF_POSSIBLE",
    pavements: "AVOID_IF_POSSIBLE",
    oneways: "AVOID_IF_POSSIBLE",
    bikeSharingProvidersIds: [],
    addRouteGeoJson: true,
    optimizeWaypointOrder: true,
  },
];

const LOCAL_STORAGE_KEY = "routing_profiles";

export class ProfileManager {
  static getProfiles(): RoutingProfile[] {
    const customProfiles = this.getCustomProfiles();
    return [...PREDEFINED_PROFILES, ...customProfiles];
  }

  static getCustomProfiles(): RoutingProfile[] {
    const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  }

  static saveCustomProfiles(profiles: RoutingProfile[]) {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(profiles));
  }

  static addProfile(
    profile: Omit<RoutingProfile, "id" | "isCustom">
  ): RoutingProfile {
    const customProfiles = this.getCustomProfiles();
    const newProfile: RoutingProfile = {
      ...profile,
      id: uuidv4(),
      isCustom: true,
    };
    const updatedProfiles = [...customProfiles, newProfile];
    this.saveCustomProfiles(updatedProfiles);
    return newProfile;
  }

  static updateProfile(updatedProfile: RoutingProfile): RoutingProfile {
    const customProfiles = this.getCustomProfiles();
    const index = customProfiles.findIndex((p) => p.id === updatedProfile.id);
    if (index !== -1) {
      customProfiles[index] = updatedProfile;
      this.saveCustomProfiles(customProfiles);
    }
    return updatedProfile;
  }

  static deleteProfile(profileId: string): void {
    const customProfiles = this.getCustomProfiles();
    const updatedProfiles = customProfiles.filter((p) => p.id !== profileId);
    this.saveCustomProfiles(updatedProfiles);
  }
}
