export interface TeamMember {
  name: string
  discordId: string
  whatsapp: string
  email: string
  role: string
}

export const TEAM: Record<string, TeamMember> = {
  '718874427865038849': {
    name: 'Ovindu',
    discordId: '718874427865038849',
    whatsapp: '+94 76 248 5456',
    email: 'ardenostudio@gmail.com',
    role: 'Co-founder, Ardeno Studio'
  },
  '956204933974196315': {
    name: 'Suven',
    discordId: '956204933974196315',
    whatsapp: '+94 75 850 4424',
    email: 'ardenostudio@gmail.com',
    role: 'Co-founder, Ardeno Studio'
  }
}

export function getMember(discordId: string): TeamMember | null {
  return TEAM[discordId] ?? null
}
