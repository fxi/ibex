import { RouteSection } from "@/types/routing";

export interface ColorMapping {
  value: string | number;
  color: string;
  label: string;
  lineStyle?: "solid" | "dashed" | "dotted";
}

const TrackStyleConfig = {
  surfaceColorMapping: [
    { value: "PAVED_EXCELLENT", color: "#1E40AF", label: "Paved - Excellent" }, // Deep Blue - smooth & fast
    { value: "PAVED_GOOD", color: "#3B82F6", label: "Paved - Good" }, // Blue - reliable
    {
      value: "PAVED_INTERMEDIATE",
      color: "#60A5FA",
      label: "Paved - Intermediate",
    }, // Light Blue - easy going
    { value: "PAVED_BAD", color: "#93C5FD", label: "Paved - Bad" }, // Pale Blue - getting bumpy
    {
      value: "UNPAVED_INTERMEDIATE",
      color: "#C084FC",
      label: "Unpaved - Intermediate",
    }, // Purple-pink - adventure starts
    { value: "UNPAVED_BAD", color: "#E879F9", label: "Unpaved - Bad" }, // Bright Purple-pink - exciting
    {
      value: "UNPAVED_HORRIBLE",
      color: "#F472B6",
      label: "Unpaved - Horrible",
    }, // Hot Pink - maximum adventure!
    {
      value: "UNPAVED_IMPASSABLE",
      color: "#EC4899",
      label: "Unpaved - Impassable",
    }, // Deep Hot Pink - legendary
    { value: "UNKNOWN", color: "#6B7280", label: "Unknown" }, // Gray - mystery awaits
  ],

  lineWidthExpression: ["interpolate", ["linear"], ["zoom"], 5, 4, 14, 10],

  outlineWidthExpression: ["interpolate", ["linear"], ["zoom"], 5, 8, 14, 14],

  surfaceColorExpression: () => {
    const caseExpression: any[] = ["case"];
    TrackStyleConfig.surfaceColorMapping.forEach(({ value, color }) => {
      caseExpression.push(["==", ["get", "surfaceSmoothness"], value]);
      caseExpression.push(color);
    });
    caseExpression.push("#6B7280"); // Default color
    return caseExpression;
  },

  unpavedFilterExpression: [
    "any",
    ["==", ["get", "surfaceSmoothness"], "UNPAVED_INTERMEDIATE"],
    ["==", ["get", "surfaceSmoothness"], "UNPAVED_BAD"],
    ["==", ["get", "surfaceSmoothness"], "UNPAVED_HORRIBLE"],
    ["==", ["get", "surfaceSmoothness"], "UNPAVED_IMPASSABLE"],
  ],

  unpavedSmoothFilter: [
    "==",
    ["get", "surfaceSmoothness"],
    "UNPAVED_INTERMEDIATE",
  ],
  unpavedOkFilter: ["==", ["get", "surfaceSmoothness"], "UNPAVED_BAD"],
  unpavedTechnicalFilter: [
    "any",
    ["==", ["get", "surfaceSmoothness"], "UNPAVED_HORRIBLE"],
    ["==", ["get", "surfaceSmoothness"], "UNPAVED_IMPASSABLE"],
  ],
};

export class RouteVisualization {
  static getSurfaceColorMapping(): ColorMapping[] {
    return TrackStyleConfig.surfaceColorMapping;
  }

  static getStyleConfig() {
    return TrackStyleConfig;
  }

  static createSegmentGeoJSON(sections: RouteSection[]): any {
    const features = sections
      .filter(
        (section) => section.coordinates && section.coordinates.length > 0
      )
      .map((section, index) => ({
        type: "Feature",
        properties: {
          segmentIndex: index,
          distance: section.distance,
          infrastructure: section.infrastructure,
          stress: section.stress,
          surfaceSmoothness: section.surfaceSmoothness,
          slope: section.slope,
        },
        geometry: {
          type: "LineString",
          coordinates: section.coordinates,
        },
      }));

    return {
      type: "FeatureCollection",
      features,
    };
  }

  static extractSegmentDataFromGeoJSON(routeGeoJSON: any): any {
    // The API returns GeoJSON with properties in each feature
    // We can use this directly for data-driven styling
    if (routeGeoJSON && routeGeoJSON.features) {
      return routeGeoJSON;
    }
    return null;
  }

  static createGroupedGeoJSON(sections: RouteSection[]): any {
    if (!sections || sections.length === 0) {
      return {
        type: "FeatureCollection",
        features: [],
      };
    }

    const groupedFeatures: any[] = [];
    let currentGroup: any = null;

    sections.forEach((section) => {
      if (
        currentGroup &&
        currentGroup.properties.surfaceSmoothness === section.surfaceSmoothness
      ) {
        // Add coordinates to the current group
        if (section.coordinates) {
          currentGroup.geometry.coordinates.push(...section.coordinates);
        }
        // Update distance
        currentGroup.properties.distance += section.distance;
      } else {
        // Start a new group
        if (currentGroup) {
          groupedFeatures.push(currentGroup);
        }
        currentGroup = {
          type: "Feature",
          properties: {
            surfaceSmoothness: section.surfaceSmoothness,
            distance: section.distance,
            // Carry over other properties if needed
          },
          geometry: {
            type: "LineString",
            coordinates: section.coordinates ? [...section.coordinates] : [],
          },
        };
      }
    });

    // Add the last group
    if (currentGroup) {
      groupedFeatures.push(currentGroup);
    }

    return {
      type: "FeatureCollection",
      features: groupedFeatures,
    };
  }
}
