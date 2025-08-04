import * as maptilerClient from '@maptiler/client'

const API_KEY = "r0T8W9TTH8XCCGoLL9gE" 

maptilerClient.config.apiKey = API_KEY

export const geocoding = maptilerClient.geocoding
