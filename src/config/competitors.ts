// Known Sri Lankan web design competitors to track
// Add/remove as needed — each one gets scraped weekly

export interface Competitor {
  name: string
  url: string
}

export const COMPETITORS: Competitor[] = [
  { name: 'Dotocean',      url: 'https://dotocean.lk' },
  { name: 'Surge Global',  url: 'https://surgeglobal.io' },
  { name: 'Creotec',       url: 'https://creotec.lk' },
  { name: 'Appco',         url: 'https://appco.lk' },
  { name: 'Webbeez',       url: 'https://webbeez.lk' },
  { name: 'Studioq',       url: 'https://studioq.co' },
]

// Ardeno's own positioning — used in comparison prompt
export const ARDENO_POSITIONING = `
Ardeno Studio is a premium web design agency in Sri Lanka founded by Ovindu and Suven.
We focus on local Sri Lankan businesses — restaurants, gyms, hotels, salons, dental clinics, law firms, retail.
We offer web design, redesigns, performance optimisation, and SEO.
We are young, fast-moving, and focus on measurable results for our clients.
`
