Ibex - gravel bike routing specialist. 


# Description 

An app that display a 100% viewport maplibre instance, with rounded icon-buttons, very accessible

The app is a routing app : the user add waypoints on the map using maplibre markers, numbered marker, dragable.

The user can then click on the process (cogs) button to create routes. Multiple routes are returned, and multiple geojson per route, for sections. Probably better as a flat geojson, with proper attributes, but that the current state of the api. 

Each temporary tracks can be saved in local DB, reloaded or deleted. No limit how how many tracks can be saved. If the app restart, the temporary tracks are not saved, but the saved one can be  added or hidden in the map. A saved track can be reloaded and major way points, e.g. 5 major waypoints can be extracted to create a new 'base' for creating new routes, as markers are dragable, it's a conventiant way to update an existing track, eg. to re.route. The existing route used is never altered.

Marker uses html to match the style classes. Typically, they should be black circle with clear text. As already said, marker are drag-n-droppable.  
 
# MCP 

playwright


# tech stack
- git (init for a js/ts web app) 
- maplibre 5+
- shadcn/ui 
- tailwind 4+ 
- vite / vitest 
- npm 

# UI 

- mobile first
- dark mode - use provided template : 


```css

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 0 0% 3.9%;
    --card: 0 0% 100%;
    --card-foreground: 0 0% 3.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 0 0% 3.9%;
    --primary: 0 0% 9%;
    --primary-foreground: 0 0% 98%;
    --secondary: 0 0% 96.1%;
    --secondary-foreground: 0 0% 9%;
    --muted: 0 0% 96.1%;
    --muted-foreground: 0 0% 45.1%;
    --accent: 0 0% 96.1%;
    --accent-foreground: 0 0% 9%;
    --destructive: 0 84.2% 60.2%;
    --destructive-foreground: 0 0% 98%;
    --border: 0 0% 89.8%;
    --input: 0 0% 89.8%;
    --ring: 0 0% 3.9%;
    --radius: 0.65rem;
    --chart-1: 12 76% 61%;
    --chart-2: 173 58% 39%;
    --chart-3: 197 37% 24%;
    --chart-4: 43 74% 66%;
    --chart-5: 27 87% 67%;
  }

  .dark {
    --background: 0 0% 3.9%;
    --foreground: 0 0% 98%;
    --card: 0 0% 3.9%;
    --card-foreground: 0 0% 98%;
    --popover: 0 0% 3.9%;
    --popover-foreground: 0 0% 98%;
    --primary: 0 0% 98%;
    --primary-foreground: 0 0% 9%;
    --secondary: 0 0% 14.9%;
    --secondary-foreground: 0 0% 98%;
    --muted: 0 0% 14.9%;
    --muted-foreground: 0 0% 63.9%;
    --accent: 0 0% 14.9%;
    --accent-foreground: 0 0% 98%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 0 0% 98%;
    --border: 0 0% 14.9%;
    --input: 0 0% 14.9%;
    --ring: 0 0% 83.1%;
    --chart-1: 220 70% 50%;
    --chart-2: 160 60% 45%;
    --chart-3: 30 80% 55%;
    --chart-4: 280 65% 60%;
    --chart-5: 340 75% 55%;
  }
}
```


 

API demo, keep the referer ( prototype )


```js
fetch("https://uc1.umotional.net/urbancyclers-api/v7/routing?key=ZK7hRQamGXpAeQDfRiCveVyBjdtGp7JU", {
  "headers": {
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-GB,en;q=0.8",
    "content-type": "application/json; charset=UTF-8",
    "priority": "u=1, i",
    "sec-ch-ua": "\"Not)A;Brand\";v=\"8\", \"Chromium\";v=\"138\", \"Brave\";v=\"138\"",
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"macOS\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "sec-gpc": "1"
  },
  "referrer": "https://demo.cyclers.tech/",
  "body": "{\"client\":\"WEB\",\"origin\":{\"locationType\":\"POINT\",\"point\":{\"lat\":46.19426057363093,\"lon\":6.190828504040838}},\"destination\":{\"locationType\":\"POINT\",\"point\":{\"lat\":45.761582444530546,\"lon\":4.96747787579659}},\"settings\":{\"bikeType\":\"GRAVEL_BIKE\",\"averageSpeed\":20,\"allowedTransportModes\":[\"BIKE\"],\"stairs\":\"AVOID_IF_POSSIBLE\",\"pavements\":\"AVOID_IF_POSSIBLE\",\"oneways\":\"AVOID_IF_POSSIBLE\",\"traffic\":\"AVOID_IF_REASONABLE\",\"surface\":\"PREFER_NON_PAVED\",\"climbs\":\"IGNORE\",\"bikeSharingProvidersIds\":[],\"addRouteGeoJson\":true,\"optimizeWaypointOrder\":false},\"departureDateTime\":\"2025-08-04T09:53:55+02:00\",\"key\":\"ZK7hRQamGXpAeQDfRiCveVyBjdtGp7JU\",\"waypoints\":[],\"uid\":null}",
  "method": "POST",
  "mode": "cors",
  "credentials": "omit"
});
```
Sample response schema in @data/schema.json file ( large file )  



