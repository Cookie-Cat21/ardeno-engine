/**
 * Run this once to register slash commands with Discord.
 * node dist/bot/register.js  OR  ts-node src/bot/register.ts
 */
import { REST, Routes } from 'discord.js'
import { data as findleads } from './commands/findleads'
import dotenv from 'dotenv'
dotenv.config()

const commands = [findleads.toJSON()]

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!)

;(async () => {
  try {
    console.log('Registering slash commands...')
    await rest.put(
      Routes.applicationGuildCommands(
        process.env.DISCORD_CLIENT_ID!,
        process.env.DISCORD_GUILD_ID!
      ),
      { body: commands }
    )
    console.log('✅ Slash commands registered.')
  } catch (e) {
    console.error('Failed to register commands:', e)
  }
})()
