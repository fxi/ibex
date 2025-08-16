import { RouteSettings } from './routing';

export interface RoutingProfile extends RouteSettings {
  id: string;
  name: string;
  description?: string;
  isDefault?: boolean;
  isCustom?: boolean;
}
