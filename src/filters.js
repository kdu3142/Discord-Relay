import config from './config.js';

/**
 * Checks if the bot was called in a message
 * @param {import('discord.js').Message} message - The Discord message object
 * @param {import('discord.js').Client} client - The Discord client instance
 * @returns {{ called: boolean, rule: string | null, cleanContent: string }} - Result object
 */
export function isBotCalled(message, client) {
  // Ignore bot messages
  if (message.author.bot) {
    return { called: false, rule: null, cleanContent: message.content };
  }

  const content = message.content.trim();
  const prefix = config.bot.prefix;

  // Check prefix trigger (e.g., "!bot command")
  if (content.startsWith(prefix + ' ') || content === prefix) {
    const cleanContent = content.startsWith(prefix + ' ')
      ? content.slice(prefix.length + 1).trim()
      : '';
    return {
      called: true,
      rule: `prefix:${prefix}`,
      cleanContent,
    };
  }

  // Check mention trigger (bot is mentioned in the message)
  if (message.mentions.has(client.user)) {
    // Remove the mention from content to get clean content
    let cleanContent = content;
    // Replace user mention patterns: <@USER_ID> or <@!USER_ID>
    const mentionPattern = new RegExp(`<@!?${client.user.id}>`, 'g');
    cleanContent = cleanContent.replace(mentionPattern, '').trim();
    
    return {
      called: true,
      rule: 'mention',
      cleanContent,
    };
  }

  return { called: false, rule: null, cleanContent: content };
}

/**
 * Checks if the guild is allowed (if ALLOWED_GUILD_IDS is configured)
 * @param {import('discord.js').Guild | null} guild - The Discord guild object
 * @returns {boolean} - True if guild is allowed or no restriction is set
 */
export function isGuildAllowed(guild) {
  if (!guild) return false; // DMs not supported in this version
  
  const allowedGuildIds = config.bot.allowedGuildIds;
  if (!allowedGuildIds || allowedGuildIds.length === 0) {
    return true; // No restriction
  }

  return allowedGuildIds.includes(guild.id);
}
