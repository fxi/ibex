import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { PlusCircle, Edit, Trash2 } from "lucide-react";
import { RoutingProfile } from "@/types/profiles";

interface ProfileSelectorProps {
  profiles: RoutingProfile[];
  activeProfile: RoutingProfile | null;
  onSelectProfile: (profileId: string) => void;
  onAddProfile: () => void;
  onEditProfile: (profile: RoutingProfile) => void;
  onDeleteProfile: (profileId: string) => void;
}

export function ProfileSelector({
  profiles,
  activeProfile,
  onSelectProfile,
  onAddProfile,
  onEditProfile,
  onDeleteProfile,
}: ProfileSelectorProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Routing Profile</h3>
        <Button variant="ghost" size="sm" onClick={onAddProfile}>
          <PlusCircle className="h-4 w-4 mr-2" />
          New
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Select
          value={activeProfile?.id || ""}
          onValueChange={onSelectProfile}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select a profile" />
          </SelectTrigger>
          <SelectContent>
            {profiles.map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>
                {profile.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {activeProfile && (
          <>
            <Button
              variant="outline"
              size="icon"
              onClick={() => onEditProfile(activeProfile)}
            >
              <Edit className="h-4 w-4" />
            </Button>
            {activeProfile.isCustom && (
              <Button
                variant="destructive"
                size="icon"
                onClick={() => onDeleteProfile(activeProfile.id)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </>
        )}
      </div>
      {activeProfile && (
        <p className="text-sm text-muted-foreground">
          {activeProfile.description}
        </p>
      )}
    </div>
  );
}
