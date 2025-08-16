import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { RoutingProfile } from "@/types/profiles";
import { useEffect, useState } from "react";

interface ProfileManagementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: Partial<RoutingProfile> | null;
  onSave: (profile: Omit<RoutingProfile, 'id' | 'isCustom'>) => void;
}

export function ProfileManagementDialog({
  open,
  onOpenChange,
  profile,
  onSave,
}: ProfileManagementDialogProps) {
  const [formData, setFormData] = useState<Partial<RoutingProfile>>({});

  useEffect(() => {
    setFormData(profile || {});
  }, [profile]);

  const handleSave = () => {
    onSave(formData as Omit<RoutingProfile, 'id' | 'isCustom'>);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{profile?.id ? "Edit Profile" : "New Profile"}</DialogTitle>
          <DialogDescription>
            Create or edit a custom routing profile.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="name">Profile Name</Label>
            <Input
              id="name"
              value={formData.name || ""}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Input
              id="description"
              value={formData.description || ""}
              onChange={(e) =>
                setFormData({ ...formData, description: e.target.value })
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="bike-type">Bicycle Type</Label>
              <Select
                value={formData.bikeType || ""}
                onValueChange={(value) =>
                  setFormData({ ...formData, bikeType: value as any })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="GRAVEL_BIKE">Gravel Bike</SelectItem>
                  <SelectItem value="ROAD_BIKE">Road Bike</SelectItem>
                  <SelectItem value="MOUNTAIN_BIKE">Mountain Bike</SelectItem>
                  <SelectItem value="HYBRID_BIKE">Hybrid Bike</SelectItem>
                  <SelectItem value="ELECTRIC_BIKE">E-Bike</SelectItem>
                  <SelectItem value="CITY_BIKE">City Bike</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="surface">Surface Preference</Label>
              <Select
                value={formData.surface || ""}
                onValueChange={(value) =>
                  setFormData({ ...formData, surface: value as any })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="IGNORE">Ignore</SelectItem>
                  <SelectItem value="PREFER_NON_PAVED">Prefer Unpaved</SelectItem>
                  <SelectItem value="AVOID_BAD_SMOOTHNESS_ONLY">
                    Avoid Bad Surfaces
                  </SelectItem>
                  <SelectItem value="PREFER_SMOOTH">Prefer Smooth</SelectItem>
                  <SelectItem value="AVOID_NON_SMOOTH">Avoid Unpaved</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="traffic">Traffic Avoidance</Label>
              <Select
                value={formData.traffic || ""}
                onValueChange={(value) =>
                  setFormData({ ...formData, traffic: value as any })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="IGNORE">Ignore</SelectItem>
                  <SelectItem value="AVOID_IF_REASONABLE">
                    Avoid if Reasonable
                  </SelectItem>
                  <SelectItem value="AVOID_IF_POSSIBLE">
                    Avoid if Possible
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="climbs">Climb Avoidance</Label>
              <Select
                value={formData.climbs || ""}
                onValueChange={(value) =>
                  setFormData({ ...formData, climbs: value as any })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="IGNORE">Ignore</SelectItem>
                  <SelectItem value="AVOID_IF_REASONABLE">
                    Avoid if Reasonable
                  </SelectItem>
                  <SelectItem value="AVOID_IF_POSSIBLE">
                    Avoid if Possible
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 pt-4 border-t">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="avoid-stairs"
                checked={formData.stairs === "STRICTLY_AVOID"}
                onCheckedChange={(checked) =>
                  setFormData({
                    ...formData,
                    stairs: checked ? "STRICTLY_AVOID" : "AVOID_IF_POSSIBLE",
                  })
                }
              />
              <Label htmlFor="avoid-stairs">Avoid Stairs</Label>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="avoid-pavements"
                checked={formData.pavements === "STRICTLY_AVOID"}
                onCheckedChange={(checked) =>
                  setFormData({
                    ...formData,
                    pavements: checked ? "STRICTLY_AVOID" : "AVOID_IF_POSSIBLE",
                  })
                }
              />
              <Label htmlFor="avoid-pavements">Avoid Pavements</Label>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="avoid-oneways"
                checked={formData.oneways === "STRICTLY_AVOID"}
                onCheckedChange={(checked) =>
                  setFormData({
                    ...formData,
                    oneways: checked ? "STRICTLY_AVOID" : "AVOID_IF_POSSIBLE",
                  })
                }
              />
              <Label htmlFor="avoid-oneways">Avoid Oneways</Label>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
