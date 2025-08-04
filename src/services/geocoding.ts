import * as maptilerClient from '@maptiler/client'

const API_KEY = import.meta.env.VITE_MAPTILER_API_KEY;

if (!API_KEY) {
  throw new Error("VITE_MAPTILER_API_KEY is not set in the environment variables.");
}

maptilerClient.config.apiKey = API_KEY

export const geocoding = maptilerClient.geocoding
